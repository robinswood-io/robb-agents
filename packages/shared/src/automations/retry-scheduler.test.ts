import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AUTOMATIONS_DEAD_LETTER_FILE, AUTOMATIONS_RETRY_QUEUE_FILE } from './constants.ts';
import { listDeadLetters, replayDeadLetter, type DeadLetterEntry } from './retry-scheduler.ts';

describe('automation dead letters', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'robb-dead-letter-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('requires approval and requeues a secret-reference-only action', async () => {
    const entry: DeadLetterEntry = {
      id: 'entry-1',
      matcherId: 'matcher-1',
      action: {
        type: 'webhook',
        url: 'https://api.example.com/hook',
        auth: { type: 'bearer', token: '${CRAFT_WH_API_TOKEN}' },
      },
      redactedUrl: 'https://api.example.com/hook',
      deferredAttempt: 3,
      nextRetryAt: 0,
      createdAt: 1,
      lastError: 'timeout',
      deadLetteredAt: 2,
      finalError: 'timeout',
    };
    writeFileSync(join(root, AUTOMATIONS_DEAD_LETTER_FILE), `${JSON.stringify(entry)}\n`, 'utf8');

    await expect(replayDeadLetter(root, entry.id, {
      approved: false,
      approvedBy: 'operator',
      approvedAt: Date.now(),
    })).rejects.toThrow('requires explicit approval');

    await replayDeadLetter(root, entry.id, {
      approved: true,
      approvedBy: 'operator',
      approvedAt: Date.now(),
    });

    expect(await listDeadLetters(root)).toEqual([]);
    const queue = readFileSync(join(root, AUTOMATIONS_RETRY_QUEUE_FILE), 'utf8');
    expect(queue).toContain('${CRAFT_WH_API_TOKEN}');
    expect(queue).not.toContain('super-secret-value');
  });
});
