export interface SessionVisualHierarchyInput {
  id: string
  parentSessionId?: string
}

export interface SessionVisualHierarchyRow<T extends SessionVisualHierarchyInput> {
  item: T
  hierarchyDepth?: number
  visualParentSessionId?: string
}

/**
 * Reorders already-visible session rows so child/sub-agent sessions appear
 * directly below their visible parent in the sidebar.
 *
 * The input order remains authoritative for top-level sessions and sibling
 * ordering (usually last-activity descending). Children whose parent is not in
 * the visible set are left at the top level so filters/search never hide the
 * relationship behind an absent row. Cycles are guarded defensively and fall
 * back to top-level rows rather than recursing forever.
 */
export function arrangeRowsAsVisualSessionTree<T extends SessionVisualHierarchyInput, R extends SessionVisualHierarchyRow<T>>(
  rows: R[],
): Array<R & { hierarchyDepth: number; visualParentSessionId?: string }> {
  const rowById = new Map<string, R>()
  for (const row of rows) {
    rowById.set(row.item.id, row)
  }

  const childrenByParent = new Map<string, R[]>()
  for (const row of rows) {
    const parentId = row.item.parentSessionId
    if (!parentId || !rowById.has(parentId) || parentId === row.item.id) continue
    const siblings = childrenByParent.get(parentId)
    if (siblings) siblings.push(row)
    else childrenByParent.set(parentId, [row])
  }

  const result: Array<R & { hierarchyDepth: number; visualParentSessionId?: string }> = []
  const emitted = new Set<string>()
  const visiting = new Set<string>()

  const pushTree = (row: R, depth: number, visualParentSessionId?: string) => {
    const id = row.item.id
    if (emitted.has(id)) return
    if (visiting.has(id)) {
      // Defensive cycle guard: render the row once at the top level.
      result.push({ ...row, hierarchyDepth: 0, visualParentSessionId: undefined })
      emitted.add(id)
      return
    }

    visiting.add(id)
    result.push({
      ...row,
      hierarchyDepth: Math.max(0, depth),
      visualParentSessionId,
    })
    emitted.add(id)

    for (const child of childrenByParent.get(id) ?? []) {
      pushTree(child, depth + 1, id)
    }

    visiting.delete(id)
  }

  for (const row of rows) {
    const parentId = row.item.parentSessionId
    const hasVisibleParent = !!parentId && rowById.has(parentId) && parentId !== row.item.id
    if (!hasVisibleParent) {
      pushTree(row, 0)
    }
  }

  // If a malformed cycle made every node look like it had a visible parent,
  // render any remaining rows in their original order at top level.
  for (const row of rows) {
    if (!emitted.has(row.item.id)) {
      pushTree(row, 0)
    }
  }

  return result
}
