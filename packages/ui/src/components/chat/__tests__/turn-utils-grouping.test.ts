/**
 * Tests for activity grouping and helper utilities in turn-utils.ts
 *
 * These tests cover:
 * - groupActivitiesByParent() - Task subagent grouping
 * - extractTodosFromActivities() - TodoWrite parsing (internal, tested via exports)
 * - computeLastChildSet() - Tree view last-child detection
 * - extractTaskOutputData() - TaskOutput JSON parsing (internal, tested indirectly)
 */
import { describe, it, expect } from 'bun:test';
import { groupActivitiesByParent, isActivityGroup, type ActivityGroup } from '../turn-utils';

import type { ActivityItem } from '../TurnCard';

// ============================================================================
// Test Helpers
// ============================================================================

let activityIdCounter = 0
function resetCounters() {
  activityIdCounter = 0
}
/**
 * Create a basic activity item for testing
 */
function createActivity(
  overrides: Partial<ActivityItem> = {}
): ActivityItem {
  const id = `activity-${++activityIdCounter}`
  return {
    id,
    type: 'tool',
    status: 'completed',
    toolName: 'Read',
    toolUseId: `tu-${activityIdCounter}`,
    timestamp: Date.now() + activityIdCounter * 100,
    depth: 0,
    ...overrides,
  }
}
/**
 * Create a Task activity (parent tool that groups children)
 */
function createTaskActivity(
  description: string,
  overrides: Partial<ActivityItem> = {}
): ActivityItem {
  return createActivity({
    toolName: 'Task',
    toolInput: { description, subagent_type: 'Explore' },
    ...overrides,
  })
}
/**
 * Create a child activity with a parent reference
 */
function createChildActivity(
  parentToolUseId: string,
  overrides: Partial<ActivityItem> = {}
): ActivityItem {
  return createActivity({
    parentId: parentToolUseId,
    depth: 1,
    ...overrides,
  })
}
/**
 * Create a TaskOutput activity (provides duration/token data for parent Task)
 */
function createTaskOutputActivity(
  taskId: string,
  data: { durationMs?: number; inputTokens?: number; outputTokens?: number },
  overrides: Partial<ActivityItem> = {}
): ActivityItem {
  const content = JSON.stringify({
    result: 'Task completed',
    duration_ms: data.durationMs,
    usage: {
      input_tokens: data.inputTokens,
      output_tokens: data.outputTokens,
    },
  })
  return createActivity({
    toolName: 'TaskOutput',
    toolInput: { task_id: taskId },
    content,
    ...overrides,
  })
}

