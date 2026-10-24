import { CliRpcClient } from './client.ts';
import type { CliArgs } from './cli-args.ts';
import type { CliWorkspace } from './rpc-shapes.ts';
import { err, out } from './terminal-output.ts';
import type { ValidateSession } from './validation-types.ts';
import { resolveWorkspace } from './workspace-selection.ts';

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export async function cmdPing(client: CliRpcClient, args: CliArgs): Promise<void> {
  const start = performance.now()
  const clientId = await client.connect()
  const latency = Math.round(performance.now() - start)
  out(
    args.json
      ? { clientId, latencyMs: latency }
      : `Connected: clientId=${clientId} latency=${latency}ms`,
    args.json,
  )
}

export async function cmdHealth(client: CliRpcClient, args: CliArgs): Promise<void> {
  await client.connect()
  const result = await client.invoke('credentials:healthCheck')
  out(result, args.json)
}

export async function cmdVersions(client: CliRpcClient, args: CliArgs): Promise<void> {
  await client.connect()
  const result = await client.invoke('system:versions')
  out(result, args.json)
}

export async function cmdWorkspaces(client: CliRpcClient, args: CliArgs): Promise<void> {
  await client.connect()
  const result = (await client.invoke('workspaces:get')) as CliWorkspace[]
  if (args.json) {
    out(result, true)
  } else {
    if (!result?.length) {
      out('No workspaces found', false)
      return
    }
    for (const ws of result) {
      out(`${ws.id}  ${ws.name ?? '(unnamed)'}  ${ws.path ?? ''}`, false)
    }
  }
}

export async function cmdSessions(client: CliRpcClient, args: CliArgs): Promise<void> {
  await client.connect()
  const workspaceId = await resolveWorkspace(client, args.workspace)
  if (!workspaceId) {
    err('No workspace available. Use --workspace <id>')
    process.exit(1)
  }
  const result = (await client.invoke('sessions:get', workspaceId)) as ValidateSession[]
  if (args.json) {
    out(result, true)
  } else {
    if (!result?.length) {
      out('No sessions found', false)
      return
    }
    for (const s of result) {
      const name = s.name ?? '(unnamed)'
      const preview = s.preview ? `  ${s.preview.slice(0, 60)}` : ''
      const status = s.isProcessing ? ' [processing]' : ''
      out(`${s.id}  ${name}${preview}${status}`, false)
    }
  }
}

export async function cmdConnections(client: CliRpcClient, args: CliArgs): Promise<void> {
  await client.connect()
  const result = await client.invoke('LLM_Connection:list')
  out(result, args.json)
}

export async function cmdSources(client: CliRpcClient, args: CliArgs): Promise<void> {
  await client.connect()
  const workspaceId = await resolveWorkspace(client, args.workspace)
  if (!workspaceId) {
    err('No workspace available. Use --workspace <id>')
    process.exit(1)
  }
  const result = await client.invoke('sources:get', workspaceId)
  out(result, args.json)
}

export async function cmdSessionCreate(client: CliRpcClient, args: CliArgs): Promise<void> {
  await client.connect()
  const workspaceId = await resolveWorkspace(client, args.workspace)
  if (!workspaceId) {
    err('No workspace available. Use --workspace <id>')
    process.exit(1)
  }

  // Parse sub-args: --name <n>
  let name: string | undefined
  for (let i = 0; i < args.rest.length; i++) {
    if (args.rest[i] === '--name') name = args.rest[++i]
  }

  const opts: Record<string, unknown> = {}
  if (name) opts.name = name
  if (args.mode) opts.permissionMode = args.mode

  const result = await client.invoke('sessions:create', workspaceId, opts)
  out(result, args.json)
}

export async function cmdSessionMessages(client: CliRpcClient, args: CliArgs): Promise<void> {
  const sessionId = args.rest[0]
  if (!sessionId) {
    err('Usage: session messages <session-id>')
    process.exit(1)
  }
  await client.connect()
  const result = await client.invoke('sessions:getMessages', sessionId)
  out(result, args.json)
}

export async function cmdSessionDelete(client: CliRpcClient, args: CliArgs): Promise<void> {
  const sessionId = args.rest[0]
  if (!sessionId) {
    err('Usage: session delete <session-id>')
    process.exit(1)
  }
  await client.connect()
  await client.invoke('sessions:delete', sessionId)
  out(args.json ? { deleted: sessionId } : `Deleted session: ${sessionId}`, args.json)
}
