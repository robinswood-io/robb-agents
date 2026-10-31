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
import { groupActivitiesByParent, computeLastChildSet, isActivityGroup, type ActivityGroup } from '../turn-utils';

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
 * Create a TodoWrite activity with todo items
 */
function createTodoWriteActivity(
  todos: Array<{ content: string; status: string; activeForm?: string }>,
  overrides: Partial<ActivityItem> = {}
): ActivityItem {
  return createActivity({
    toolName: 'TodoWrite',
    toolInput: { todos },
    content: 'Todo list updated successfully',
    status: 'completed',
    ...overrides,
  })
}

describe('groupActivitiesByParent', () => {
describe('stateless invariants (post-refactor)', () => {
it('mixed top-level and nested tools group into correct turns', () => {
      resetCounters()

      // Realistic scenario: top-level Read, then a Task with children,
      // then another top-level Write. Verifies clean separation.
      const topRead = createActivity({
        toolName: 'Read',
        timestamp: 1000,
      })
      const task = createTaskActivity('Analyze', { timestamp: 2000 })
      const taskChild1 = createChildActivity(task.toolUseId!, {
        toolName: 'Grep',
        timestamp: 2500,
      })
      const taskChild2 = createChildActivity(task.toolUseId!, {
        toolName: 'Read',
        timestamp: 3000,
      })
      const topWrite = createActivity({
        toolName: 'Write',
        timestamp: 4000,
      })

      const activities = [topRead, task, taskChild1, taskChild2, topWrite]
      const result = groupActivitiesByParent(activities)

      // 3 items: topRead (standalone), Task group, topWrite (standalone)
      expect(result.length).toBe(3)

      expect(isActivityGroup(result[0]!)).toBe(false)
      expect((result[0] as ActivityItem).toolName).toBe('Read')

      expect(isActivityGroup(result[1]!)).toBe(true)
      const group = result[1] as ActivityGroup
      expect(group.parent.toolName).toBe('Task')
      expect(group.children.length).toBe(2)
      expect(group.children[0]!.toolName).toBe('Grep')
      expect(group.children[1]!.toolName).toBe('Read')

      expect(isActivityGroup(result[2]!)).toBe(false)
      expect((result[2] as ActivityItem).toolName).toBe('Write')
    })
});
});

describe('computeLastChildSet', () => {
it('returns empty set for empty input', () => {
    resetCounters()
    const result = computeLastChildSet([])
    expect(result.size).toBe(0)
  })

it('returns empty set when no activities have parents (all depth 0)', () => {
    resetCounters()
    const activities = [
      createActivity({ depth: 0 }),
      createActivity({ depth: 0 }),
      createActivity({ depth: 0 }),
    ]

    const result = computeLastChildSet(activities)
    expect(result.size).toBe(0)
  })

it('identifies last child for single parent', () => {
    resetCounters()
    const parent = createActivity({ toolName: 'Task' })
    const child1 = createChildActivity(parent.toolUseId!, { toolName: 'Read' })
    const child2 = createChildActivity(parent.toolUseId!, { toolName: 'Grep' })
    const child3 = createChildActivity(parent.toolUseId!, { toolName: 'Write' })

    const activities = [parent, child1, child2, child3]
    const result = computeLastChildSet(activities)

    // Only child3 should be in the set (last child of parent)
    expect(result.size).toBe(1)
    expect(result.has(child3.id)).toBe(true)
    expect(result.has(child1.id)).toBe(false)
    expect(result.has(child2.id)).toBe(false)
  })

it('identifies last child for multiple parents', () => {
    resetCounters()
    const parent1 = createActivity({ toolName: 'Task' })
    const parent2 = createActivity({ toolName: 'Task' })

    const child1a = createChildActivity(parent1.toolUseId!, { toolName: 'Read' })
    const child1b = createChildActivity(parent1.toolUseId!, { toolName: 'Grep' })
    const child2a = createChildActivity(parent2.toolUseId!, { toolName: 'Write' })

    const activities = [parent1, child1a, child1b, parent2, child2a]
    const result = computeLastChildSet(activities)

    // child1b is last child of parent1, child2a is last child of parent2
    expect(result.size).toBe(2)
    expect(result.has(child1b.id)).toBe(true)
    expect(result.has(child2a.id)).toBe(true)
    expect(result.has(child1a.id)).toBe(false)
  })

it('handles nested parent-child relationships (depth > 1)', () => {
    resetCounters()
    const grandparent = createActivity({ toolName: 'Task', depth: 0 })
    const parent = createChildActivity(grandparent.toolUseId!, {
      toolName: 'Task',
      depth: 1,
    })
    const child1 = createActivity({
      toolName: 'Read',
      parentId: parent.toolUseId,
      depth: 2,
    })
    const child2 = createActivity({
      toolName: 'Grep',
      parentId: parent.toolUseId,
      depth: 2,
    })

    const activities = [grandparent, parent, child1, child2]
    const result = computeLastChildSet(activities)

    // parent is last child of grandparent, child2 is last child of parent
    expect(result.size).toBe(2)
    expect(result.has(parent.id)).toBe(true)
    expect(result.has(child2.id)).toBe(true)
  })

it('handles single child (is both first and last)', () => {
    resetCounters()
    const parent = createActivity({ toolName: 'Task' })
    const onlyChild = createChildActivity(parent.toolUseId!, { toolName: 'Read' })

    const activities = [parent, onlyChild]
    const result = computeLastChildSet(activities)

    expect(result.size).toBe(1)
    expect(result.has(onlyChild.id)).toBe(true)
  })
});

describe('isActivityGroup', () => {
it('returns true for ActivityGroup objects', () => {
    resetCounters()
    const group: ActivityGroup = {
      type: 'group',
      parent: createActivity({ toolName: 'Task' }),
      children: [],
    }

    expect(isActivityGroup(group)).toBe(true)
  })

it('returns false for ActivityItem objects', () => {
    resetCounters()
    const activity = createActivity({ toolName: 'Read' })

    expect(isActivityGroup(activity)).toBe(false)
  })

it('returns false for activity with type property that is not "group"', () => {
    resetCounters()
    const activity = createActivity({ type: 'tool' })

    expect(isActivityGroup(activity)).toBe(false)
  })
});

describe('TodoWrite extraction', () => {
// These tests verify the todo extraction behavior by creating activities
  // and checking groupActivitiesByParent doesn't break with TodoWrite activities

  it('includes TodoWrite activities in flat list (not grouped)', () => {
    resetCounters()
    const todoActivity = createTodoWriteActivity([
      { content: 'First task', status: 'completed' },
      { content: 'Second task', status: 'in_progress', activeForm: 'Working on second task' },
    ])

    const result = groupActivitiesByParent([todoActivity])

    expect(result.length).toBe(1)
    expect(isActivityGroup(result[0]!)).toBe(false)
    expect((result[0] as ActivityItem).toolName).toBe('TodoWrite')
  })

it('handles TodoWrite as child of Task', () => {
    resetCounters()
    const task = createTaskActivity('Plan implementation')
    const todoChild = createTodoWriteActivity(
      [{ content: 'Step 1', status: 'pending' }],
      { parentId: task.toolUseId, depth: 1 }
    )

    const activities = [task, todoChild]
    const result = groupActivitiesByParent(activities)

    expect(result.length).toBe(1)
    const group = result[0] as ActivityGroup
    expect(group.children.length).toBe(1)
    expect(group.children[0]!.toolName).toBe('TodoWrite')
  })
});
