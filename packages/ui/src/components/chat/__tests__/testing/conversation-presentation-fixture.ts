import type { Message } from "@craft-agent/core";
import type { ActiveSessionObjective } from "@craft-agent/shared/sessions";
import { projectConversation } from "../../conversation-presentation";



type MessageOverrides = Omit<Partial<Message>, 'toolResult' | 'toolExecuted'> & {
  toolResult?: string | undefined
  toolExecuted?: boolean | undefined
}

export function message(id: string, role: Message['role'], extra: MessageOverrides = {}): Message {
  const result: Message = { id, role, content: id, timestamp: Number(id.replace(/\D/g, '')) || 1 }
  const entries: Array<[string, unknown]> = Object.entries(extra)
  for (const [key, value] of entries) {
    if (value === undefined) Reflect.deleteProperty(result, key)
    else Reflect.set(result, key, value)
  }
  return result
}


export function objective(extra: Partial<ActiveSessionObjective> = {}): ActiveSessionObjective {
  return {
    schemaVersion: 1, userMessageId: 'u1', objectiveId: 'u1', lastUserMessageId: 'u1',
    originalText: 'Préparer et vérifier le rapport.', startedAt: 1,
    budgetBaselineUsd: 0, tokenBaseline: 0, continuationCount: 0,
    orchestrationMode: 'mission', risk: 'standard', terminalState: 'active', completionCriteria: [],
    ...extra,
  }
}


export function plan(id: string, toolName = 'TodoWrite', extra: MessageOverrides = {}): Message {
  const rows = [
    { content: 'Préparer le rapport', status: 'completed' },
    { content: 'Vérifier le rendu', status: 'in_progress', activeForm: 'Vérification du rendu' },
    { content: 'Livrer le rapport', status: 'pending' },
  ]
  return message(id, 'tool', {
    toolName, toolStatus: 'completed', toolExecuted: true, toolResult: 'Plan updated',
    toolInput: toolName.includes('update_plan') ? { plan: rows.map(row => ({ step: row.content, status: row.status })) } : { todos: rows },
    ...extra,
  })
}


export const user = message('u1', 'user', { content: 'Préparer et vérifier le rapport.' })

export const finals = (turns: ReturnType<typeof projectConversation>['turns']) => turns.flatMap(turn =>
  turn.type === 'assistant' && turn.response ? [turn.response.text] : [])
