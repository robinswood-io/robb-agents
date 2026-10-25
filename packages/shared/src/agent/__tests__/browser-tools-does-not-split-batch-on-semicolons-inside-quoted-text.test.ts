/**
 * Tests for the browser tools factory.
 *
 * Verifies that createBrowserTools produces a single browser_tool
 * and that it delegates correctly to BrowserPaneFns callbacks via CLI commands.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { createBrowserTools, type BrowserPaneFns, type BrowserWaitArgs } from "../browser-tools";
import { setContextualGmailBrowserMutationGuard } from "../browser-tool-runtime";
import { createMockFns, executeTool } from "./testing/browser-tools-fixture.ts";


describe('createBrowserTools', () => {
let mockFns: BrowserPaneFns

let tools: ReturnType<typeof createBrowserTools>

beforeEach(() => {
    setContextualGmailBrowserMutationGuard('test-session', false)
    mockFns = createMockFns()
    tools = createBrowserTools({
      sessionId: 'test-session',
      getBrowserPaneFns: () => mockFns,
    })
  })

describe('browser_tool', () => {
it('does not split batch on semicolons inside quoted text', async () => {
      const calls: string[] = []
      mockFns.fill = async (ref, value) => { calls.push(`fill:${ref}:${value}`) }
      mockFns.click = async (ref) => { calls.push(`click:${ref}`) }

      const result = await executeTool(tools, 'browser_tool', {
        command: 'fill @e1 "a;b;c"; click @e2',
      })

      expect(calls).toEqual([
        'fill:@e1:a;b;c',
        'click:@e2',
      ])
      expect(result.content[0].text).toContain('Filled element @e1 with "a;b;c"')
      expect(result.content[0].text).toContain('Clicked element @e2')
    })

it('stops batched commands after navigation-changing command', async () => {
      const calls: string[] = []
      mockFns.navigate = async (url) => {
        calls.push(`navigate:${url}`)
        return { url, title: 'Page' }
      }
      mockFns.fill = async (ref, value) => { calls.push(`fill:${ref}:${value}`) }

      const result = await executeTool(tools, 'browser_tool', {
        command: 'fill @e1 start; navigate https://example.com; fill @e2 should-not-run',
      })

      expect(calls).toEqual([
        'fill:@e1:start',
        'navigate:https://example.com',
      ])
      expect(result.content[0].text).toContain('stopped batch after "navigate"')
    })

it('routes type command', async () => {
      let typedText = ''
      mockFns.type = async (text) => { typedText = text }
      const result = await executeTool(tools, 'browser_tool', { command: 'type Hello World' })
      expect(typedText).toBe('Hello World')
      expect(result.content[0].text).toContain('Requested insertion of 11 characters')
    })

it('returns error for type with no text', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'type' })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('type requires text')
    })

it('routes select command', async () => {
      let selectedRef = ''
      let selectedValue = ''
      mockFns.select = async (ref, value) => { selectedRef = ref; selectedValue = value }
      mockFns.snapshot = async () => ({
        url: 'https://example.com',
        title: 'Example',
        nodes: [
          { ref: '@e3', role: 'combobox', name: 'Type', value: 'optionValue' },
        ],
      })

      const result = await executeTool(tools, 'browser_tool', { command: 'select @e3 optionValue' })
      expect(selectedRef).toBe('@e3')
      expect(selectedValue).toBe('optionValue')
      expect(result.content[0].text).toContain('(verified)')
    })

it('parses select assertion flags and timeout', async () => {
      let selectedRef = ''
      let selectedValue = ''
      mockFns.select = async (ref, value) => { selectedRef = ref; selectedValue = value }
      mockFns.snapshot = async () => ({
        url: 'https://example.com',
        title: 'Example',
        nodes: [
          { ref: '@e75', role: 'combobox', name: 'Type', value: 'CNAME' },
          { ref: '@e80', role: 'textbox', name: 'Target', value: 'beautiful-mermaid.com' },
        ],
      })

      const result = await executeTool(tools, 'browser_tool', {
        command: 'select @e75 CNAME --assert-text Target --assert-value CNAME --timeout 3000',
      })

      expect(selectedRef).toBe('@e75')
      expect(selectedValue).toBe('CNAME')
      expect(result.content[0].text).toContain('assertTextMatched=true')
      expect(result.content[0].text).toContain('assertValueMatched=true')
      expect(result.content[0].text).toContain('timeout=3000ms')
      expect(result.content[0].text).toContain('(verified)')
    })

it('accepts assert-value from downstream node when selected control metadata lags', async () => {
      let snapshotCount = 0
      mockFns.snapshot = async () => {
        snapshotCount += 1
        if (snapshotCount === 1) {
          return {
            url: 'https://example.com',
            title: 'Example',
            nodes: [
              { ref: '@e75', role: 'combobox', name: 'Sort updated-newest', value: 'Sort' },
              { ref: '@e80', role: 'status', name: 'Current sort', value: 'updated-newest' },
            ],
          }
        }

        return {
          url: 'https://example.com',
          title: 'Example',
          nodes: [
            { ref: '@e75', role: 'combobox', name: 'Sort updated-newest', value: 'Sort' },
            { ref: '@e81', role: 'status', name: 'Current sort', value: 'updated-newest' },
          ],
        }
      }

      const result = await executeTool(tools, 'browser_tool', {
        command: 'select @e75 updated-newest --assert-value updated-newest --timeout 500',
      })

      expect(result.content[0].text).toContain('(verified)')
      expect(result.content[0].text).toContain('assertValueMatched=true')
      expect(result.content[0].text).not.toContain('assert-value did not match')
    })

it('returns warning when select cannot be verified', async () => {
      mockFns.snapshot = async () => ({
        url: 'https://example.com',
        title: 'Example',
        nodes: [
          { ref: '@e75', role: 'combobox', name: 'Type', value: 'A' },
          { ref: '@e80', role: 'textbox', name: 'IPv4 address (required)', value: '' },
        ],
      })

      const result = await executeTool(tools, 'browser_tool', {
        command: 'select @e75 CNAME --assert-text Target --timeout 500',
      })

      expect(result.content[0].text).toContain('(warning)')
      expect(result.content[0].text).toContain('Warning: select interaction succeeded but effective form state could not be fully verified')
      expect(result.content[0].text).toContain('assert-text did not match: "Target"')
    })

it('returns error when select assertion flag is missing value', async () => {
      const result = await executeTool(tools, 'browser_tool', {
        command: 'select @e75 CNAME --assert-text',
      })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('select --assert-text requires a value')
    })

it('routes upload command with one or more file paths', async () => {
      let uploadedRef = ''
      let uploadedPaths: string[] = []
      mockFns.upload = async (ref, filePaths) => { uploadedRef = ref; uploadedPaths = filePaths }

      const result = await executeTool(tools, 'browser_tool', {
        command: 'upload @e3 /tmp/a.pdf /tmp/b.jpg',
      })

      expect(uploadedRef).toBe('@e3')
      expect(uploadedPaths).toEqual(['/tmp/a.pdf', '/tmp/b.jpg'])
      expect(result.content[0].text).toContain('Uploaded 2 files:')
      expect(result.content[0].text).toContain('/tmp/a.pdf')
      expect(result.content[0].text).toContain('/tmp/b.jpg')
    })

it('returns error for upload with missing arguments', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'upload @e3' })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('upload requires ref and file path(s)')
    })

it('routes set-clipboard command', async () => {
      let clipboardText = ''
      mockFns.setClipboard = async (text) => { clipboardText = text }
      const result = await executeTool(tools, 'browser_tool', { command: 'set-clipboard Hello World' })
      expect(clipboardText).toBe('Hello World')
      expect(result.content[0].text).toContain('Clipboard set (11 characters)')
    })

it('decodes escaped tab/newline sequences for set-clipboard', async () => {
      let clipboardText = ''
      mockFns.setClipboard = async (text) => { clipboardText = text }
      const result = await executeTool(tools, 'browser_tool', {
        command: 'set-clipboard Hello\\tWorld\\nFoo\\tBar',
      })
      expect(clipboardText).toBe('Hello\tWorld\nFoo\tBar')
      expect(result.content[0].text).toContain('Clipboard set (19 characters)')
    })

it('preserves unknown escapes for set-clipboard', async () => {
      let clipboardText = ''
      mockFns.setClipboard = async (text) => { clipboardText = text }
      await executeTool(tools, 'browser_tool', {
        command: 'set-clipboard keep\\xliteral',
      })
      expect(clipboardText).toBe('keep\\xliteral')
    })

it('returns error for set-clipboard with no text', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'set-clipboard' })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('set-clipboard requires text')
    })

it('routes get-clipboard command', async () => {
      mockFns.getClipboard = async () => 'some clipboard data'
      const result = await executeTool(tools, 'browser_tool', { command: 'get-clipboard' })
      expect(result.content[0].text).toContain('Clipboard content (19 chars, 1 lines, 0 tabs):')
      expect(result.content[0].text).toContain('some clipboard data')
      expect(result.content[0].text).toContain('When you are done using the browser')
    })

it('routes get-clipboard returns empty placeholder for empty clipboard', async () => {
      mockFns.getClipboard = async () => ''
      const result = await executeTool(tools, 'browser_tool', { command: 'get-clipboard' })
      expect(result.content[0].text).toContain('(empty clipboard)')
    })

it('does not send a paste shortcut after a rejected clipboard write', async () => {
      let shortcuts = 0
      mockFns.setClipboard = async () => { throw new Error('Clipboard write failed') }
      mockFns.sendKey = async () => { shortcuts++ }
      const result = await executeTool(tools, 'browser_tool', { command: ['paste', 'private text'] })
      expect(result.isError).toBe(true)
      expect(shortcuts).toBe(0)
      expect(result.content[0].text).not.toContain('private text')
    })

it('routes explicit keyboard text once without clipboard, Enter, or a success claim about the remote application', async () => {
      const sent: unknown[] = []
      mockFns.sendKey = async (args) => { sent.push(args) }
      mockFns.setClipboard = async () => { throw new Error('must never touch clipboard') }
      const text = 'é € a  b;[]'
      const result = await executeTool(tools, 'browser_tool', { command: ['type-keys', text] })
      expect(result.isError).not.toBe(true)
      expect(sent).toEqual([{ key: 'Unidentified', text }])
      expect(result.content[0].text).toContain('not verified')
      expect(result.content[0].text).not.toContain(text)
    })

it('routes paste command (set-clipboard + key)', async () => {
      let clipboardText = ''
      let keySent = ''
      mockFns.setClipboard = async (text) => { clipboardText = text }
      mockFns.sendKey = async (args) => { keySent = args.key }
      const result = await executeTool(tools, 'browser_tool', { command: 'paste Hello World' })
      expect(clipboardText).toBe('Hello World')
      expect(keySent).toBe('v')
      expect(result.content[0].text).toContain('paste shortcut dispatched for 11 characters')
    })

it('decodes escaped tab/newline sequences for paste', async () => {
      let clipboardText = ''
      let keySent = ''
      mockFns.setClipboard = async (text) => { clipboardText = text }
      mockFns.sendKey = async (args) => { keySent = args.key }
      const result = await executeTool(tools, 'browser_tool', {
        command: 'paste Hello\\tWorld\\nFoo\\tBar',
      })
      expect(clipboardText).toBe('Hello\tWorld\nFoo\tBar')
      expect(keySent).toBe('v')
      expect(result.content[0].text).toContain('paste shortcut dispatched for 19 characters')
    })

it('returns error for paste with no text', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'paste' })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('paste requires text')
    })

it('routes screenshot command and returns image block', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'screenshot' })
      expect(result.content[0].text).toContain('Screenshot captured')
      expect(result.content[1]!.type).toBe('image')
      expect(result.content[1]!.mimeType).toBe('image/png')
    })

it('routes annotated screenshot and passes annotate flag', async () => {
      let screenshotArgs: Parameters<NonNullable<BrowserPaneFns['screenshot']>>[0]
      mockFns.screenshot = async (args) => {
        screenshotArgs = args
        return { imageBuffer: Buffer.from('fake-png-data'), imageFormat: 'png' as const }
      }

      const result = await executeTool(tools, 'browser_tool', { command: 'screenshot --annotated' })
      expect(screenshotArgs).toMatchObject({ annotate: true, format: 'jpeg' })
      expect(result.content[0].text).toContain('Annotated screenshot captured')
      expect(result.content[1]!.type).toBe('image')
    })

it('routes screenshot-region command and returns image block', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'screenshot-region 10 20 100 80' })
      expect(result.content[0].text).toContain('Region screenshot captured')
      expect(result.content[1]!.type).toBe('image')
      expect(result.content[1]!.mimeType).toBe('image/png')
    })

it('returns canvas bytes as a full MCP image, independently of evaluate text truncation', async () => {
      let actual: unknown
      const bytes = Buffer.alloc(9000, 42)
      mockFns.screenshotRegion = async args => {
        actual = args
        return { imageBuffer: bytes, imageFormat: 'png', metadata: { source: 'canvas-bitmap', region: { x: 0, y: 0, width: 1200, height: 852 } } }
      }
      const result = await executeTool(tools, 'browser_tool', { command: ['screenshot-region', '--canvas', '--selector', '#display canvas'] })
      expect(actual).toEqual({ source: 'canvas', selector: '#display canvas', format: 'png' })
      expect(result.isError).toBeUndefined()
      expect(result.content[0].text).toContain('not a composited page screenshot')
      expect(result.content[1]).toEqual({ type: 'image', data: bytes.toString('base64'), mimeType: 'image/png' })
    })

it('rejects ambiguous canvas modes and does not silently fall back to a screenshot', async () => {
      let calls = 0
      mockFns.screenshotRegion = async () => { calls++; throw Error('should not be called') }
      for (const command of ['screenshot-region --canvas --ref @e1', 'screenshot-region --canvas 1 2 3 4', 'screenshot-region --canvas --selector canvas --padding 2', 'screenshot-region --canvas --canvas --selector canvas']) {
        const result = await executeTool(tools, 'browser_tool', { command })
        expect(result.isError).toBe(true)
      }
      expect(calls).toBe(0)
    })

it('rejects an empty, oversized or mislabeled canvas image receipt', async () => {
      for (const value of [
        { imageBuffer: Buffer.alloc(0), imageFormat: 'png' as const, metadata: { source: 'canvas-bitmap' } },
        { imageBuffer: Buffer.alloc(4 * 1024 * 1024 + 1), imageFormat: 'png' as const, metadata: { source: 'canvas-bitmap' } },
        { imageBuffer: Buffer.from('data'), imageFormat: 'jpeg' as const, metadata: { source: 'canvas-bitmap' } },
        { imageBuffer: Buffer.from('data'), imageFormat: 'png' as const, metadata: { source: 'page' } },
      ]) {
        mockFns.screenshotRegion = async () => value
        const result = await executeTool(tools, 'browser_tool', { command: ['screenshot-region', '--canvas', '--selector', 'canvas'] })
        expect(result.isError).toBe(true)
        expect(result.content.some((x) => x.type === 'image')).toBe(false)
      }
    })

it('returns error for screenshot when PNG is empty', async () => {
      mockFns.screenshot = async () => ({ imageBuffer: Buffer.alloc(0), imageFormat: 'png' as const })
      const result = await executeTool(tools, 'browser_tool', { command: 'screenshot' })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('empty image data')
    })

it('returns error for screenshot-region when PNG is empty', async () => {
      mockFns.screenshotRegion = async () => ({ imageBuffer: Buffer.alloc(0), imageFormat: 'png' as const })
      const result = await executeTool(tools, 'browser_tool', { command: 'screenshot-region 10 20 100 80' })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('empty image data')
    })

it('returns parse error for screenshot-region missing padding value', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'screenshot-region --ref @e12 --padding' })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('Missing value for --padding')
    })

it('returns parse error for screenshot-region non-numeric coords', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'screenshot-region 10 nope 100 80' })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('coordinates must be numbers')
    })

it('treats --padding-like text inside quoted selectors as selector content', async () => {
      let screenshotRegionArgs: Parameters<NonNullable<BrowserPaneFns['screenshotRegion']>>[0] | undefined
      mockFns.screenshotRegion = async (args) => {
        screenshotRegionArgs = args
        return { imageBuffer: Buffer.from('fake-png-data'), imageFormat: 'png' as const }
      }

      const result = await executeTool(tools, 'browser_tool', {
        command: 'screenshot-region --selector "div[data-tip=\'--padding 99\';data-x=\'a;b\']" --padding 8',
      })

      expect(result.isError).toBeUndefined()
      expect(screenshotRegionArgs).toMatchObject({
        selector: "div[data-tip='--padding 99';data-x='a;b']",
        padding: 8,
        format: 'jpeg',
      })
      expect(result.content[0].text).toContain('Region screenshot captured')
    })

it('routes console command', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'console 10 warn' })
      expect(result.content[0].text).toContain('Console entries')
    })

it('routes window-resize command', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'window-resize 1024 768' })
      expect(result.content[0].text).toContain('Window resized to 1024x768')
    })

it('routes network command', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'network 10 failed' })
      expect(result.content[0].text).toContain('Network entries')
    })

it('routes wait command', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'wait network-idle 5000' })
      expect(result.content[0].text).toContain('Wait succeeded')
    })

it('routes resume as a challenge-clear wait with a human-friendly timeout', async () => {
      let waitArgs: BrowserWaitArgs | undefined
      mockFns.waitFor = async (args) => {
        waitArgs = args
        return { ok: true as const, kind: args.kind, elapsedMs: 321, detail: 'security challenge cleared' }
      }

      const result = await executeTool(tools, 'browser_tool', { command: 'resume 45000' })

      expect(waitArgs).toEqual({ kind: 'challenge-clear', timeoutMs: 45000 })
      expect(result.content[0].text).toContain('Security verification cleared')
      expect(result.content[0].text).toContain('snapshot')
      expect(result.content[0].text).not.toContain('When you are done using the browser')
    })
});
});
