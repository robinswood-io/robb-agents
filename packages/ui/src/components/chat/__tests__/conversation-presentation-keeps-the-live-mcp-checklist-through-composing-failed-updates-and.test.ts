import { expect, it } from "bun:test";
import { projectConversation } from "../conversation-presentation";
import { message, plan, user } from "./testing/conversation-presentation-fixture.ts";

it('keeps the live MCP checklist through composing, failed updates and transcript reload', () => {
  const messages = [user, plan('t2', 'mcp__session__update_plan'),
    message('s3', 'status', { content: 'Le modèle élabore la réponse' })]
  const first = projectConversation(messages, { isProcessing: true })
  expect(first.progress?.steps.map(step => step.status)).toEqual(['completed', 'in_progress', 'pending'])
  expect(first.progress?.activity?.title).toBe('Vérifier le rendu')
  const next = plan('t4', 'mcp__session__update_plan', { toolInput: { plan: [
    { step: 'Préparer le rapport', status: 'completed' },
    { step: 'Vérifier le rendu', status: 'completed' },
    { step: 'Livrer le rapport', status: 'in_progress' },
  ], explanation: 'Le rendu est vérifié. Je prépare la livraison.' } })
  messages.push(next, plan('t5', 'mcp__session__update_plan', { isError: true, toolInput: { plan: [] } }))
  const serialized: unknown = JSON.parse(JSON.stringify(messages)) as typeof messages
  const reloaded = projectConversation(serialized as typeof messages, { isProcessing: true })
  expect(reloaded.progress?.steps.map(step => step.status)).toEqual(['completed', 'completed', 'in_progress'])
  expect(reloaded.progress?.activity?.title).toBe('Le rendu est vérifié. Je prépare la livraison.')
  expect(reloaded.outcome).toBeUndefined()
})
