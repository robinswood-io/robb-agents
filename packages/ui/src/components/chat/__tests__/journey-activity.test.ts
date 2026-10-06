import { describe, expect, it } from 'bun:test'
import type { Message } from '@craft-agent/core'
import { describeJourneyActivity, safeActivityText } from '../journey-activity'
import type { TodoItem } from '../TurnCard'

function message(id: string, role: Message['role'], extra: Partial<Message> = {}): Message {
  return { id, role, content: '', timestamp: Number(id.slice(1)), ...extra }
}

describe('observed journey activity', () => {
  it('shows the confirmed active step and live tool intent with a factual step count', () => {
    const steps: TodoItem[] = [
      { content: 'Rassembler les factures', status: 'completed' },
      { content: 'Vérifier les totaux', activeForm: 'Vérification des totaux du rapport', status: 'in_progress' },
      { content: 'Livrer le rapport', status: 'pending' },
    ]
    const messages = [message('u1', 'user'),
      message('a2', 'assistant', { isIntermediate: true, content: 'Les factures sont rassemblées.' }),
      message('t3', 'tool', { toolName: 'Bash', toolStatus: 'executing', toolIntent: 'Comparer les montants de septembre', toolInput: { command: 'SECRET_COMMAND' } }),
    ]
    const before = JSON.stringify({ messages, steps })
    expect(describeJourneyActivity(messages, steps)).toEqual({
      title: 'Les factures sont rassemblées.', detail: 'Comparer les montants de septembre',
      source: 'commentary', completedSteps: 1, totalSteps: 3, observedAt: 3,
    })
    expect(JSON.stringify({ messages, steps })).toBe(before)
  })

  it('uses the latest relevant commentary without exposing hidden coordination or nested agent messages', () => {
    const activity = describeJourneyActivity([
      message('u1', 'user'),
      message('a2', 'assistant', { isIntermediate: true, content: 'Je rapproche les factures avec les règlements reçus.' }),
      message('a3', 'assistant', { isIntermediate: true, content: 'Je continue.' }),
      message('a4', 'assistant', { isIntermediate: true, hidden: true, content: 'Private recovery payload' }),
      message('a5', 'assistant', { isIntermediate: true, parentToolUseId: 'child', content: 'Nested private payload' }),
      message('a6', 'assistant', { isIntermediate: true, internalOrigin: { kind: 'agent-message', senderSessionId: 'other' }, content: 'Internal payload' }),
    ], [])
    expect(activity.title).toBe('Je rapproche les factures avec les règlements reçus.')
    expect(activity.totalSteps).toBe(0)
  })

  it('displays declared tool labels but never raw arguments or tool results', () => {
    const activity = describeJourneyActivity([message('t1', 'tool', {
      toolName: 'custom_tool', toolStatus: 'executing', toolDisplayName: 'Lecture des contrats fournisseur',
      toolInput: { description: 'PRIVATE_DESCRIPTION', command: 'PRIVATE_COMMAND' }, toolResult: 'PRIVATE_RESULT',
    })], [])
    expect(activity.title).toBe('Lecture des contrats fournisseur')
    expect(JSON.stringify(activity)).not.toContain('PRIVATE_')
  })

  it('hides commentary about internal dispatch and transport while retaining concrete work updates', () => {
    const activity = describeJourneyActivity([
      message('u1', 'user'),
      message('a2', 'assistant', { isIntermediate: true, content: 'Je vérifie les totaux du rapport de septembre.' }),
      message('a3', 'assistant', { isIntermediate: true, content: 'TECH_COMMENTARY_SENTINEL: dispatching parallel agents and retrying transport.' }),
      message('a4', 'assistant', { isIntermediate: true, content: 'Je relance le transport du fournisseur.' }),
    ], [])
    expect(activity.title).toBe('Je vérifie les totaux du rapport de septembre.')
    expect(describeJourneyActivity([message('a1', 'assistant', {
      isIntermediate: true, content: 'Je vérifie le démarrage des agents dans cette application.',
    })], []).title).toBe('Je vérifie le démarrage des agents dans cette application.')
  })

  it('does not present finished, pending or coordination tools as currently executing', () => {
    for (const status of ['completed', 'pending', 'error', 'backgrounded'] as const) {
      expect(describeJourneyActivity([message('t1', 'tool', {
        toolStatus: status, toolIntent: 'Exporter le rapport',
      })], []).title).toBeUndefined()
    }
    expect(describeJourneyActivity([message('t1', 'tool', {
      toolStatus: 'executing', toolName: 'mcp__session__wait_sessions', toolIntent: 'Waiting on agent IDs',
    })], []).title).toBeUndefined()
  })

  it('does not reuse an earlier response’s activity after a new accepted message or final response', () => {
    for (const boundary of [message('u3', 'user'), message('a3', 'assistant', { content: 'Rapport livré.' })]) {
      expect(describeJourneyActivity([
        message('a1', 'assistant', { isIntermediate: true, content: 'Je construis le premier rapport.' }),
        message('t2', 'tool', { toolStatus: 'executing', toolIntent: 'Ancienne lecture' }), boundary,
      ], []).title).toBeUndefined()
    }
  })

  it('keeps identifiers useful while redacting credential material and signed URL paths', () => {
    const text = safeActivityText('Vérifier `rapport.csv` avec token=secret-value et Bearer secret-auth sur https://user:pass@example.com/private/token?signature=secret-query')!
    expect(text).toContain('rapport.csv')
    expect(text).toContain('example.com')
    for (const secret of ['secret-value', 'secret-auth', 'user:pass', '/private/token', 'secret-query']) {
      expect(text).not.toContain(secret)
    }
    expect(safeActivityText('Clé sk-abcdefghijklmnopqrstuv')).not.toContain('sk-abcdefghijklmnopqrstuv')
  })

  it('does not invent an activity from code, serialized commands, incomplete streaming or empty observations', () => {
    expect(safeActivityText('```sh\ncurl --token secret\n```')).toBeUndefined()
    expect(safeActivityText('{"command":"echo secret"}')).toBeUndefined()
    expect(describeJourneyActivity([message('a1', 'assistant', {
      isIntermediate: true, isStreaming: true, content: 'Reading an incomplete fragment',
    })], [])).toEqual({ completedSteps: 0, totalSteps: 0 })
    expect(describeJourneyActivity([], [])).toEqual({ completedSteps: 0, totalSteps: 0 })
  })
})

it('retains a concrete update when the model starts composing again', () => {
  const activity = describeJourneyActivity([
    message('u1', 'user'),
    message('a2', 'assistant', { isIntermediate: true, content: 'Les montants concordent. Je vérifie le rendu.' }),
    message('s3', 'status', { content: 'Le modèle élabore la réponse' }),
  ], [{ content: 'Vérifier le rendu', status: 'in_progress' }])
  expect(activity.title).toBe('Les montants concordent. Je vérifie le rendu.')
  expect(activity.detail).toBe('Vérifier le rendu')
  expect(activity.source).toBe('commentary')
})

it('displays the explanation of a successful session plan, excluding failed updates', () => {
  const good = message('t2', 'tool', { toolName: 'mcp__session__update_plan', toolStatus: 'completed',
    toolResult: 'Plan updated', toolInput: { explanation: 'Les factures sont rassemblées.' } })
  const failed = message('t3', 'tool', { ...good, id: 't3', timestamp: 3, isError: true,
    toolInput: { explanation: 'Tout est terminé.' } })
  expect(describeJourneyActivity([good, failed], []).title).toBe('Les factures sont rassemblées.')
})
