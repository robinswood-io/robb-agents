import { describe, expect, it } from 'bun:test'
import { getModels } from '@earendil-works/pi-ai/compat'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import type { HandlerFn, RequestContext, RpcServer } from '../../transport'
import type { HandlerDeps } from '../handler-deps'
import { registerLlmConnectionsHandlers } from './llm-connections'

function providerModelsHandler(): HandlerFn {
  const handlers = new Map<string, HandlerFn>()
  const server = { handle: (channel: string, handler: HandlerFn) => handlers.set(channel, handler) } as unknown as RpcServer
  registerLlmConnectionsHandlers(server, {} as HandlerDeps)
  return handlers.get(RPC_CHANNELS.pi.GET_PROVIDER_MODELS)!
}

const context = {} as RequestContext

describe('provider model discovery RPC', () => {
  it('hides every observed ChatGPT-incompatible model with an accurate total', async () => {
    const sdkModels = getModels('openai-codex')
    const result = await providerModelsHandler()(context, 'openai-codex')
    const incompatible = ['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex-spark']
    const rejected = incompatible.filter(id => sdkModels.some(model => model.id === id))
    const returnedIds = result.models.map((model: { id: string }) => model.id)
    for (const id of incompatible) expect(returnedIds).not.toContain(`pi/${id}`)
    expect(result.totalCount).toBe(sdkModels.length - rejected.length)
    expect(result.models).toHaveLength(result.totalCount)
  })

  it('keeps GPT-5.4 and mini available for the direct OpenAI API with unchanged metadata', async () => {
    const sdkModels = getModels('openai')
    const full = sdkModels.find(model => model.id === 'gpt-5.4')!
    const result = await providerModelsHandler()(context, 'openai')
    expect(result.models).toContainEqual({
      id: 'pi/gpt-5.4', name: full.name, costInput: full.cost.input, costOutput: full.cost.output,
      contextWindow: full.contextWindow, reasoning: full.reasoning,
    })
    expect(result.models.map((model: { id: string }) => model.id)).toContain('pi/gpt-5.4-mini')
    // Historical GPT-4 and the stale Codex alias remain intentionally hidden.
    const eligible = sdkModels.filter(model => !model.id.startsWith('gpt-4') && model.id !== 'codex-mini-latest')
    expect(result.totalCount).toBe(eligible.length)
    expect(result.models).toHaveLength(result.totalCount)
    expect(result.models.every((model: { id: string }) => !model.id.startsWith('pi/gpt-4'))).toBe(true)
  })
})
