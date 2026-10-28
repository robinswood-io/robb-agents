import { CliRpcClient } from './client.ts';
import type { ValidateContext } from './validation-types.ts';

/**
 * Send a message and wait for streaming events.
 * Returns a summary of received event types.
 * If expectTool is true, validates that tool_start + tool_result events arrived.
 */
export async function waitForSendEvents(
  client: CliRpcClient,
  sessionId: string,
  message: string,
  timeoutMs: number,
  expectTool: boolean,
  sendOptions?: Record<string, unknown>,
  onEvent?: (ev: { type: string; [key: string]: unknown }) => void,
  expectToolName?: string,
): Promise<string> {
  const seen = new Set<string>()
  let textChunks = 0
  let toolName = ''
  let finished = false

  const unsub = client.on('session:event', (event: unknown) => {
    const ev = event as { type: string; sessionId: string; [key: string]: unknown }
    if (ev.sessionId !== sessionId) return

    seen.add(ev.type)
    if (ev.type === 'text_delta') textChunks++
    if (ev.type === 'tool_start') toolName = String(ev["toolName"] ?? '')
    if (ev.type === 'complete' || ev.type === 'error' || ev.type === 'interrupted') {
      finished = true
    }
    onEvent?.(ev)
  })

  try {
    await client.invoke('sessions:sendMessage', sessionId, message,
      undefined, undefined, sendOptions)

    const deadline = Date.now() + timeoutMs
    while (!finished && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100))
    }

    if (!finished) throw new Error('Timed out waiting for completion')

    // Only treat as failure if error was the terminal event (no complete followed)
    if (seen.has('error') && !seen.has('complete')) throw new Error('Session returned an error event')

    if (expectTool) {
      if (!seen.has('tool_start')) throw new Error('No tool_start event received')
      if (!seen.has('tool_result')) throw new Error('No tool_result event received')
      if (expectToolName && !toolName.includes(expectToolName)) {
        throw new Error(`Expected tool containing "${expectToolName}", got "${toolName}"`)
      }
      return `tool=${toolName}, ${textChunks} text deltas, events: ${[...seen].join(', ')}`
    }

    if (!seen.has('text_delta')) throw new Error('No text_delta events received')
    return `${textChunks} text deltas, events: ${[...seen].join(', ')}`
  } finally {
    unsub()
  }
}

/**
 * Clean up automation test artifacts (config files, session, label).
 * Shared between the automation:cleanup test step and runValidation error recovery.
 */
export async function cleanupAutomationArtifacts(
  client: CliRpcClient,
  ctx: ValidateContext,
): Promise<string[]> {
  const cleaned: string[] = []

  // Restore or remove automation config files
  if (ctx.workspaceRootPath && ctx.createdAutomation) {
    try {
      const { writeFile, unlink } = await import('fs/promises')
      const configPath = `${ctx.workspaceRootPath}/automations.json`
      const historyPath = `${ctx.workspaceRootPath}/automations-history.jsonl`
      if (ctx.automationsJsonBackup != null) {
        await writeFile(configPath, ctx.automationsJsonBackup).catch(() => {})
        cleaned.push('automations.json (restored)')
      } else {
        await unlink(configPath).catch(() => {})
        cleaned.push('automations.json (removed)')
      }
      if (ctx.automationsHistoryBackup != null) {
        await writeFile(historyPath, ctx.automationsHistoryBackup).catch(() => {})
      } else {
        await unlink(historyPath).catch(() => {})
      }
      ctx.createdAutomation = false
    } catch { /* best effort */ }
  }

  // Delete automation-triggered sessions
  for (const key of ['automationTestSessionId', 'automationBlockedSessionId'] as const) {
    const id = ctx[key]
    if (!id || !client.isConnected) continue
    try {
      await client.invoke('sessions:delete', id)
      cleaned.push(`session ${id}`)
      ctx[key] = undefined
    } catch { /* best effort */ }
  }

  // Delete test label
  if (ctx.workspaceId && ctx.createdLabelId && client.isConnected) {
    try {
      await client.invoke('labels:delete', ctx.workspaceId, ctx.createdLabelId)
      cleaned.push(`label ${ctx.createdLabelId}`)
      ctx.createdLabelId = undefined
    } catch { /* best effort */ }
  }

  return cleaned
}
