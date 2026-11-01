import { isJsonObject, parseJsonObject } from '@craft-agent/shared/utils/json'
import { isParentTaskTool } from "@craft-agent/shared/utils/toolNames";
import type { ActivityItem } from "../TurnCard";

// ============================================================================
// Activity Grouping for Task Subagents
// ============================================================================

/**
 * Data extracted from TaskOutput tool result
 */
export interface TaskOutputData {
  durationMs?: number
  inputTokens?: number
  outputTokens?: number
}

/**
 * Represents a Task tool with its child activities grouped together
 */
export interface ActivityGroup {
  type: 'group'
  parent: ActivityItem
  children: ActivityItem[]
  /** Data from TaskOutput result (duration, tokens) */
  taskOutputData?: TaskOutputData | undefined
}

/**
 * Type guard to check if an item is an ActivityGroup
 */
export function isActivityGroup(item: ActivityItem | ActivityGroup): item is ActivityGroup {
  return 'type' in item && item.type === 'group' && 'parent' in item && 'children' in item
}

/**
 * Extract TaskOutput data from an activity's result content.
 * TaskOutput results are JSON with: result, usage, total_cost_usd, duration_ms
 */
function extractTaskOutputData(activity: ActivityItem): TaskOutputData | undefined {
  if (!activity.content) return undefined

  try {
    const parsed = parseJsonObject(activity.content)
    const data: TaskOutputData = {}

    if (typeof parsed['duration_ms'] === 'number') {
      data.durationMs = parsed['duration_ms']
    }

    const usage = parsed['usage']
    if (isJsonObject(usage)) {
      if (typeof usage['input_tokens'] === 'number') {
        data.inputTokens = usage['input_tokens']
      }
      if (typeof usage['output_tokens'] === 'number') {
        data.outputTokens = usage['output_tokens']
      }
    }

    // Only return if we have some data
    if (data.durationMs !== undefined || data.inputTokens !== undefined || data.outputTokens !== undefined) {
      return data
    }
  } catch {
    // Not valid JSON or missing fields
  }

  return undefined
}

/**
 * Groups activities by their parent Task tool.
 *
 * This transforms a flat chronological list into a grouped structure:
 * - Maintains chronological order of top-level items (orphans and Task groups)
 * - Each Task tool becomes a group containing its child activities
 * - Maintains chronological order within each group
 * - TaskOutput activities are hidden but their data enriches the parent Task
 *
 * @param activities - Flat list of activities sorted by timestamp
 * @returns Mixed array of standalone activities and activity groups
 */
export function groupActivitiesByParent(
  activities: ActivityItem[]
): (ActivityItem | ActivityGroup)[] {
  // First, build a set of valid Task toolUseIds (parents that actually exist)
  const taskToolUseIds = new Set<string>()
  for (const activity of activities) {
    if (isParentTaskTool(activity.toolName ?? '') && activity.toolUseId) {
      taskToolUseIds.add(activity.toolUseId)
    }
  }

  // Build a map of parentId -> children for efficient lookup
  // Only include children whose parent Task actually exists
  const childrenByParent = new Map<string, ActivityItem[]>()
  for (const activity of activities) {
    if (activity.parentId && taskToolUseIds.has(activity.parentId)) {
      const existing = childrenByParent.get(activity.parentId) || []
      existing.push(activity)
      childrenByParent.set(activity.parentId, existing)
    }
  }

  // Build set of child activity IDs to skip (they're included in their parent's group)
  // Activities with parentId pointing to non-existent parents are NOT added here,
  // so they'll appear as orphan activities at root level instead of being dropped
  const childIds = new Set<string>()
  for (const children of childrenByParent.values()) {
    for (const child of children) {
      childIds.add(child.id)
    }
  }

  // Build a map of task_id (agent ID) -> TaskOutput data
  // TaskOutput.toolInput.task_id contains the agent ID returned when Task runs in background
  const taskOutputByAgentId = new Map<string, TaskOutputData>()
  for (const activity of activities) {
    if (activity.toolName === 'TaskOutput' && activity.status === 'completed') {
      const taskId = activity.toolInput?.["task_id"] as string | undefined
      if (taskId) {
        const data = extractTaskOutputData(activity)
        if (data) {
          taskOutputByAgentId.set(taskId, data)
        }
      }
    }
  }

  // Build a map of Task toolUseId -> agent ID (extracted from Task result content)
  // When Task runs with run_in_background: true, the result contains "agentId: xyz"
  const taskToAgentId = new Map<string, string>()
  for (const activity of activities) {
    if (isParentTaskTool(activity.toolName ?? '') && (activity.status === 'completed' || activity.status === 'backgrounded') && activity.content) {
      // Parse agent ID from Task result - look for "agentId: xyz" pattern
      const agentIdMatch = activity.content.match(/agentId:\s*([a-zA-Z0-9_-]+)/)
      const capturedAgentId = agentIdMatch?.[1]
      if (capturedAgentId && activity.toolUseId) {
        taskToAgentId.set(activity.toolUseId, capturedAgentId)
      }
    }
  }

  // Build the grouped result maintaining chronological order
  const result: (ActivityItem | ActivityGroup)[] = []

  for (const activity of activities) {
    // Skip activities that are children of a Task (they're in their parent's group)
    if (childIds.has(activity.id)) {
      continue
    }

    // Skip TaskOutput activities - their data is attached to parent Task groups
    if (activity.toolName === 'TaskOutput') {
      continue
    }

    // Task/Agent tools become groups with their children
    if (isParentTaskTool(activity.toolName ?? '')) {
      const children = activity.toolUseId
        ? (childrenByParent.get(activity.toolUseId) || [])
        : []

      // Look up TaskOutput data for this Task via the agent ID chain:
      // Task.toolUseId -> agentId -> TaskOutput data
      let taskOutputData: TaskOutputData | undefined
      if (activity.toolUseId) {
        const agentId = taskToAgentId.get(activity.toolUseId)
        if (agentId) {
          taskOutputData = taskOutputByAgentId.get(agentId)
        }
      }

      result.push({
        type: 'group',
        parent: activity,
        children: children.sort((a, b) => a.timestamp - b.timestamp),
        taskOutputData,
      })
    } else {
      // Orphan activity - add directly
      result.push(activity)
    }
  }

  return result
}

/**
 * Counts the total number of activities including those inside groups
 */
export function countTotalActivities(items: (ActivityItem | ActivityGroup)[]): number {
  let count = 0
  for (const item of items) {
    if (isActivityGroup(item)) {
      count += 1 + item.children.length // Parent + children
    } else {
      count += 1
    }
  }
  return count
}
