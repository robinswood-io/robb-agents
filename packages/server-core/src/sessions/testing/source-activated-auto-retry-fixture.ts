import { type AutoRetryPendingHost } from "../SessionManager.ts";



// Regression test for craft-agents-oss#804.
//
// Before: the "[<slug> activated]" auto-retry only lived in the Electron renderer's
// event processor. Headless deployments (WebUI, docker server) stalled after a
// mid-turn source activation because nothing re-sent the original message.
//
// After: SessionManager.processEvent schedules a server-side resend on
// `source_activated`. To survive a mixed-version rollout where a v0.9.5 Electron
// client still ships the legacy renderer-side auto_retry, sendMessage rejects
// the text-only duplicate and accepts only the server timer's private capability.

export type SourceActivatedEvent = {
  type: 'source_activated'
  sourceSlug: string
  originalMessage: string
}


export function makePending(
  overrides: Partial<NonNullable<AutoRetryPendingHost['autoRetryPending']>> = {},
): NonNullable<AutoRetryPendingHost['autoRetryPending']> {
  return {
    content: 'do it\n\n[github activated]',
    rawMessage: 'do it',
    deadlineMs: 2_000,
    tombstoneExpiresAt: 30_000,
    objectiveId: 'objective-a',
    objectiveRevision: 'revision-a',
    sourceSlug: 'github',
    sourceActivationId: 'activation-a',
    generation: 0,
    cancellationEpoch: 0,
    messageCountAtSchedule: 0,
    dispatchToken: Symbol('source activation'),
    dispatchInFlight: false,
    dispatchAttempts: 0,
    committed: false,
    cancelled: false,
    ...overrides,
  }
}
