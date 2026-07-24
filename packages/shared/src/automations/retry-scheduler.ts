/**
 * RetryScheduler - Persistent retry queue for failed webhooks
 *
 * When immediate retries (seconds-scale) are exhausted and a webhook still fails,
 * it's added to a persistent JSONL queue file. The scheduler checks the queue
 * every 60 seconds and retries at increasing intervals:
 *   - 1st deferred: 5 minutes
 *   - 2nd deferred: 30 minutes
 *   - 3rd deferred: 1 hour
 *
 * After all deferred attempts fail, the entry is removed and a final history
 * entry is written. Queue entries survive app restarts.
 */

import { readFile, writeFile, appendFile } from 'fs/promises';
import { join } from 'path';
import { createLogger } from '../utils/debug.ts';
import { executeWebhookRequest, createWebhookHistoryEntry, redactUrl } from './webhook-utils.ts';
import { buildWebhookSecretEnv } from './utils.ts';
import { AUTOMATIONS_DEAD_LETTER_FILE, AUTOMATIONS_RETRY_QUEUE_FILE } from './constants.ts';
import { appendAutomationHistoryEntry } from './history-store.ts';
import type { WebhookAction, WebhookActionResult } from './types.ts';

const log = createLogger('retry-scheduler');

// Deferred retry delays: 5m, 30m, 1h
const DEFERRED_DELAYS_MS = [
  5 * 60_000,    // 5 minutes
  30 * 60_000,   // 30 minutes
  60 * 60_000,   // 1 hour
];

const MAX_DEFERRED_ATTEMPTS = DEFERRED_DELAYS_MS.length;

/** Queue tick interval (how often we check the queue file) */
const TICK_INTERVAL_MS = 60_000; // 1 minute

// ============================================================================
// Queue Entry
// ============================================================================

export interface RetryQueueEntry {
  /** Unique entry ID */
  id: string;
  /** Matcher ID (for history correlation) */
  matcherId: string;
  /** Event values expanded, CRAFT_WH_* secret references deliberately preserved. */
  action: WebhookAction;
  /** Redacted URL only; never persist an expanded webhook URL. */
  redactedUrl: string;
  /** Number of deferred attempts already made (0 = first deferred pending) */
  deferredAttempt: number;
  /** Timestamp when the next retry should happen */
  nextRetryAt: number;
  /** Timestamp when this entry was created */
  createdAt: number;
  /** Last error message */
  lastError?: string;
}

export interface DeadLetterEntry extends RetryQueueEntry {
  deadLetteredAt: number;
  finalError: string;
}

export interface DeadLetterReplayApproval {
  approved: boolean;
  approvedBy: string;
  approvedAt: number;
}

// ============================================================================
// RetryScheduler
// ============================================================================

export interface RetrySchedulerOptions {
  workspaceRootPath: string;
}

export class RetryScheduler {
  private readonly workspaceRootPath: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  private processing = false;

  constructor(options: RetrySchedulerOptions) {
    this.workspaceRootPath = options.workspaceRootPath;
  }

