import { afterEach, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DurableUseLedger } from './durable-use-ledger'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function ledgerPath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'robb-capability-ledger-'))
  temporaryDirectories.push(directory)
  return join(directory, 'uses.jsonl')
}

describe('DurableUseLedger', () => {
  test('claims a capability exactly once across runtime instances', () => {
    const path = ledgerPath()
    const now = () => new Date('2026-07-27T10:00:00.000Z')
    expect(new DurableUseLedger(path, now).claim('capability-1', '2026-07-27T10:01:00.000Z')).toBe(true)
    expect(new DurableUseLedger(path, now).claim('capability-1', '2026-07-27T10:01:00.000Z')).toBe(false)
  })

  test('fails closed when the append-only chain is damaged', () => {
    const path = ledgerPath()
    const ledger = new DurableUseLedger(path, () => new Date('2026-07-27T10:00:00.000Z'))
    expect(ledger.claim('capability-1', '2026-07-27T10:01:00.000Z')).toBe(true)
    appendFileSync(path, '{"forged":true}\n', 'utf8')
    expect(() => ledger.claim('capability-2', '2026-07-27T10:01:00.000Z')).toThrow()
  })
})
