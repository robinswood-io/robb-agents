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
    expect(sdkModels.some(model => model.id === 'gpt-5.4')).toBe(true)
    const result = await providerModelsHandler()(context, 'openai-codex')
    const rejected = ['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex-spark']
      .filter(id => sdkModels.some(model => model.id === id))
    const returnedIds = result.models.map((model: { id: string }) => model.id)
    for (const id of rejected) expect(returnedIds).not.toContain(`pi/${id}`)
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
    expect(result.totalCount).toBe(sdkModels.length)
  })
})
