import { CliRpcClient } from './client.ts';
import type { CliArgs } from './cli-args.ts';
import { err, out } from './terminal-output.ts';

/**
 * Read prompt text from positional args + stdin.
 * If there are positional words, they become the base message.
 * Reads stdin when: --stdin flag is present, or no message and stdin is piped (not a TTY).
 */
export async function readPrompt(words: string[], restArgs?: string[]): Promise<string> {
  let message = words.join(' ')

  const wantsStdin = restArgs?.includes('--stdin')
  const isTTY = typeof process.stdin.isTTY === 'boolean' ? process.stdin.isTTY : false
  if (wantsStdin || (!message && !isTTY)) {
    const chunks: string[] = []
    const reader = Bun.stdin.stream().getReader()
    const decoder = new TextDecoder()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(decoder.decode(value, { stream: true }))
    }
    const stdinText = chunks.join('')
    message = message ? `${message}\n${stdinText}` : stdinText
  }

  return message
}

/**
 * Subscribe to session events, send the message, stream output, wait for completion.
 * Returns the exit code (0 = success, 1 = error, 130 = interrupted).
 */
export async function sendAndStream(
  client: CliRpcClient,
  sessionId: string,
  message: string,
  args: CliArgs,
): Promise<number> {
  let exitCode = 0
  let finished = false
  const streamJson = args.outputFormat === 'stream-json'

  const unsub = client.on('session:event', (event: unknown) => {
    const ev = event as { type: string; sessionId: string; [key: string]: unknown }
    if (ev.sessionId !== sessionId) return

    if (streamJson) {
      process.stdout.write(JSON.stringify(ev) + '\n')
    }

    switch (ev.type) {
      case 'text_delta':
        if (!streamJson) process.stdout.write(ev.delta as string)
        break
      case 'tool_start':
        if (!streamJson) process.stdout.write(`\n[tool: ${ev.toolName}${ev.toolIntent ? ` — ${ev.toolIntent}` : ''}]\n`)
        break
      case 'tool_result': {
        if (!streamJson) {
          const result = String(ev.result ?? '')
          if (result.length > 200) {
            process.stdout.write(`${result.slice(0, 200)}...\n`)
          } else if (result) {
            process.stdout.write(`${result}\n`)
          }
        }
        break
      }
      case 'error':
        if (!streamJson) err(String(ev.error))
        exitCode = 1
        finished = true
        break
      case 'complete':
        if (!streamJson) process.stdout.write('\n')
        finished = true
        break
      case 'interrupted':
        if (!streamJson) process.stdout.write('\n[interrupted]\n')
        exitCode = 130
        finished = true
        break
    }
  })

  await client.invoke('sessions:sendMessage', sessionId, message)

  const deadline = Date.now() + args.sendTimeout
  while (!finished && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100))
  }

  unsub()

  if (!finished) {
    err('Send timeout — no completion event received')
    exitCode = 1
  }

  return exitCode
}

export async function cmdSend(client: CliRpcClient, args: CliArgs): Promise<void> {
  const sessionId = args.rest[0]
  if (!sessionId) {
    err('Usage: send <session-id> <message>')
    process.exit(1)
  }

  const message = await readPrompt(args.rest.slice(1), args.rest)
  if (!message.trim()) {
    err('No message provided')
    process.exit(1)
  }

  await client.connect()
  const exitCode = await sendAndStream(client, sessionId, message, args)
  client.destroy()
  process.exit(exitCode)
}

export async function cmdCancel(client: CliRpcClient, args: CliArgs): Promise<void> {
  const sessionId = args.rest[0]
  if (!sessionId) {
    err('Usage: cancel <session-id>')
    process.exit(1)
  }
  await client.connect()
  await client.invoke('sessions:cancel', sessionId)
  out(args.json ? { cancelled: sessionId } : `Cancelled: ${sessionId}`, args.json)
}

export async function cmdInvoke(client: CliRpcClient, args: CliArgs): Promise<void> {
  const channel = args.rest[0]
  if (!channel) {
    err('Usage: invoke <channel> [json-args...]')
    process.exit(1)
  }
  await client.connect()

  // Parse remaining args as JSON
  const invokeArgs: unknown[] = []
  for (let i = 1; i < args.rest.length; i++) {
    try {
      invokeArgs.push(JSON.parse(args.rest[i]))
    } catch {
      invokeArgs.push(args.rest[i])
    }
  }

  const result = await client.invoke(channel, ...invokeArgs)
  out(result, args.json)
}

export async function cmdListen(client: CliRpcClient, args: CliArgs): Promise<void> {
  const channel = args.rest[0]
  if (!channel) {
    err('Usage: listen <channel>')
    process.exit(1)
  }
  await client.connect()

  client.on(channel, (...eventArgs: unknown[]) => {
    out({ channel, args: eventArgs, timestamp: new Date().toISOString() }, true)
  })

  process.stdout.write(`Listening on ${channel} (Ctrl+C to stop)\n`)

  // Keep alive
  await new Promise(() => {
    // Never resolves — Ctrl+C exits
  })
}
