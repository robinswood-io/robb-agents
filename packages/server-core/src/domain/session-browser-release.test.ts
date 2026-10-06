import { describe, expect, it } from 'bun:test'
import { releaseBrowserOwnershipOnForcedStop } from './session-browser-release'

describe('browser release ownership during plan handoff', () => {
  it('keeps the resumed generation bound when the old visual cleanup finishes later', async () => {
    let generation = 1
    const events: string[] = []
    let release!: () => void
    const pending = new Promise<void>(done => { release = done })
    const releaser = {
      clearVisualsForSession: async () => { events.push('clear'); await pending },
      unbindAllForSession: () => { events.push('unbind') },
    }
    const stopping = releaseBrowserOwnershipOnForcedStop(() => releaser, 'session', () => generation === 1)
    generation = 2
    release()
    await stopping
    expect(events).toEqual(['clear'])
  })

  it('ignores a plan handoff that already lost its session ownership', async () => {
    const events: string[] = []
    await releaseBrowserOwnershipOnForcedStop({
      clearVisualsForSession: async () => { events.push('clear') },
      unbindAllForSession: () => { events.push('unbind') },
    }, 'session', () => false)
    expect(events).toEqual([])
  })

  it('preserves ordinary forced-stop release with and without an ownership guard', async () => {
    for (const ownsRelease of [undefined, () => true]) {
      const events: string[] = []
      await releaseBrowserOwnershipOnForcedStop({
        clearVisualsForSession: async () => { events.push('clear') },
        unbindAllForSession: () => { events.push('unbind') },
      }, 'session', ownsRelease)
      expect(events).toEqual(['clear', 'unbind'])
    }
  })
})
