import { describe, expect, it } from 'bun:test'
import type { LlmConnectionWithStatus } from '@craft-agent/shared/config/llm-connections'
import { buildModelCatalog } from '../model-catalog'

function connection(slug: string, piAuthProvider: string, models: string[]): LlmConnectionWithStatus {
  return { slug, name: slug, piAuthProvider, models, providerType: 'pi', authType: piAuthProvider === 'openai-codex' ? 'oauth' : 'api_key', createdAt: 0, isAuthenticated: true, isDefault: false }
}

describe('Kanban model routing catalogue', () => {
  it('keeps GPT-5.4 routed to the API and rejects its mini variant from ChatGPT auth', () => {
    const { groups, modelToConnection } = buildModelCatalog([
      connection('api', 'openai', ['pi/gpt-5.4']),
      connection('chatgpt', 'openai-codex', ['pi/gpt-5.4', 'pi/gpt-5.4-mini', 'pi/gpt-5.5']),
    ])
    expect(groups.map(group => [group.label, group.models.map(model => model.id)])).toEqual([
      ['api', ['pi/gpt-5.4']], ['chatgpt', ['pi/gpt-5.5']],
    ])
    expect(modelToConnection.get('pi/gpt-5.4')).toBe('api')
    expect(modelToConnection.has('pi/gpt-5.4-mini')).toBe(false)
  })

  it('omits a ChatGPT connection whose cache contains only incompatible GPT-5.4 variants', () => {
    const { groups, modelToConnection } = buildModelCatalog([
      connection('chatgpt', 'openai-codex', ['gpt-5.4', 'pi/gpt-5.4', 'pi/gpt-5.4-mini']),
    ])
    expect(groups).toEqual([])
    expect(modelToConnection.size).toBe(0)
  })
})
