import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createBashToolDefinition } from '@earendil-works/pi-coding-agent';
import { PiEventAdapter } from '../backend/pi/event-adapter.ts';

/** Real SDK subprocess + JSONL event boundary, without a provider or network. */
describe('Pi Bash authoritative final output', () => {
  let cwd: string;
  beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), 'pi-output-receipt-')); });
  afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });

  it.each([
    ["printf '200|'; sleep 0.2; printf '200'", '200|200'],
    ["printf '308|same-route\\n'; sleep 0.2; printf '308|same-route\\n'", '308|same-route\n308|same-route\n'],
  ])('preserves real SDK output for %s', async (command, expected) => {
    const adapter = new PiEventAdapter();
    adapter.startTurn();
    const transport = (event: unknown) => [...adapter.adaptEvent(JSON.parse(JSON.stringify(event)))];
    transport({ type: 'tool_execution_start', toolCallId: 'live-local', toolName: 'bash', args: { command } });
    const snapshots: string[] = [];
    const result = await createBashToolDefinition(cwd).execute('live-local', { command },
      new AbortController().signal, partialResult => {
        snapshots.push(partialResult.content.filter(part => part.type === 'text').map(part => part.text).join(''));
        transport({ type: 'tool_execution_update', toolCallId: 'live-local', partialResult });
      }, undefined as never);
    const rawFinal = result.content.filter(part => part.type === 'text').map(part => part.text).join('');
    expect(snapshots.filter(Boolean).length).toBeGreaterThanOrEqual(2);
    expect(snapshots.at(-1)).toBe(expected);
    expect(rawFinal).toBe(expected);
    const events = transport({ type: 'tool_execution_end', toolCallId: 'live-local', result, isError: false });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'tool_result', toolUseId: 'live-local', result: expected, isError: false });
  });
});
