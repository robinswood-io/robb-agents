import { describe, expect, it } from 'bun:test'
import { arrangeRowsAsVisualSessionTree } from '../session-visual-hierarchy'

type TestSession = {
  id: string
  parentSessionId?: string
}

const row = (id: string, parentSessionId?: string) => ({ item: { id, parentSessionId } satisfies TestSession })
const ids = (rows: Array<{ item: TestSession; hierarchyDepth?: number; visualParentSessionId?: string }>) => rows.map(r => r.item.id)

describe('arrangeRowsAsVisualSessionTree', () => {
  it('places visible child sessions directly under their parent', () => {
    const arranged = arrangeRowsAsVisualSessionTree([
      row('child-a', 'parent'),
      row('other'),
      row('parent'),
      row('child-b', 'parent'),
    ])

    expect(ids(arranged)).toEqual(['other', 'parent', 'child-a', 'child-b'])
    expect(arranged.find(r => r.item.id === 'parent')?.hierarchyDepth).toBe(0)
    expect(arranged.find(r => r.item.id === 'child-a')?.hierarchyDepth).toBe(1)
    expect(arranged.find(r => r.item.id === 'child-a')?.visualParentSessionId).toBe('parent')
  })

  it('keeps descendants nested in input sibling order', () => {
    const arranged = arrangeRowsAsVisualSessionTree([
      row('grandchild', 'child'),
      row('sibling', 'parent'),
      row('child', 'parent'),
      row('parent'),
    ])

    expect(ids(arranged)).toEqual(['parent', 'sibling', 'child', 'grandchild'])
    expect(arranged.find(r => r.item.id === 'grandchild')?.hierarchyDepth).toBe(2)
    expect(arranged.find(r => r.item.id === 'grandchild')?.visualParentSessionId).toBe('child')
  })

  it('leaves children top-level when their parent is filtered out', () => {
    const arranged = arrangeRowsAsVisualSessionTree([
      row('child', 'missing-parent'),
      row('other'),
    ])

    expect(ids(arranged)).toEqual(['child', 'other'])
    expect(arranged[0].hierarchyDepth).toBe(0)
    expect(arranged[0].visualParentSessionId).toBeUndefined()
  })

  it('does not recurse forever on malformed cycles', () => {
    const arranged = arrangeRowsAsVisualSessionTree([
      row('a', 'b'),
      row('b', 'a'),
    ])

    expect(ids(arranged).sort()).toEqual(['a', 'b'])
    expect(arranged).toHaveLength(2)
  })
})
