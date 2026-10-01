import { describe, expect, it } from 'bun:test'
import {
  buildExtractiveTransferSummary,
  selectTransferSummaryMessages,
} from './transfer-summary-context'

describe('selectTransferSummaryMessages', () => {
  it('keeps the first objective and the latest exchanges inside the cap', () => {
    const messages = [
      { type: 'user' as const, content: 'objectif initial' },
      ...Array.from({ length: 20 }, (_, index) => ({
        type: (index % 2 === 0 ? 'assistant' : 'user') as 'assistant' | 'user',
        content: `message-${index}-` + 'x'.repeat(100),
      })),
    ]

    const selected = selectTransferSummaryMessages(messages, 500)
    const totalChars = selected.reduce((sum, message) => sum + message.content.length, 0)

    expect(selected[0]?.content).toBe('objectif initial')
    expect(selected.at(-1)?.content).toContain('message-19-')
    expect(totalChars).toBeLessThanOrEqual(500)
    expect(selected.length).toBeLessThan(messages.length)
  })

  it('bounds a single giant message while retaining its head and tail', () => {
    const selected = selectTransferSummaryMessages([
      { type: 'user', content: `HEAD-${'x'.repeat(20_000)}-TAIL` },
    ], 1_000)

    expect(selected).toHaveLength(1)
    expect(selected[0]!.content.length).toBeLessThanOrEqual(1_000)
    expect(selected[0]!.content).toStartWith('HEAD-')
    expect(selected[0]!.content).toEndWith('-TAIL')
  })
})

describe('buildExtractiveTransferSummary', () => {
  it('creates a bounded fail-closed local continuation summary', () => {
    const summary = buildExtractiveTransferSummary([
      { type: 'user', content: 'Réconcilier la comptabilité' },
      { type: 'assistant', content: 'Le lot A est vérifié.' },
    ], 1_000)

    expect(summary).toContain('Résumé extractif local')
    expect(summary).toContain('Vérifier l’état réel')
    expect(summary).toContain('Réconcilier la comptabilité')
    expect(summary).toContain('Le lot A est vérifié.')
  })
})
