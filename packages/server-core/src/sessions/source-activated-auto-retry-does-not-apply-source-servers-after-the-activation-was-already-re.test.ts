import { describe, expect, it } from "bun:test";
import { commitRevocableSourceActivationRuntime } from "./SessionManager.ts";

describe('revocable source runtime commit', () => {
  it('does not apply source servers after the activation was already revoked', async () => {
    let serverCalls = 0
    let restoreCalls = 0
    let quarantines = 0
    const result = await commitRevocableSourceActivationRuntime({
      isCurrent: () => false,
      applyServers: async () => { serverCalls += 1 },
      restorePrevious: async () => { restoreCalls += 1 },
      quarantine: async () => { quarantines += 1 },
    })
    expect(result).toBe('superseded')
    expect({ serverCalls, restoreCalls, quarantines }).toEqual({
      serverCalls: 0, restoreCalls: 0, quarantines: 0,
    })
  })

  it('restores the prior source servers when a steer lands during server application', async () => {
    let current = true
    let runtime = 'previous'
    let releaseServers!: () => void
    const serversBlocked = new Promise<void>(resolve => { releaseServers = resolve })
    const stages: string[] = []
    const commit = commitRevocableSourceActivationRuntime({
      isCurrent: () => current,
      applyServers: async () => {
        runtime = 'candidate-servers'
        await serversBlocked
      },
      restorePrevious: async stage => {
        stages.push(stage)
        runtime = 'previous'
      },
      quarantine: async () => { runtime = 'quarantined' },
    })

    await Promise.resolve()
    await Promise.resolve()
    expect(runtime).toBe('candidate-servers')
    current = false
    releaseServers()
    expect(await commit).toBe('superseded')
    expect(runtime).toBe('previous')
    expect(stages).toEqual(['servers-superseded'])
  })

  it('quarantines a candidate runtime when restoring its prior state fails', async () => {
    let current = true
    let runtime = 'previous'
    let quarantines = 0
    const commit = commitRevocableSourceActivationRuntime({
      isCurrent: () => current,
      applyServers: async () => {
        runtime = 'candidate-servers'
        current = false
      },
      restorePrevious: async () => {
        throw new Error('rollback transport unavailable')
      },
      quarantine: async () => {
        quarantines += 1
        runtime = 'quarantined'
      },
    })

    expect(await commit).toBe('quarantined')
    expect(runtime).toBe('quarantined')
    expect(quarantines).toBe(1)
  })
});
