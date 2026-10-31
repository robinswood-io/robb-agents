import type { ValidateStep } from './validation-types.ts';

export function getCleanupValidationSteps(): ValidateStep[] {
  return [
{
      name: 'sessions:branch delete',
      fn: async (client, ctx) => {
        if (!ctx.branchedSessionId) return 'skipped (no branch)'
        await client.invoke('sessions:delete', ctx.branchedSessionId)
        const id = ctx.branchedSessionId
        ctx.branchedSessionId = undefined
        return `deleted branch session: ${id}`
      },
    },
{
      name: 'sources:delete',
      fn: async (client, ctx) => {
        if (!ctx.workspaceId || !ctx.createdSourceSlug) return 'skipped (no source)'
        await client.invoke('sources:delete', ctx.workspaceId, ctx.createdSourceSlug)
        return `deleted source: ${ctx.createdSourceSlug}`
      },
    },
{
      name: 'labels:delete (e2e-test)',
      fn: async (client, ctx) => {
        if (!ctx.workspaceId || !ctx.e2eTestLabelId) return 'skipped (no e2e-test label)'
        await client.invoke('labels:delete', ctx.workspaceId, ctx.e2eTestLabelId)
        return `deleted label: ${ctx.e2eTestLabelId}`
      },
    },
{
      name: 'sessions:delete',
      fn: async (client, ctx) => {
        if (!ctx.createdSessionId) return 'skipped (no session)'
        await client.invoke('sessions:delete', ctx.createdSessionId)
        return `deleted session: ${ctx.createdSessionId}`
      },
    },
{
      name: 'Disconnect',
      fn: async (client) => {
        client.destroy()
        return 'OK'
      },
    }
  ]
}
