import { describe, expect, it } from "bun:test";
import type { Session } from "../../../shared/types";
import { extractSessionMeta } from "../sessions";
import { makeSession, msg } from "./testing/sessions-fixture.ts";

describe('session metadata projection', () => {
  it('uses terminal objective truth instead of stale lifecycle status', () => {
    const verified = extractSessionMeta(makeSession({
      sessionStatus: 'needs-review',
      activeObjective: { terminalState: 'complete_verified' } as NonNullable<Session['activeObjective']>,
    }))
    const exhausted = extractSessionMeta(makeSession({
      sessionStatus: 'in-progress',
      activeObjective: { terminalState: 'exhausted' } as NonNullable<Session['activeObjective']>,
    }))

    expect(verified.sessionStatus).toBe('done')
    expect(exhausted.sessionStatus).toBe('needs-review')
  })

  it('retains host delegation lineage for fail-closed child visibility', () => {
    const delegation = {
      rootSessionId: 'root', rootObjectiveId: 'objective', parentObjectiveId: 'objective',
      depth: 1, role: 'worker' as const,
    }
    expect(extractSessionMeta(makeSession({ delegation })).delegation).toEqual(delegation)
  })

  it('projects pending authentication into lightweight child activity metadata', () => {
    const pendingAuthRequestMessage = msg('auth-request')
    expect(extractSessionMeta(makeSession({ pendingAuthRequestMessage })).hasPendingAuth).toBe(true)
    expect(extractSessionMeta(makeSession()).hasPendingAuth).toBe(false)
  })
});
