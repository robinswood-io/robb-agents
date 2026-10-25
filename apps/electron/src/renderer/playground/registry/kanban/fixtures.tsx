import type { KanbanModelProviderGroup, KanbanSubtask, SubtaskRunState } from "@/components/app-shell/kanban/types";

export const MODEL_OPTIONS = [
  { label: 'Opus 4.7', value: 'claude-opus-4-7' },
  { label: 'Sonnet 4.6', value: 'claude-sonnet-4-6' },
  { label: 'Haiku 4.5', value: 'claude-haiku-4-5-20251001' },
]

export const STATUS_OPTIONS = [
  { label: 'Todo', value: 'todo' },
  { label: 'In Progress', value: 'in-progress' },
  { label: 'Needs Review', value: 'needs-review' },
  { label: 'Done', value: 'done' },
  { label: 'Cancelled', value: 'cancelled' },
]

export const TREATMENT_OPTIONS = [
  { label: 'Stripe + tint', value: 'stripe-tint' },
  { label: 'Stripe only', value: 'stripe' },
]

/**
 * Provider→model catalog for the "Add subtask" composer. Stands in for the
 * workspace's real LLM connections (which the wiring phase will supply): the
 * point of the demo is that a subtask can be routed to *any* provider's model,
 * not just Anthropic. Provider keys drive the brand icons via `getProviderIcon`.
 */
export const SUBTASK_MODEL_GROUPS: KanbanModelProviderGroup[] = [
  {
    provider: 'anthropic',
    label: 'Anthropic',
    models: [
      { id: 'claude-opus-4-7', name: 'Opus 4.7' },
      { id: 'claude-sonnet-4-6', name: 'Sonnet 4.6' },
      { id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5' },
    ],
  },
  {
    provider: 'openai',
    label: 'OpenAI',
    models: [
      { id: 'openai/gpt-5', name: 'GPT-5' },
      { id: 'openai/gpt-5-mini', name: 'GPT-5 mini' },
    ],
  },
  {
    provider: 'google',
    label: 'Google AI Studio',
    models: [
      { id: 'google/gemini-3-pro', name: 'Gemini 3 Pro' },
      { id: 'google/gemini-3-flash', name: 'Gemini 3 Flash' },
    ],
  },
  {
    provider: 'xai',
    label: 'xAI (Grok)',
    models: [{ id: 'xai/grok-4', name: 'Grok 4' }],
  },
  {
    provider: 'deepseek',
    label: 'DeepSeek',
    models: [{ id: 'deepseek/deepseek-v3.2', name: 'DeepSeek V3.2' }],
  },
  {
    provider: 'mistral',
    label: 'Mistral',
    models: [{ id: 'mistral/mistral-large', name: 'Mistral Large' }],
  },
  {
    provider: 'groq',
    label: 'Groq',
    models: [{ id: 'groq/llama-4-70b', name: 'Llama 4 70B' }],
  },
]

/** Model a freshly-spawned subtask is routed to when the picker isn't touched. */
export const DEFAULT_SUBTASK_MODEL = 'claude-sonnet-4-6'

/** Build a new pending subtask from a typed title + chosen model (the "Add" path; Run dispatches it). */
export function makeSubtask(title: string, idPrefix: string, model: string): KanbanSubtask {
  return { id: `${idPrefix}-new-${Date.now()}`, title, runState: 'pending', model }
}

// ============================================================================
// List ⇄ Board toggle (lives in the All-Sessions header)
// ============================================================================

export type KanbanView = 'board' | 'list'

export const SUBTASK_STATUS_BY_RUN_STATE: Record<SubtaskRunState, string> = {
  done: 'done',
  running: 'in-progress',
  pending: 'todo',
  failed: 'needs-review',
}
