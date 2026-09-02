import { describe, expect, test } from 'bun:test'
import { selectCompactionUtilityModel } from './compaction-model-policy'

const activeModel = { id: 'gpt-5.6-sol', provider: 'openai-codex', contextWindow: 1_048_576 }
const utilityModel = { id: 'gpt-5.4-mini', provider: 'openai-codex', contextWindow: 272_000 }

describe('selectCompactionUtilityModel', () => {
  test('selects a cheaper compatible model with enough context headroom', () => {
    expect(selectCompactionUtilityModel({
      activeModel,
      utilityModel,
      contextTokens: 100_000,
    })).toEqual(utilityModel)
  })

  test('keeps the active model when the utility window is too small', () => {
    expect(selectCompactionUtilityModel({
      activeModel,
      utilityModel,
      contextTokens: 250_000,
    })).toBeUndefined()
  })

  test('keeps the active model when context telemetry is unknown', () => {
    expect(selectCompactionUtilityModel({
      activeModel,
      utilityModel,
      contextTokens: null,
    })).toBeUndefined()
  })

  test('never crosses provider credentials', () => {
    expect(selectCompactionUtilityModel({
      activeModel,
      utilityModel: { ...utilityModel, provider: 'anthropic' },
      contextTokens: 80_000,
    })).toBeUndefined()
  })
})
