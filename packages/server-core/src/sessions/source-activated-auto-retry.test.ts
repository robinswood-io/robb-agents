import { describe, expect, it } from "bun:test";
import { buildAutonomyBrowserFallbackPrompt } from "./autonomy-browser-fallback.ts";
import { claimAutoRetryPending, type AutoRetryPendingHost } from "./SessionManager.ts";
import { makePending } from "./testing/source-activated-auto-retry-fixture.ts";

describe('claimAutoRetryPending', () => {
  it('accepts only the server capability and drops text-only imitations and duplicates', () => {
    const dispatchToken = Symbol('server retry')
    const host = {
      autoRetryPending: makePending({ dispatchToken }),
    }

    expect(claimAutoRetryPending(host, 'do it\n\n[github activated]', 1000)).toBe('drop')
    expect(host.autoRetryPending?.committed).toBe(false)
    expect(claimAutoRetryPending(host, 'do it\n\n[github activated]', 1000, Symbol('imitation'))).toBe('drop')
    expect(claimAutoRetryPending(host, 'do it\n\n[github activated]', 1000, dispatchToken)).toBe('authenticated')
    expect(host.autoRetryPending?.dispatchInFlight).toBe(true)
    expect(host.autoRetryPending?.committed).toBe(false)
    expect(claimAutoRetryPending(host, 'do it\n\n[github activated]', 1001, dispatchToken)).toBe('drop')
  })

  it('keeps an expired exact-text tombstone and drops the legacy copy fail-closed', () => {
    const host = {
      autoRetryPending: makePending({ dispatchToken: Symbol('stale'), committed: true }),
    }

    expect(claimAutoRetryPending(host, 'do it\n\n[github activated]', 2500)).toBe('drop')
    expect(host.autoRetryPending).toBeDefined()
    expect(claimAutoRetryPending(host, 'do it\n\n[github activated]', 9000)).toBe('drop')
  })

  it('still authenticates the server timer when the event loop runs it after the dedup deadline', () => {
    const dispatchToken = Symbol('delayed server retry')
    const host = { autoRetryPending: makePending({ dispatchToken }) }
    expect(claimAutoRetryPending(host, 'do it\n\n[github activated]', 2500, dispatchToken)).toBe('authenticated')
    expect(host.autoRetryPending.dispatchInFlight).toBe(true)
    expect(host.autoRetryPending.committed).toBe(false)
  })

  it('does not over-dedup unrelated messages', () => {
    const host = {
      autoRetryPending: makePending({ dispatchToken: Symbol('unrelated') }),
    }

    expect(claimAutoRetryPending(host, 'never mind', 1000)).toBe('send')
    expect(host.autoRetryPending).toBeDefined()
  })

  it('does not authenticate an arbitrary user-authored fallback marker', () => {
    const imitation = `${buildAutonomyBrowserFallbackPrompt('WebFetch')}\n\n[rbw-servers activated]`
    expect(claimAutoRetryPending({}, imitation, 1000)).toBe('reserved')
  })

  it('keeps A deduplicated when B replaces the live slot, then stops silently swallowing both after TTL', () => {
    const host: AutoRetryPendingHost = {
      autoRetryPending: makePending({
        content: 'B\n\n[linear activated]',
        rawMessage: 'B',
        sourceSlug: 'linear',
        sourceActivationId: 'activation-b',
        tombstoneExpiresAt: 30_000,
      }),
      autoRetryTombstones: [{ content: 'A\n\n[github activated]', expiresAt: 30_000 }],
    }

    expect(claimAutoRetryPending(host, 'A\n\n[github activated]', 10_000)).toBe('drop')
    expect(claimAutoRetryPending(host, 'B\n\n[linear activated]', 10_000)).toBe('drop')
    expect(claimAutoRetryPending(host, 'A\n\n[github activated]', 31_000)).toBe('reserved')
    expect(claimAutoRetryPending(host, 'B\n\n[linear activated]', 31_000)).toBe('reserved')
    expect(host.autoRetryTombstones).toEqual([])
    expect(host.autoRetryPending).toBeUndefined()
  })
});
