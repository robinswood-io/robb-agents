import { getModelShortName } from '@config/models'
import { getDefaultModelsForConnection, type LlmConnectionWithStatus } from '@config/llm-connections'
import { getSelectableConnectionModels } from '../input/model-picker-helpers'
import type { KanbanModelProviderGroup } from './types'

/**
 * Build the subtask composer's provider→model catalog from the workspace's
 * authenticated LLM connections, plus a model-id → connection-slug map so a
 * spawned subtask routes to the connection that actually serves the model.
 * Model-id collisions across connections are last-wins (acceptable for v1).
 */
export function buildModelCatalog(connections: LlmConnectionWithStatus[]): {
  groups: KanbanModelProviderGroup[]
  modelToConnection: Map<string, string>
} {
  const groups: KanbanModelProviderGroup[] = []
  const modelToConnection = new Map<string, string>()

  for (const conn of connections) {
    if (!conn.isAuthenticated) continue
    const rawModels = getSelectableConnectionModels(
      { ...conn, models: conn.models?.length ? conn.models : undefined },
      getDefaultModelsForConnection(conn.providerType, conn.piAuthProvider),
    )
    const models = rawModels.map(m => {
      const id = typeof m === 'string' ? m : m.id
      const name = typeof m === 'string' ? getModelShortName(m) : m.name || getModelShortName(m.id)
      return { id, name }
    })
    if (models.length === 0) continue
    for (const m of models) modelToConnection.set(m.id, conn.slug)
    // Provider key drives the brand icon: 'anthropic' resolves directly; Pi
    // connections resolve through their piAuthProvider (see resolveProviderIcon in TaskTile).
    const provider = conn.providerType === 'anthropic' ? 'anthropic' : conn.piAuthProvider || conn.providerType
    groups.push({ provider, label: conn.name, models })
  }

  return { groups, modelToConnection }
}