  /**
   * Start the scheduler. Checks queue every minute.
   */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), TICK_INTERVAL_MS);
    log.debug('[RetryScheduler] Started');
    // Run an initial tick after a short delay (don't block startup)
    setTimeout(() => this.tick(), 5_000);
  }

  /**
   * Stop the scheduler and clean up.
   */
  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    log.debug('[RetryScheduler] Disposed');
  }

  /**
   * Enqueue a failed webhook for deferred retry.
   * Called by WebhookHandler when immediate retries are exhausted.
   */
  async enqueue(
    matcherId: string,
    action: WebhookAction,
    redactedUrl: string,
    lastError?: string,
  ): Promise<void> {
    const entry: RetryQueueEntry = {
      id: `${matcherId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      matcherId,
      action,
      redactedUrl: redactUrl(redactedUrl),
      deferredAttempt: 0,
      nextRetryAt: Date.now() + DEFERRED_DELAYS_MS[0]!,
      createdAt: Date.now(),
      lastError,
    };

    const queuePath = join(this.workspaceRootPath, AUTOMATIONS_RETRY_QUEUE_FILE);
    await appendFile(queuePath, JSON.stringify(entry) + '\n', 'utf-8');
    log.debug(`[RetryScheduler] Enqueued ${entry.id} — next retry in ${DEFERRED_DELAYS_MS[0]! / 60_000}m`);
  }

  /**
   * Process the queue: read entries, retry those that are due, rewrite the queue.
   */
  private async tick(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    try {
      const queuePath = join(this.workspaceRootPath, AUTOMATIONS_RETRY_QUEUE_FILE);

      // Read queue
      let raw: string;
      try {
        raw = await readFile(queuePath, 'utf-8');
      } catch {
        // No queue file — nothing to do
        return;
      }

      const lines = raw.trim().split('\n').filter(Boolean);
      if (lines.length === 0) return;

      const entries: RetryQueueEntry[] = [];
      for (const line of lines) {
        try {
          entries.push(JSON.parse(line) as RetryQueueEntry);
        } catch {
          // Skip malformed lines
        }
      }

      if (entries.length === 0) return;

      const now = Date.now();
      const remaining: RetryQueueEntry[] = [];

      for (const entry of entries) {
        if (entry.nextRetryAt > now) {
          // Not due yet — keep in queue
          remaining.push(entry);
          continue;
        }

        // Attempt retry
        log.debug(`[RetryScheduler] Retrying ${entry.id} (deferred attempt ${entry.deferredAttempt + 1}/${MAX_DEFERRED_ATTEMPTS})`);
        let result: WebhookActionResult;
        try {
          result = await executeWebhookRequest(entry.action, {
            timeoutMs: 30_000,
            env: buildWebhookSecretEnv(),
          });
        } catch (err) {
          result = {
            type: 'webhook',
            url: entry.redactedUrl,
            statusCode: 0,
            success: false,
            error: err instanceof Error ? err.message : 'Unknown error',
          };
        }

        if (result.success) {
          // Success — write history entry and drop from queue
          log.debug(`[RetryScheduler] ${entry.id} succeeded on deferred attempt ${entry.deferredAttempt + 1}`);
          const historyEntry = createWebhookHistoryEntry({
            matcherId: entry.matcherId,
            ok: true,
            method: entry.action.method,
            url: entry.redactedUrl,
            statusCode: result.statusCode,
            durationMs: result.durationMs ?? 0,
            attempts: entry.deferredAttempt + 1,
          });
          try {
            await appendAutomationHistoryEntry(this.workspaceRootPath, historyEntry);
          } catch (e) {
            log.debug(`[RetryScheduler] Failed to write history: ${e}`);
          }
          // Don't add to remaining — drop from queue
        } else if (entry.deferredAttempt + 1 >= MAX_DEFERRED_ATTEMPTS) {
          // Final attempt failed — write permanent failure to history
          log.debug(`[RetryScheduler] ${entry.id} permanently failed after ${MAX_DEFERRED_ATTEMPTS} deferred attempts`);
          const historyEntry = createWebhookHistoryEntry({
            matcherId: entry.matcherId,
            ok: false,
            method: entry.action.method,
            url: entry.redactedUrl,
            statusCode: result.statusCode,
            durationMs: result.durationMs ?? 0,
            attempts: entry.deferredAttempt + 1,
            error: result.error ?? 'Unknown error',
          });
          try {
            await appendAutomationHistoryEntry(this.workspaceRootPath, historyEntry);
          } catch (e) {
            log.debug(`[RetryScheduler] Failed to write history: ${e}`);
          }
          const deadLetter: DeadLetterEntry = {
            ...entry,
            redactedUrl: redactUrl(entry.redactedUrl),
            deadLetteredAt: Date.now(),
            finalError: result.error ?? 'Unknown error',
          };
          await appendFile(
            join(this.workspaceRootPath, AUTOMATIONS_DEAD_LETTER_FILE),
            JSON.stringify(deadLetter) + '\n',
            'utf-8',
          );
          // Don't add to remaining — drop from queue
        } else {
          // Still retryable — schedule next deferred attempt
          const nextDelay = DEFERRED_DELAYS_MS[entry.deferredAttempt + 1]!;
          remaining.push({
            ...entry,
            deferredAttempt: entry.deferredAttempt + 1,
            nextRetryAt: Date.now() + nextDelay,
            lastError: result.error,
          });
          log.debug(`[RetryScheduler] ${entry.id} failed — next retry in ${nextDelay / 60_000}m`);
        }
      }

      // Rewrite queue file with remaining entries
      if (remaining.length === 0) {
        await writeFile(queuePath, '', 'utf-8');
      } else {
        const content = remaining.map(e => JSON.stringify(e)).join('\n') + '\n';
        await writeFile(queuePath, content, 'utf-8');
      }
    } catch (err) {
      log.debug(`[RetryScheduler] Tick error: ${err}`);
    } finally {
      this.processing = false;
    }
  }

}

export async function listDeadLetters(workspaceRootPath: string): Promise<DeadLetterEntry[]> {
  try {
    const raw = await readFile(join(workspaceRootPath, AUTOMATIONS_DEAD_LETTER_FILE), 'utf-8');
    const entries: DeadLetterEntry[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line) as DeadLetterEntry);
      } catch {
        // Keep other valid entries inspectable if one append was interrupted.
      }
    }
    return entries;
  } catch {
    return [];
  }
}

/**
 * Move one dead letter back to the durable retry queue. Replays are explicit
 * human decisions and therefore require approval metadata.
 */
export async function replayDeadLetter(
  workspaceRootPath: string,
  entryId: string,
  approval: DeadLetterReplayApproval,
): Promise<void> {
  if (!approval.approved || approval.approvedBy.trim() === '' || approval.approvedAt <= 0) {
    throw new Error('Dead-letter replay requires explicit approval metadata');
  }
  const entries = await listDeadLetters(workspaceRootPath);
  const target = entries.find((entry) => entry.id === entryId);
  if (!target) throw new Error(`Dead-letter entry "${entryId}" not found`);

  const replay: RetryQueueEntry = {
    id: target.id,
    matcherId: target.matcherId,
    action: target.action,
    redactedUrl: target.redactedUrl,
    deferredAttempt: 0,
    nextRetryAt: Date.now(),
    createdAt: target.createdAt,
    lastError: `Replay approved by ${approval.approvedBy} at ${new Date(approval.approvedAt).toISOString()}`,
  };
  await appendFile(
    join(workspaceRootPath, AUTOMATIONS_RETRY_QUEUE_FILE),
    JSON.stringify(replay) + '\n',
    'utf-8',
  );
  const remaining = entries.filter((entry) => entry.id !== entryId);
  await writeFile(
    join(workspaceRootPath, AUTOMATIONS_DEAD_LETTER_FILE),
    remaining.length ? remaining.map((entry) => JSON.stringify(entry)).join('\n') + '\n' : '',
    'utf-8',
  );
}