describe('groupActivitiesByParent', () => {
describe('empty and flat cases', () => {
it('returns empty array for empty input', () => {
      resetCounters()
      const result = groupActivitiesByParent([])
      expect(result).toEqual([])
    })

it('returns flat list when no Task tools present', () => {
      resetCounters()
      const activities = [
        createActivity({ toolName: 'Read' }),
        createActivity({ toolName: 'Grep' }),
        createActivity({ toolName: 'Write' }),
      ]

      const result = groupActivitiesByParent(activities)

      // Should return same activities (not grouped)
      expect(result.length).toBe(3)
      expect(result.every(item => !isActivityGroup(item))).toBe(true)
    })
});

describe('single Task with children', () => {
it('groups child activities under Task parent', () => {
      resetCounters()
      const taskActivity = createTaskActivity('Search codebase')
      const child1 = createChildActivity(taskActivity.toolUseId!, { toolName: 'Grep' })
      const child2 = createChildActivity(taskActivity.toolUseId!, { toolName: 'Read' })

      const activities = [taskActivity, child1, child2]
      const result = groupActivitiesByParent(activities)

      // Should have 1 group
      expect(result.length).toBe(1)
      expect(isActivityGroup(result[0]!)).toBe(true)

      const group = result[0] as ActivityGroup
      expect(group.parent.id).toBe(taskActivity.id)
      expect(group.children.length).toBe(2)
      expect(group.children[0]!.id).toBe(child1.id)
      expect(group.children[1]!.id).toBe(child2.id)
    })

it('maintains chronological order of children within group', () => {
      resetCounters()
      const taskActivity = createTaskActivity('Analyze code')

      // Create children with explicit timestamps out of order
      const child1 = createChildActivity(taskActivity.toolUseId!, {
        toolName: 'Read',
        timestamp: 3000,
      })
      const child2 = createChildActivity(taskActivity.toolUseId!, {
        toolName: 'Grep',
        timestamp: 1000,
      })
      const child3 = createChildActivity(taskActivity.toolUseId!, {
        toolName: 'Glob',
        timestamp: 2000,
      })

      // Input in arbitrary order
      const activities = [taskActivity, child1, child2, child3]
      const result = groupActivitiesByParent(activities)

      const group = result[0] as ActivityGroup
      // Children should be sorted by timestamp
      expect(group.children[0]!.toolName).toBe('Grep')   // timestamp 1000
      expect(group.children[1]!.toolName).toBe('Glob')   // timestamp 2000
      expect(group.children[2]!.toolName).toBe('Read')   // timestamp 3000
    })
});

describe('SDK Agent tool name (post v0.2.72 rename)', () => {
it('groups children under an Agent parent identically to a Task parent', () => {
      resetCounters()
      const agentActivity = createActivity({
        toolName: 'Agent',
        toolInput: { description: 'Search codebase', subagent_type: 'Explore' },
      })
      const child1 = createChildActivity(agentActivity.toolUseId!, { toolName: 'Grep' })
      const child2 = createChildActivity(agentActivity.toolUseId!, { toolName: 'Read' })

      const result = groupActivitiesByParent([agentActivity, child1, child2])

      expect(result.length).toBe(1)
      expect(isActivityGroup(result[0]!)).toBe(true)

      const group = result[0] as ActivityGroup
      expect(group.parent.toolName).toBe('Agent')
      expect(group.children.length).toBe(2)
      expect(group.children[0]!.id).toBe(child1.id)
      expect(group.children[1]!.id).toBe(child2.id)
    })
});

describe('multiple Tasks with children', () => {
it('groups each Task with its own children', () => {
      resetCounters()
      const task1 = createTaskActivity('First task')
      const task2 = createTaskActivity('Second task')

      const child1a = createChildActivity(task1.toolUseId!, { toolName: 'Read' })
      const child1b = createChildActivity(task1.toolUseId!, { toolName: 'Grep' })
      const child2a = createChildActivity(task2.toolUseId!, { toolName: 'Write' })

      const activities = [task1, child1a, child1b, task2, child2a]
      const result = groupActivitiesByParent(activities)

      expect(result.length).toBe(2)

      const group1 = result[0] as ActivityGroup
      expect(group1.parent.id).toBe(task1.id)
      expect(group1.children.length).toBe(2)

      const group2 = result[1] as ActivityGroup
      expect(group2.parent.id).toBe(task2.id)
      expect(group2.children.length).toBe(1)
    })
});

describe('mixed orphans and Task groups', () => {
it('preserves orphan activities alongside Task groups in chronological order', () => {
      resetCounters()

      // Create activities with explicit timestamps
      const orphan1 = createActivity({ toolName: 'Read', timestamp: 1000 })
      const task = createTaskActivity('Search', { timestamp: 2000 })
      const child = createChildActivity(task.toolUseId!, { toolName: 'Grep', timestamp: 2500 })
      const orphan2 = createActivity({ toolName: 'Write', timestamp: 3000 })

      const activities = [orphan1, task, child, orphan2]
      const result = groupActivitiesByParent(activities)

      expect(result.length).toBe(3)

      // First item: orphan Read
      expect(isActivityGroup(result[0]!)).toBe(false)
      expect((result[0] as ActivityItem).toolName).toBe('Read')

      // Second item: Task group
      expect(isActivityGroup(result[1]!)).toBe(true)
      expect((result[1] as ActivityGroup).parent.toolName).toBe('Task')

      // Third item: orphan Write
      expect(isActivityGroup(result[2]!)).toBe(false)
      expect((result[2] as ActivityItem).toolName).toBe('Write')
    })
});

describe('TaskOutput data attachment', () => {
it('attaches TaskOutput data to parent Task group via agentId chain', () => {
      resetCounters()

      // Task that ran in background returns agentId in its result
      const task = createTaskActivity('Background task', {
        content: 'Task completed successfully\n\nagentId: abc123',
        status: 'completed',
      })

      // TaskOutput references the agentId
      const taskOutput = createTaskOutputActivity('abc123', {
        durationMs: 5000,
        inputTokens: 1000,
        outputTokens: 500,
      })

      const activities = [task, taskOutput]
      const result = groupActivitiesByParent(activities)

      // TaskOutput should be hidden, only Task group visible
      expect(result.length).toBe(1)
      expect(isActivityGroup(result[0]!)).toBe(true)

      const group = result[0] as ActivityGroup
      expect(group.taskOutputData).toBeDefined()
      expect(group.taskOutputData!.durationMs).toBe(5000)
      expect(group.taskOutputData!.inputTokens).toBe(1000)
      expect(group.taskOutputData!.outputTokens).toBe(500)
    })

it('handles Task without TaskOutput data gracefully', () => {
      resetCounters()

      const task = createTaskActivity('Simple task', { status: 'completed' })
      const child = createChildActivity(task.toolUseId!, { toolName: 'Read' })

      const activities = [task, child]
      const result = groupActivitiesByParent(activities)

      const group = result[0] as ActivityGroup
      expect(group.taskOutputData).toBeUndefined()
    })

it('hides TaskOutput activities from result', () => {
      resetCounters()

      const task = createTaskActivity('Task with output', {
        content: 'Done\n\nagentId: xyz789',
        status: 'completed',
      })
      const taskOutput = createTaskOutputActivity('xyz789', { durationMs: 1000 })
      const orphan = createActivity({ toolName: 'Read' })

      const activities = [orphan, task, taskOutput]
      const result = groupActivitiesByParent(activities)

      // TaskOutput should not appear in result
      expect(result.length).toBe(2)
      expect(result.some(item =>
        !isActivityGroup(item) && (item as ActivityItem).toolName === 'TaskOutput'
      )).toBe(false)
    })
});

describe('edge cases', () => {
it('handles Task with no children (empty group)', () => {
      resetCounters()

      const task = createTaskActivity('Empty task')
      const result = groupActivitiesByParent([task])

      expect(result.length).toBe(1)
      expect(isActivityGroup(result[0]!)).toBe(true)
      expect((result[0] as ActivityGroup).children.length).toBe(0)
    })

it('shows children with missing parents as orphan activities at root level', () => {
      resetCounters()

      // Child references non-existent parent (parent Task doesn't exist)
      const orphanChild = createChildActivity('non-existent-parent', { toolName: 'Read' })
      const result = groupActivitiesByParent([orphanChild])

      // Orphaned children (with parentId pointing to non-existent Task) should
      // appear as standalone activities at root level, not be silently dropped.
      // This provides better visibility into edge cases where parent arrives late
      // or doesn't exist.
      expect(result.length).toBe(1)
      expect(isActivityGroup(result[0]!)).toBe(false)
      expect((result[0] as ActivityItem).toolName).toBe('Read')
    })

it('handles malformed TaskOutput JSON gracefully', () => {
      resetCounters()

      const task = createTaskActivity('Task', {
        content: 'Done\n\nagentId: bad123',
        status: 'completed',
      })

      // TaskOutput with invalid JSON content
      const badTaskOutput = createActivity({
        toolName: 'TaskOutput',
        toolInput: { task_id: 'bad123' },
        content: 'not valid json',
        status: 'completed',
      })

      const activities = [task, badTaskOutput]
      const result = groupActivitiesByParent(activities)

      // Should still work, just without taskOutputData
      expect(result.length).toBe(1)
      const group = result[0] as ActivityGroup
      expect(group.taskOutputData).toBeUndefined()
    })
});

describe('stateless invariants (post-refactor)', () => {
it('out-of-order stored messages: children before parent still group correctly', () => {
      resetCounters()

      // Simulate a restored session where children were persisted before
      // their parent Task (e.g., from parallel event processing).
      // The grouping must work regardless of insertion order.
      const task = createTaskActivity('Search code')
      const child1 = createChildActivity(task.toolUseId!, {
        toolName: 'Grep',
        timestamp: 1500,
      })
      const child2 = createChildActivity(task.toolUseId!, {
        toolName: 'Read',
        timestamp: 2000,
      })

      // Children appear BEFORE parent in the array
      const activities = [child1, child2, task]
      const result = groupActivitiesByParent(activities)

      // Should still produce a single group with both children
      expect(result.length).toBe(1)
      expect(isActivityGroup(result[0]!)).toBe(true)

      const group = result[0] as ActivityGroup
      expect(group.parent.id).toBe(task.id)
      expect(group.children.length).toBe(2)
    })

it('restored session with nested Task hierarchy produces correct groups', () => {
      resetCounters()

      // Outer Task spawns an inner Task (nested subagent pattern).
      // After session restore, all activities arrive as a flat list.
      const outerTask = createTaskActivity('Explore codebase', { timestamp: 1000 })
      const innerTask = createChildActivity(outerTask.toolUseId!, {
        toolName: 'Task',
        toolInput: { description: 'Deep search', subagent_type: 'Explore' },
        timestamp: 1500,
      })
      const innerChild = createActivity({
        toolName: 'Grep',
        parentId: innerTask.toolUseId,
        depth: 2,
        timestamp: 2000,
      })
      const outerChild = createChildActivity(outerTask.toolUseId!, {
        toolName: 'Read',
        timestamp: 3000,
      })

      const activities = [outerTask, innerTask, innerChild, outerChild]
      const result = groupActivitiesByParent(activities)

      // Outer Task should be grouped with innerTask + outerChild as its children.
      // innerChild belongs to innerTask (depth 2), but groupActivitiesByParent
      // only groups by direct parentId, so innerChild is a child of innerTask.
      expect(result.length).toBe(1)
      expect(isActivityGroup(result[0]!)).toBe(true)

      const outerGroup = result[0] as ActivityGroup
      expect(outerGroup.parent.id).toBe(outerTask.id)
      // outerTask's direct children: innerTask and outerChild
      // innerChild has parentId = innerTask.toolUseId, not outerTask.toolUseId
      expect(outerGroup.children.length).toBe(2)
    })
});
});
