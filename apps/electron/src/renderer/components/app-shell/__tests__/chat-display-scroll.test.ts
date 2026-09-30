import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// ChatDisplay has no RTL/jsdom harness. Keep a focused source guard for the
// reset wiring; browser-level validation remains necessary for scroll metrics.
const source = readFileSync(join(__dirname, '../ChatDisplay.tsx'), 'utf8')

describe('ChatDisplay transcript positioning', () => {
  it('repositions compact transcripts when the active session changes', () => {
    expect(source).toContain('resetKey: string')
    expect(source).toContain('}, [onScroll, resetKey, skip, viewportRef])')
    expect(source).toContain('resetKey={session.id}')
    expect(source).toContain('skippedResetKeyRef.current = resetKey')
    expect(source).toContain('skippedResetKeyRef.current === resetKey')
  })

  it('targets the chat viewport and keeps early layout changes pinned', () => {
    const directBottomWrites = source.match(/viewport\.scrollTop = viewport\.scrollHeight/g) ?? []

    expect(directBottomWrites.length).toBeGreaterThanOrEqual(2)
    expect(source).toContain('if (!isStickToBottomRef.current) return')
    expect(source).toContain('Date.now() < skipSmoothScrollUntilRef.current')
    expect(source).toContain('resizeObserver.observe(viewport)')
  })
})
