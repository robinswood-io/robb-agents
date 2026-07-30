import { describe, expect, it } from 'bun:test'
import { RemotePairingManager, formatPairingCode } from '../remote-pairing'

function deterministicRandom(size: number): Uint8Array {
  return Uint8Array.from({ length: size }, (_, index) => index + 1)
}

describe('RemotePairingManager', () => {
  it('issues an expiring one-time ticket without retaining the raw secret', () => {
    const manager = new RemotePairingManager({
      now: () => 1_000,
      ttlMs: 60_000,
      random: deterministicRandom,
    })

    const pairing = manager.issue()

    expect(pairing.ticket.length).toBeGreaterThan(32)
    expect(pairing.code).toMatch(/^[A-Z2-9]{8}$/)
    expect(pairing.expiresAt).toBe(new Date(61_000).toISOString())
    expect(manager.consume({ ticket: pairing.ticket })).toEqual({ ok: true })
    expect(manager.consume({ ticket: pairing.ticket })).toEqual({ ok: false, reason: 'used' })
  })

  it('accepts a normalized manual code and no longer accepts an expired ticket', () => {
    let now = 5_000
    const manager = new RemotePairingManager({
      now: () => now,
      ttlMs: 500,
      random: deterministicRandom,
    })
    const pairing = manager.issue()

    expect(manager.consume({ code: formatPairingCode(pairing.code).toLowerCase() })).toEqual({ ok: true })

    const expired = manager.issue()
    now = 5_501
    expect(manager.consume({ ticket: expired.ticket })).toEqual({ ok: false, reason: 'invalid' })
  })

  it('invalidates the previous ticket when a new pairing starts', () => {
    let seed = 0
    const manager = new RemotePairingManager({
      random: (size) => Uint8Array.from({ length: size }, (_, index) => index + ++seed),
    })
    const first = manager.issue()
    const second = manager.issue()

    expect(manager.consume({ ticket: first.ticket })).toEqual({ ok: false, reason: 'invalid' })
    expect(manager.consume({ ticket: second.ticket })).toEqual({ ok: true })
  })
})
