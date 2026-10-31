import { parseReadResult, parseBashResult, parseGrepResult, parseGlobResult } from '../tool-parsers/results.ts'
import { describe, it, expect } from 'bun:test'
import type { ActivityItem } from '../../components/chat/TurnCard'
import { extractOverlayCards, parseWebSearchResult } from '../tool-parsers'
import type { OverlayData } from '../tool-parsers'

function makeActivity(overrides: Partial<ActivityItem>): ActivityItem {
  return {
    id: 'tool-1',
    type: 'tool',
    status: 'completed',
    timestamp: Date.now(),
    toolName: 'mcp__session__browser_tool',
    toolInput: {},
    content: '',
    ...overrides,
  }
}

describe('extractOverlayCards', () => {
  it('uses wrapper command verbatim for browser_tool input cards', () => {
    const activity = makeActivity({
      toolName: 'mcp__session__browser_tool',
      toolInput: { command: 'navigate https://example.com' },
      content: 'Navigated to: https://example.com\nTitle: Example',
    })

    const cards = extractOverlayCards(activity)
    expect(cards[0]?.label).toBe('Input')
    expect(cards[0]?.commandPreview).toBe('navigate https://example.com')
  })

  it('returns input + output cards for browser_tool with output', () => {
    const activity = makeActivity({
      toolName: 'mcp__session__browser_tool',
      toolInput: { command: 'snapshot' },
      content: JSON.stringify([{ ref: '@e1', role: 'button' }]),
    })

    const cards = extractOverlayCards(activity)
    expect(cards).toHaveLength(2)
    expect(cards[0]?.label).toBe('Input')
    expect(cards[0]?.commandPreview).toBe('snapshot')
    expect(cards[1]?.label).toBe('Output')
  })

  it('returns output-only card when command is empty', () => {
    const activity = makeActivity({
      toolName: 'mcp__session__browser_tool',
      toolInput: {},
      content: 'Missing command.',
    })

    const cards = extractOverlayCards(activity)
    // No meaningful input → output only
    expect(cards.length).toBeGreaterThanOrEqual(1)
    expect(cards[cards.length - 1]?.label).toBe('Output')
  })

  it('marks Write markdown output as document card data', () => {
    const activity = makeActivity({
      toolName: 'Write',
      toolInput: {
        path: '/tmp/notes.md',
        content: '# Weekly Notes\n\n- item',
      },
      content: '',
    })

    const cards = extractOverlayCards(activity)
    const output = cards.find(card => card.id === 'output')

    expect(output).toBeDefined()
    expect((output?.data as OverlayData).type).toBe('document')
  })

  it('keeps generic markdown-ish output as generic card data', () => {
    const markdownText = '# Heading\n\nSome paragraph text.'
    const activity = makeActivity({
      toolName: 'mcp__session__browser_tool',
      toolInput: { command: 'evaluate "document.body.innerText"' },
      content: markdownText,
    })

    const cards = extractOverlayCards(activity)
    const output = cards.find(card => card.id === 'output')

    expect(output).toBeDefined()
    expect((output?.data as OverlayData).type).toBe('generic')
    if (output?.data.type === 'generic') {
      expect(output.data.content).toBe(markdownText)
    }
  })
})

describe('parseWebSearchResult', () => {
  it('parses nested JSON content and multiple link sections', () => {
    const input = [
      'Links: [{"title":"One [nested]","url":"https://www.example.com/a"}]',
      'Other',
      'Links: [{"title":"Two","url":"https://docs.example.org/b"}]',
    ].join('\n')

    const result = parseWebSearchResult(input)
    expect(result).toContain('- [example.com - One [nested]](https://www.example.com/a)')
    expect(result).toContain('- [docs.example.org - Two](https://docs.example.org/b)')
  })

  it('preserves a large unterminated links payload', () => {
    const input = `Links: [${'x'.repeat(100_000)}`
    expect(parseWebSearchResult(input)).toBe(input)
  })
})


describe('structured tool output boundaries', () => {
  it('keeps Read content and numeric line metadata while retaining malformed envelopes verbatim', () => {
    expect(parseReadResult('{"file":{"content":"hello","numLines":1,"startLine":2,"totalLines":3}}'))
      .toEqual({ content: 'hello', numLines: 1, startLine: 2, totalLines: 3 })
    for (const raw of ['null', '{"file":null}', '{"file":{"content":{}}}']) {
      expect(parseReadResult(raw)).toEqual({ content: raw })
    }
  })
  it('preserves empty Bash output and an observed interruption without coercing malformed fields', () => {
    expect(parseBashResult('{"stdout":"","stderr":"","exitCode":0}'))
      .toEqual({ output: '', exitCode: 0 })
    expect(parseBashResult('{"stdout":"partial","interrupted":true}'))
      .toEqual({ output: 'partial', exitCode: 130 })
    expect(parseBashResult('{"stdout":{},"exitCode":"0"}'))
      .toEqual({ output: '{"stdout":{},"exitCode":"0"}' })
  })
  it('renders valid search filenames and leaves malformed values visible', () => {
    expect(parseGrepResult('{"filenames":["a.ts","b.ts"]}', 'pattern', '.', 'files').output)
      .toBe('a.ts\nb.ts')
    for (const raw of ['null', '{"filenames":{}}', '{"filenames":["a.ts",7]}']) {
      expect(parseGrepResult(raw, 'pattern', '.', 'files').output).toBe(raw)
    }
  })
  it('accepts both Glob formats and preserves corrupt rows for diagnosis', () => {
    for (const raw of ['["a.ts","b.ts"]', '{"filenames":["a.ts","b.ts"],"numFiles":2}']) {
      expect(parseGlobResult(raw, '*.ts', '.').output).toBe('a.ts\nb.ts')
    }
    expect(parseGlobResult('["a.ts",{}]', '*.ts', '.').output).toBe('["a.ts",{}]')
  })
})
