import type { Message } from '@craft-agent/core/types'
import { turnProgressFingerprint } from './objective-contract'

/** Additional reserve guard only; completion criteria and their evidence stay unchanged. */
export function explicitRetryProgressFingerprint(messages: Message[], objectiveUserMessageId: string): string {
  const captures = new Set<string>()
  const objectiveIndex = messages.findIndex(message => message.role === 'user' && message.id === objectiveUserMessageId)
  const withoutCaptureChurn = messages.filter((message, index) => {
    if (index <= objectiveIndex) return true
    if (message.role !== 'tool') return true
    const output = message.toolResult ?? ''
    if (/^\s*(?:\[ERROR\]|Error:)/.test(output)) return false
    const command = message.toolInput?.command
    const verb = Array.isArray(command) && command.every(arg => typeof arg === 'string')
      ? command[0] : typeof command === 'string' ? command.trim().split(/\s+/, 1)[0] : undefined
    const capture = /^(?:mcp__session__|session__)?browser_tool$/.test(message.toolName ?? '')
      && typeof verb === 'string' && /^screenshot(?:-region)?$/i.test(verb)
    if (capture) {
      // Exact persisted Pi transport format, not a filename heuristic. A user
      // image or an unrelated PNG remains eligible as ordinary evidence.
      for (const match of output.slice(0, 64_000).matchAll(/^Saved screenshot: (.{1,4096})$/gm)) {
        captures.add(match[1]!.trim())
      }
      return false
    }
    if (/^(?:Read|read_file)$/.test(message.toolName ?? '')) {
      const path = message.toolInput?.file_path ?? message.toolInput?.path
      if (typeof path === 'string' && captures.has(path)) return false
    }
    return true
  })
  return turnProgressFingerprint(withoutCaptureChurn, objectiveUserMessageId)
}
