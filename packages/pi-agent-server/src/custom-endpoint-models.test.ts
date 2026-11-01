import { describe, expect, it } from 'bun:test'
import {
  buildCustomEndpointModelDef,
  inferLocalModelReasoning,
  normalizeCustomEndpointBaseUrl,
  normalizeCustomEndpointModelEntry,
  stripPiPrefix,
} from './custom-endpoint-models.ts'

describe('normalizeCustomEndpointModelEntry', () => {
  it('strips pi/ prefixes from string model IDs', () => {
    expect(stripPiPrefix('pi/my-model')).toBe('my-model')
    expect(normalizeCustomEndpointModelEntry('pi/my-model')).toEqual({ id: 'my-model' })
  })

  it('preserves per-model image support when enabled', () => {
    expect(normalizeCustomEndpointModelEntry({
      id: 'pi/vision-model',
      supportsImages: true,
    })).toEqual({
      id: 'vision-model',
      supportsImages: true,
    })
  })

  it('preserves explicit per-model image support when disabled', () => {
    expect(normalizeCustomEndpointModelEntry({
      id: 'pi/text-only-model',
      supportsImages: false,
    })).toEqual({
      id: 'text-only-model',
      supportsImages: false,
    })
  })

  it('preserves context window and image support together', () => {
    expect(normalizeCustomEndpointModelEntry({
      id: 'pi/vision-model',
      contextWindow: 262_144,
      supportsImages: true,
    })).toEqual({
      id: 'vision-model',
      contextWindow: 262_144,
      supportsImages: true,
    })
  })
})

describe('buildCustomEndpointModelDef', () => {
  it('defaults custom endpoint models to text-only input', () => {
    const model = buildCustomEndpointModelDef('my-model')
    expect(model.input).toEqual(['text'])
  })

  it('enables image input when the connection explicitly opts in', () => {
    const model = buildCustomEndpointModelDef('vision-model', { supportsImages: true })
    expect(model.input).toEqual(['text', 'image'])
  })

  it('lets per-model overrides disable image input even when the connection default is enabled', () => {
    const model = buildCustomEndpointModelDef('text-only-model', { supportsImages: true }, { supportsImages: false })
    expect(model.input).toEqual(['text'])
  })

  it('lets per-model overrides enable image input and custom context window', () => {
    const model = buildCustomEndpointModelDef('vision-model', undefined, { supportsImages: true, contextWindow: 262_144 })
    expect(model.input).toEqual(['text', 'image'])
    expect(model.contextWindow).toBe(262_144)
  })

  it('lets per-model overrides enable reasoning and custom maxTokens for local models', () => {
    const model = buildCustomEndpointModelDef('deepseek-r1-local', undefined, { supportsThinking: true, maxTokens: 32_768 })
    expect(model.reasoning).toBe(true)
    expect(model.maxTokens).toBe(32_768)
  })

  it('auto-infers reasoning capability for known local reasoning families while keeping coder models fast by default', () => {
    expect(inferLocalModelReasoning('qwen3:32b')).toBe(true)
    expect(inferLocalModelReasoning('deepseek-r1:70b')).toBe(true)
    expect(inferLocalModelReasoning('gpt-oss:120b')).toBe(true)
    expect(inferLocalModelReasoning('glm-5:latest')).toBe(true)
    expect(inferLocalModelReasoning('qwen3-coder:30b')).toBe(false)
    expect(buildCustomEndpointModelDef('qwen3:32b').reasoning).toBe(true)
    expect(buildCustomEndpointModelDef('qwen3:32b', undefined, { supportsThinking: false }).reasoning).toBe(false)
  })

  it('sets safe OpenAI-compatible local runtime flags so Ollama, LM Studio, vLLM, and llama.cpp do not fail on proprietary fields', () => {
    const model = buildCustomEndpointModelDef('qwen3-coder')
    expect(model.compat).toEqual({
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      maxTokensField: 'max_tokens',
      supportsStrictMode: false,
      supportsLongCacheRetention: false,
    })
  })

  it('normalizes bare loopback base URLs to /v1 for openai-completions while preserving custom paths and anthropic-messages', () => {
    expect(normalizeCustomEndpointBaseUrl('http://localhost:11434', 'openai-completions')).toBe('http://localhost:11434/v1')
    expect(normalizeCustomEndpointBaseUrl('http://127.0.0.1:1234/', 'openai-completions')).toBe('http://127.0.0.1:1234/v1')
    expect(normalizeCustomEndpointBaseUrl('http://localhost:11434/v1', 'openai-completions')).toBe('http://localhost:11434/v1')
    expect(normalizeCustomEndpointBaseUrl('https://openrouter.ai/api/v1', 'openai-completions')).toBe('https://openrouter.ai/api/v1')
    expect(normalizeCustomEndpointBaseUrl('http://localhost:11434', 'anthropic-messages')).toBe('http://localhost:11434')
  })
})
