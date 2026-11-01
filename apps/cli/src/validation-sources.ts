import type { CliCreatedSource } from './rpc-shapes.ts';
import { waitForSendEvents } from './validation-events.ts';
import type { ValidateStep } from './validation-types.ts';

export function getSourceValidationSteps(): ValidateStep[] {
  return [
// ----- Source lifecycle -----
    {
      name: 'sources:create',
      fn: async (client, ctx) => {
        if (!ctx.workspaceId) return 'skipped (no workspace)'
        const r = (await client.invoke('sources:create', ctx.workspaceId, {
          name: 'Cat Facts',
          provider: 'catfact',
          type: 'api',
          api: { baseUrl: 'https://catfact.ninja', authType: 'none' },
          icon: '🐱',
        })) as CliCreatedSource
        ctx.createdSourceSlug = r?.slug
        return ctx.createdSourceSlug ? `slug=${ctx.createdSourceSlug}` : JSON.stringify(r)
      },
    },
{
      name: 'send + source mention',
      fn: async (client, ctx) => {
        if (!ctx.createdSessionId || !ctx.createdSourceSlug) return 'skipped (no session or source)'
        // Enable the source on the session
        await client.invoke('sessions:command', ctx.createdSessionId, {
          type: 'setSources',
          sourceSlugs: [ctx.createdSourceSlug],
        })
        return await waitForSendEvents(client, ctx.createdSessionId,
          `[source:${ctx.createdSourceSlug}] Get me a cat fact`, 90_000, false, undefined, ctx.onEvent)
      },
    },
// ----- MCP source validation (pre-committed in .github/agents/sources/) -----
    {
      name: 'mcp:craft-public (auth:none)',
      fn: async (client, ctx) => {
        if (!ctx.createdSessionId) return 'skipped (no session)'
        // Enable the pre-committed craft-public MCP source on the session
        const enableSlugs = [ctx.createdSourceSlug, 'craft-public'].filter(Boolean) as string[]
        await client.invoke('sessions:command', ctx.createdSessionId, {
          type: 'setSources',
          sourceSlugs: enableSlugs,
        })
        return await waitForSendEvents(client, ctx.createdSessionId,
          `[source:craft-public] List the documents under the "CraftAgents E2E Test" folder inside the "CraftAgents" folder. Just list their names.`,
          180_000, false, undefined, ctx.onEvent)
      },
    },
{
      name: 'mcp:stitch-mcp (header-auth)',
      fn: async (client, ctx) => {
        if (!ctx.createdSessionId) return 'skipped (no session)'
        const apiKey = process.env["STITCH_API_KEY"]
        if (!apiKey) return 'skipped (no STITCH_API_KEY)'
        // Inject credential into store (multi-header JSON format, same as API headerNames)
        await client.invoke('sources:saveCredentials', ctx.workspaceId, 'stitch-mcp', JSON.stringify({ 'X-Goog-Api-Key': apiKey }))
        // Enable stitch-mcp + existing sources on session
        const enableSlugs = [ctx.createdSourceSlug, 'craft-public', 'stitch-mcp'].filter(Boolean) as string[]
        await client.invoke('sessions:command', ctx.createdSessionId, {
          type: 'setSources',
          sourceSlugs: enableSlugs,
        })
        return await waitForSendEvents(client, ctx.createdSessionId,
          `Use the source_test tool to test the stitch-mcp source. Report the result.`,
          90_000, false, undefined, ctx.onEvent)
      },
    }
  ]
}
