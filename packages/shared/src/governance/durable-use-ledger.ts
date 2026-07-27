import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname } from 'node:path'
import { z } from 'zod'

const DurableUseEventUnsignedSchema = z.object({
  schemaVersion: z.literal(1),
  sequence: z.number().int().positive(),
  useId: z.string().trim().min(1),
  consumedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  previousHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
}).strict()

const DurableUseEventSchema = DurableUseEventUnsignedSchema.extend({
  hash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()

type DurableUseEventUnsigned = z.infer<typeof DurableUseEventUnsignedSchema>
export type DurableUseEvent = z.infer<typeof DurableUseEventSchema>

function hashEvent(event: DurableUseEventUnsigned): string {
  return createHash('sha256').update(JSON.stringify(event), 'utf8').digest('hex')
}

/**
 * Cross-process one-time-use ledger for short-lived signed capabilities.
 * The journal is metadata-only and fails closed if its hash chain is damaged.
 */
export class DurableUseLedger {
  constructor(
    private readonly journalPath: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  claim(useIdValue: string, expiresAtValue: string): boolean {
    const useId = z.string().trim().min(1).parse(useIdValue)
    const expiresAt = z.string().datetime().parse(expiresAtValue)
    mkdirSync(dirname(this.journalPath), { recursive: true, mode: 0o700 })
    const lockPath = `${this.journalPath}.lock`
    let lockDescriptor: number | undefined
    try {
      lockDescriptor = openSync(lockPath, 'wx', 0o600)
      writeSync(lockDescriptor, `${process.pid}\n`, undefined, 'utf8')
      fsyncSync(lockDescriptor)
      const events = this.readAndVerify()
      if (events.some((event) => event.useId === useId)) return false
      const unsigned = DurableUseEventUnsignedSchema.parse({
        schemaVersion: 1,
        sequence: events.length + 1,
        useId,
        consumedAt: this.now().toISOString(),
        expiresAt,
        previousHash: events.at(-1)?.hash ?? null,
      })
      const event: DurableUseEvent = { ...unsigned, hash: hashEvent(unsigned) }
      appendFileSync(this.journalPath, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 })
      const journalDescriptor = openSync(this.journalPath, 'r')
      try {
        fsyncSync(journalDescriptor)
      } finally {
        closeSync(journalDescriptor)
      }
      return true
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
        throw new Error('Capability use ledger is busy in another process')
      }
      throw error
    } finally {
      if (lockDescriptor !== undefined) {
        closeSync(lockDescriptor)
        try { unlinkSync(lockPath) } catch { /* lock already absent */ }
      }
    }
  }

  list(): DurableUseEvent[] {
    return this.readAndVerify().map((event) => ({ ...event }))
  }

  private readAndVerify(): DurableUseEvent[] {
    if (!existsSync(this.journalPath)) return []
    const lines = readFileSync(this.journalPath, 'utf8').split('\n').filter((line) => line.trim() !== '')
    const events: DurableUseEvent[] = []
    for (const [index, line] of lines.entries()) {
      let value: unknown
      try {
        value = JSON.parse(line)
      } catch {
        throw new Error(`Capability use ledger contains invalid JSON at line ${index + 1}`)
      }
      const event = DurableUseEventSchema.parse(value)
      const { hash, ...unsigned } = event
      if (
        event.sequence !== index + 1
        || event.previousHash !== (events.at(-1)?.hash ?? null)
        || hashEvent(unsigned) !== hash
      ) {
        throw new Error(`Capability use ledger chain is invalid at sequence ${event.sequence}`)
      }
      events.push(event)
    }
    return events
  }
}
