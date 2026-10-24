#!/usr/bin/env bun
/** Terminal entry point; commands and validation own their specific behavior. */
import { CliRpcClient } from './client.ts';
import { parseArgs } from './cli-args.ts';
import { printHelp } from './cli-help.ts';
import { cmdRun, cmdValidate } from './local-commands.ts';
import { cmdCancel, cmdInvoke, cmdListen, cmdSend } from './message-commands.ts';
import { cmdConnections, cmdHealth, cmdPing, cmdSessionCreate, cmdSessionDelete, cmdSessionMessages, cmdSessions, cmdSources, cmdVersions, cmdWorkspaces } from './resource-commands.ts';
import { err, out } from './terminal-output.ts';
export type { CliArgs } from './cli-args.ts';
export { parseArgs } from './cli-args.ts';
export { resolveApiKey, shouldSetupLlmConnection } from './llm-setup.ts';
export type { ValidateStep, ValidateContext } from './validation-types.ts';
export { getValidateSteps } from './validation-steps.ts';
export { runValidation } from './validation-runtime.ts';

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function main(argv: string[] = process.argv): Promise<void> {
  const args = parseArgs(argv)

  // Set custom CA before any WS connections
  if (args.tlsCa) {
    process.env.NODE_EXTRA_CA_CERTS = args.tlsCa
  }

  if (args.command === 'help' || args.command === '') {
    printHelp()
    return
  }

  if (args.command === 'version') {
    const pkg = await import('../package.json')
    out(pkg.version ?? pkg.default?.version ?? 'unknown', false)
    return
  }

  // run is self-contained — spawns its own server
  if (args.command === 'run') {
    await cmdRun(args)
    return
  }

  // validate can spawn its own server or use --url
  if (args.command === 'validate') {
    await cmdValidate(args)
    return
  }

  // All other commands need a server URL
  if (!args.url) {
    err('No server URL. Use --url <ws://...> or set $CRAFT_SERVER_URL')
    process.exit(1)
  }

  const client = new CliRpcClient(args.url, {
    token: args.token || undefined,
    workspaceId: args.workspace,
    requestTimeout: args.timeout,
    connectTimeout: args.timeout,
  })

  try {
    switch (args.command) {
      case 'ping':
        await cmdPing(client, args)
        break
      case 'health':
        await cmdHealth(client, args)
        break
      case 'versions':
        await cmdVersions(client, args)
        break
      case 'workspaces':
        await cmdWorkspaces(client, args)
        break
      case 'sessions':
        await cmdSessions(client, args)
        break
      case 'connections':
        await cmdConnections(client, args)
        break
      case 'sources':
        await cmdSources(client, args)
        break
      case 'session': {
        const subCmd = args.rest.shift()
        switch (subCmd) {
          case 'create':
            await cmdSessionCreate(client, args)
            break
          case 'messages':
            await cmdSessionMessages(client, args)
            break
          case 'delete':
            await cmdSessionDelete(client, args)
            break
          default:
            err(`Unknown session subcommand: ${subCmd}`)
            process.exit(1)
        }
        break
      }
      case 'send':
        await cmdSend(client, args)
        break // cmdSend calls process.exit
      case 'cancel':
        await cmdCancel(client, args)
        break
      case 'invoke':
        await cmdInvoke(client, args)
        break
      case 'listen':
        await cmdListen(client, args)
        break // never returns
      default:
        err(`Unknown command: ${args.command}`)
        printHelp()
        process.exit(1)
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    err(msg)
    process.exit(1)
  } finally {
    client.destroy()
  }
}

// Run if executed directly (not when imported by tests)
if (import.meta.main) {
  main()
}
