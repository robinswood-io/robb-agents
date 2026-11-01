/**
 * craft-cli — Terminal client for Craft Agent server.
 *
 * Connects over WebSocket (ws:// or wss://) to a running Craft Agent server
 * and provides commands for listing resources, managing sessions, sending
 * messages with real-time streaming, and validating server health.
 */
import { resolve } from 'path';
import { CliRpcClient } from './client.ts';
import type { CliArgs } from './cli-args.ts';
import { setupLlmConnection, shouldSetupLlmConnection } from './llm-setup.ts';
import { readPrompt, sendAndStream } from './message-commands.ts';
import { requireListResponse } from './rpc-shapes.ts';
import { err } from './terminal-output.ts';
import { runValidation } from './validation-runtime.ts';
import { resolveWorkspace } from './workspace-selection.ts';

interface LocalServer {
  client: CliRpcClient
  stop: () => Promise<void>
}

async function spawnLocalServer(args: CliArgs, opts?: { quiet?: boolean }): Promise<LocalServer> {
  const { spawnServer } = await import('./server-spawner.ts')
  process.stderr.write('Starting server...\n')
  const server = await spawnServer({
    serverEntry: args.serverEntry,
    startupTimeout: args.timeout > 30_000 ? args.timeout : 30_000,
    quiet: opts?.quiet,
  })
  process.stderr.write(`Server ready: ${server.url}\n`)
  const client = new CliRpcClient(server.url, {
    token: server.token,
    requestTimeout: args.timeout,
  })
  return { client, stop: server.stop }
}

export async function cmdRun(args: CliArgs): Promise<void> {
  // Prompt = all positional args (no session ID needed, unlike send)
  const message = await readPrompt(args.rest, args.rest)
  if (!message.trim()) {
    err('No prompt provided. Usage: run <message>')
    process.exit(1)
  }

  const server = await spawnLocalServer(args)

  let client: CliRpcClient | undefined = server.client
  let sessionId: string | undefined

  const cleanup = async () => {
    if (sessionId && client?.isConnected && !args.noCleanup) {
      await client.invoke('sessions:delete', sessionId).catch(() => {})
    }
    client?.destroy()
    await server.stop()
  }

  // Signal handling — cancel + clean up on SIGINT/SIGTERM
  const onSignal = async () => {
    if (sessionId && client?.isConnected) {
      await client.invoke('sessions:cancel', sessionId).catch(() => {})
    }
    await cleanup()
    process.exit(130)
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)

  try {
    await client.connect()

    // Bootstrap workspace from directory if specified
    let bootstrappedWorkspaceId: string | undefined
    if (args.workspaceDir) {
      const absPath = resolve(args.workspaceDir)
      const ws = (await client.invoke('workspaces:create', absPath, 'ci-workspace')) as { id: string }
      bootstrappedWorkspaceId = ws.id
      process.stderr.write(`Workspace registered: ${absPath}\n`)
    }

    // Auto-setup LLM connection from flags / env vars.
    // When --base-url is provided, always create the custom endpoint connection
    // (even if other connections exist) so the session routes through it.
    const connections = requireListResponse((await client.invoke('LLM_Connection:list')))
    let connectionSlug: string | undefined
    if (shouldSetupLlmConnection(connections?.length ?? 0, args)) {
      const result = await setupLlmConnection(client, args)
      connectionSlug = result.connectionSlug
    }

    const workspaceId = bootstrappedWorkspaceId
      ?? await resolveWorkspace(client, args.workspace)
    if (bootstrappedWorkspaceId) {
      await client.invoke('window:switchWorkspace', bootstrappedWorkspaceId).catch(() => {})
    }
    if (!workspaceId) {
      err('No workspace found on server')
      process.exit(1)
    }

    const session = (await client.invoke('sessions:create', workspaceId, {
      permissionMode: args.mode || 'allow-all',
      enabledSourceSlugs: args.sources.length > 0 ? args.sources : undefined,
    })) as { id: string }
    sessionId = session.id

    if (args.model) {
      await client.invoke('session:setModel', sessionId, workspaceId, args.model, connectionSlug)
    }

    const exitCode = await sendAndStream(client, sessionId, message, args)
    await cleanup()
    process.exit(exitCode)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    err(msg)
    await cleanup()
    process.exit(1)
  } finally {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
  }
}

export async function cmdValidate(args: CliArgs): Promise<void> {
  let server: LocalServer | undefined
  let client: CliRpcClient

  // Use a generous timeout for validation steps — source creation and MCP
  // server startup can be slow on Windows.
  const validateArgs = { ...args, timeout: Math.max(args.timeout, 30_000) }

  if (args.url) {
    client = new CliRpcClient(args.url, {
      token: args.token || undefined,
      requestTimeout: validateArgs.timeout,
      connectTimeout: validateArgs.timeout,
    })
  } else {
    server = await spawnLocalServer(validateArgs, { quiet: !args.verbose })
    client = server.client
  }

  try {
    const exitCode = await runValidation(client, args.json, args.noSpinner, args.workspaceDir, {
      baseUrl: args.baseUrl,
      apiKey: args.apiKey,
      provider: args.provider,
    })
    client.destroy()
    if (server) await server.stop()
    process.exit(exitCode)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    err(msg)
    client.destroy()
    if (server) await server.stop()
    process.exit(1)
  }
}
