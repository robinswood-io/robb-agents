import { waitForSendEvents } from './validation-events.ts';
import type { ValidateLabel, ValidateMessagesResponse, ValidateSession, ValidateStep } from './validation-types.ts';

export function getSessionValidationSteps(): ValidateStep[] {
  return [
{
      name: 'sessions:create',
      fn: async (client, ctx) => {
        if (!ctx.workspaceId) return 'skipped (no workspace)'
        const name = `__cli-validate-${Date.now()}`
        const r = (await client.invoke('sessions:create', ctx.workspaceId, {
          name,
          permissionMode: 'allow-all',
        })) as { id: string }
        ctx.createdSessionId = r?.id
        return ctx.createdSessionId ?? 'created'
      },
    },
{
      name: 'sessions:getMessages',
      fn: async (client, ctx) => {
        if (!ctx.createdSessionId) return 'skipped (no session)'
        await client.invoke('sessions:getMessages', ctx.createdSessionId)
        return 'session readable'
      },
    },
{
      name: 'send message + stream',
      fn: async (client, ctx) => {
        if (!ctx.createdSessionId) return 'skipped (no session)'
        return await waitForSendEvents(client, ctx.createdSessionId,
          'Reply with exactly: VALIDATION_OK', 60_000, false, undefined, ctx.onEvent)
      },
    },
{
      name: 'send message + tool use',
      fn: async (client, ctx) => {
        if (!ctx.createdSessionId) return 'skipped (no session)'
        return await waitForSendEvents(client, ctx.createdSessionId,
          'Use the Bash tool to run: echo TOOL_VALIDATION_OK', 90_000, true, undefined, ctx.onEvent)
      },
    },
// ----- Session tool validation (guards against #511 regression) -----
    {
      name: 'labels:create (e2e-test)',
      fn: async (client, ctx) => {
        if (!ctx.workspaceId) return 'skipped (no workspace)'
        const r = (await client.invoke('labels:create', ctx.workspaceId, {
          name: 'e2e-test',
          color: 'gray',
        })) as ValidateLabel
        ctx.e2eTestLabelId = r?.id
        return `label created: ${r?.id}`
      },
    },
{
      name: 'session-tools:set_session_labels',
      fn: async (client, ctx) => {
        if (!ctx.createdSessionId) return 'skipped (no session)'
        if (!ctx.e2eTestLabelId) return 'skipped (no e2e-test label)'
        const result = await waitForSendEvents(client, ctx.createdSessionId,
          'Use the set_session_labels tool to set labels: ["e2e-test"] on the current session. Do NOT use any other tool.',
          90_000, true, undefined, ctx.onEvent, 'set_session_labels')
        // Verify labels were actually applied
        const sessions = (await client.invoke('sessions:get', ctx.workspaceId)) as ValidateSession[]
        const session = sessions?.find((s) => s.id === ctx.createdSessionId)
        const labels = session?.labels ?? session?.labelIds ?? []
        if (!labels.length) throw new Error('Labels not applied to session')
        return `${result} — labels verified: ${JSON.stringify(labels)}`
      },
    },
{
      name: 'session-tools:get_session_info',
      fn: async (client, ctx) => {
        if (!ctx.createdSessionId) return 'skipped (no session)'
        return await waitForSendEvents(client, ctx.createdSessionId,
          'Use the get_session_info tool to get info about the current session. Do NOT use any other tool.',
          90_000, true, undefined, ctx.onEvent, 'get_session_info')
      },
    },
{
      name: 'session-tools:list_sessions',
      fn: async (client, ctx) => {
        if (!ctx.createdSessionId) return 'skipped (no session)'
        return await waitForSendEvents(client, ctx.createdSessionId,
          'Use the list_sessions tool to list all sessions. Do NOT use any other tool.',
          90_000, true, undefined, ctx.onEvent, 'list_sessions')
      },
    },
// ----- Session branching -----
    {
      name: 'sessions:branch',
      fn: async (client, ctx) => {
        if (!ctx.createdSessionId || !ctx.workspaceId) return 'skipped (no session)'
        const r = (await client.invoke('sessions:getMessages', ctx.createdSessionId)) as ValidateMessagesResponse
        const messages = r?.messages ?? r?.conversation ?? []
        const firstAssistant = messages.find((m) => m.role === 'assistant')
        if (!firstAssistant?.id) throw new Error('No assistant message found to branch from')
        const branch = (await client.invoke('sessions:create', ctx.workspaceId, {
          name: `__cli-validate-branch-${Date.now()}`,
          permissionMode: 'allow-all',
          branchFromSessionId: ctx.createdSessionId,
          branchFromMessageId: firstAssistant.id,
        })) as { id: string }
        ctx.branchedSessionId = branch?.id
        return `branched at message ${firstAssistant.id} → session ${branch?.id}`
      },
    },
{
      name: 'sessions:branch verify',
      fn: async (client, ctx) => {
        if (!ctx.branchedSessionId) return 'skipped (no branch)'
        const r = (await client.invoke('sessions:getMessages', ctx.branchedSessionId)) as ValidateMessagesResponse
        const messages = r?.messages ?? r?.conversation ?? []
        const hasAssistant = messages.some((m) => m.role === 'assistant')
        if (!hasAssistant) throw new Error('Branch missing assistant message')
        const origR = (await client.invoke('sessions:getMessages', ctx.createdSessionId!)) as ValidateMessagesResponse
        const origMessages = origR?.messages ?? origR?.conversation ?? []
        if (messages.length >= origMessages.length) {
          throw new Error(`Branch has ${messages.length} messages, expected fewer than original (${origMessages.length})`)
        }
        return `branch has ${messages.length} messages (original has ${origMessages.length})`
      },
    },
{
      name: 'sessions:branch send',
      fn: async (client, ctx) => {
        if (!ctx.branchedSessionId) return 'skipped (no branch)'
        return await waitForSendEvents(client, ctx.branchedSessionId,
          'Reply with exactly: BRANCH_OK', 60_000, false, undefined, ctx.onEvent)
      },
    }
  ]
}
