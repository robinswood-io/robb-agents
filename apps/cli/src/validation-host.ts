import { getProviderDisplayName, resolveApiKey, shouldSetupLlmConnection } from './llm-setup.ts';
import type { CliWorkspace } from './rpc-shapes.ts';
import { requireListResponse } from './rpc-shapes.ts';
import type { ValidateSession, ValidateStep } from './validation-types.ts';

export function getHostValidationSteps(): ValidateStep[] {
  return [
{
      name: 'Connect + handshake',
      fn: async (client) => {
        const start = performance.now()
        const clientId = await client.connect()
        const ms = Math.round(performance.now() - start)
        return `clientId: ${clientId}, ${ms}ms`
      },
    },
{
      name: 'credentials:healthCheck',
      fn: async (client) => {
        const r = (await client.invoke('credentials:healthCheck'))
        return JSON.stringify(r)
      },
    },
{
      name: 'system:versions',
      fn: async (client) => {
        const r = (await client.invoke('system:versions')) as { node?: string }
        return r?.node ? `node=${r.node}` : JSON.stringify(r)
      },
    },
{
      name: 'system:homeDir',
      fn: async (client) => {
        const r = await client.invoke('system:homeDir')
        return String(r)
      },
    },
{
      name: 'workspaces:get',
      fn: async (client, ctx) => {
        // Register workspace from --workspace-dir if provided
        if (ctx.workspaceDir) {
          const { resolve } = await import('path')
          const absPath = resolve(ctx.workspaceDir)
          const ws = (await client.invoke('workspaces:create', absPath, 'ci-workspace')) as { id: string }
          ctx.workspaceId = ws.id
          ctx.workspaceRootPath = absPath
          await client.invoke('window:switchWorkspace', ws.id)
          return `registered: ${absPath}`
        }
        const r = (await client.invoke('workspaces:get')) as CliWorkspace[]
        if (r?.length > 0) {
          ctx.workspaceId = r[0].id
          ctx.workspaceRootPath = r[0].rootPath ?? r[0].path
          // Bind this client to the workspace so push events (e.g. session:event)
          // routed { to: 'workspace' } reach us.
          await client.invoke('window:switchWorkspace', r[0].id)
          return `${r.length} workspaces`
        }
        // Auto-bootstrap a temp workspace for CI environments
        const { mkdtemp } = await import('fs/promises')
        const { tmpdir } = await import('os')
        const tmpDir = await mkdtemp(`${tmpdir()}/craft-validate-`)
        const ws = (await client.invoke('workspaces:create', tmpDir, 'validate-workspace')) as { id: string }
        ctx.workspaceId = ws.id
        ctx.workspaceRootPath = tmpDir
        ctx.createdWorkspace = true
        await client.invoke('window:switchWorkspace', ws.id)
        return `0 found → created temp workspace`
      },
    },
{
      name: 'sessions:get',
      fn: async (client, ctx) => {
        if (!ctx.workspaceId) return 'skipped (no workspace)'
        const r = (await client.invoke('sessions:get', ctx.workspaceId)) as ValidateSession[]
        return `${r?.length ?? 0} sessions`
      },
    },
{
      name: 'LLM_Connection:list',
      fn: async (client, ctx) => {
        const r = requireListResponse((await client.invoke('LLM_Connection:list')))

        // Custom endpoint: always create/update when --base-url is provided
        if (ctx.baseUrl) {
          const provider = ctx.provider || 'anthropic'
          let key = ''
          try {
            key = resolveApiKey(provider, ctx.apiKey || '')
          } catch (error) {
            return `0 connections (${error instanceof Error ? error.message : 'missing API key'})`
          }
          const slug = `${provider}-cli`
          const isAnthropicApi = provider === 'anthropic'
          await client.invoke('LLM_Connection:save', {
            slug,
            name: `${getProviderDisplayName(provider)} (Custom Endpoint)`,
            providerType: 'pi_compat',
            authType: 'api_key_with_endpoint',
            createdAt: Date.now(),
          })
          const result = await client.invoke('settings:setupLlmConnection', {
            slug,
            credential: key,
            baseUrl: ctx.baseUrl,
            customEndpoint: { api: isAnthropicApi ? 'anthropic-messages' : 'openai-completions' },
            defaultModel: isAnthropicApi ? 'claude-sonnet-4-6' : 'gpt-4o',
          }) as { success: boolean; error?: string }
          if (!result?.success) return `setup failed: ${result?.error ?? 'unknown'}`
          await client.invoke('LLM_Connection:setDefault', slug)
          return `${r?.length ?? 0} existing + custom endpoint via ${ctx.baseUrl}`
        }

        // Amazon Bedrock: IAM credential setup
        if (ctx.provider === 'amazon-bedrock') {
          const accessKeyId = process.env.AWS_ACCESS_KEY_ID
          const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY
          const region = process.env.AWS_REGION || 'us-east-1'
          const sessionToken = process.env.AWS_SESSION_TOKEN
          if (!accessKeyId || !secretAccessKey) {
            return '0 connections (missing AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY)'
          }
          const slug = 'amazon-bedrock-cli'
          await client.invoke('LLM_Connection:save', {
            slug,
            name: 'Amazon Bedrock',
            providerType: 'pi',
            authType: 'iam_credentials',
            piAuthProvider: 'amazon-bedrock',
            createdAt: Date.now(),
          })
          const result = await client.invoke('settings:setupLlmConnection', {
            slug,
            piAuthProvider: 'amazon-bedrock',
            bedrockAuthMethod: 'iam_credentials',
            iamCredentials: { accessKeyId, secretAccessKey, sessionToken },
            awsRegion: region,
          }) as { success: boolean; error?: string }
          if (!result?.success) return `setup failed: ${result?.error ?? 'unknown'}`
          await client.invoke('LLM_Connection:setDefault', slug)
          return `${r?.length ?? 0} existing + Bedrock IAM (${region})`
        }

        const provider = ctx.provider || 'anthropic'
        if (!shouldSetupLlmConnection(r?.length ?? 0, { provider, baseUrl: ctx.baseUrl ?? '' })) {
          return `${r.length} connections`
        }
        // Auto-setup from env / flags for the requested provider.
        let key = ''
        try {
          key = resolveApiKey(provider, ctx.apiKey || '')
        } catch (error) {
          return `0 connections (${error instanceof Error ? error.message : 'missing API key'})`
        }
        const slug = `${provider}-cli`
        const providerType = provider === 'anthropic' ? 'anthropic' : 'pi'
        const authType = 'api_key'
        await client.invoke('LLM_Connection:save', {
          slug,
          name: getProviderDisplayName(provider),
          providerType,
          authType,
          createdAt: Date.now(),
        })
        const setupPayload = provider === 'anthropic'
          ? { slug, credential: key }
          : { slug, credential: key, piAuthProvider: provider }
        const result = await client.invoke('settings:setupLlmConnection', setupPayload) as { success: boolean; error?: string }
        if (!result?.success) return `setup failed: ${result?.error ?? 'unknown'}`
        await client.invoke('LLM_Connection:setDefault', slug)
        return `0 found → created ${provider} connection`
      },
    },
{
      name: 'sources:get',
      fn: async (client, ctx) => {
        if (!ctx.workspaceId) return 'skipped (no workspace)'
        const r = requireListResponse((await client.invoke('sources:get', ctx.workspaceId)))
        return `${r?.length ?? 0} sources`
      },
    }
  ]
}
