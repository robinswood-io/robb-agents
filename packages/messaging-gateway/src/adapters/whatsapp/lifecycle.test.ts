/**
 * Tests for WhatsApp adapter send lifecycle:
 *
 *   1. A send that the worker never acknowledges resolves with a timeout
 *      error within `sendTimeoutMs` rather than hanging indefinitely.
 *   2. If the worker exits while sends are pending, those sends resolve
 *      with a "worker exited" error via `drainPending`.
 *   3. Calling `destroy()` while sends are pending resolves them with
 *      "adapter destroyed".
 *
 * We spawn a tiny fake worker via `node -e`. The fake reads NDJSON from
 * stdin and either stays silent (test 1, 3) or exits on first command
 * (test 2). Real-process behaviour exercises `proc.on('exit')` correctly.
 *
 * `sendTimeoutMs` is injected via config so we don't wait 30s per test.
 */
import { describe, it, expect, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WhatsAppAdapter, type WhatsAppConfig } from './index'
import { longRunningProcessSupervisor } from '@craft-agent/shared/processes'
import type { IncomingMessage, MessagingLogger, MessagingLogMeta } from '../../types'

const cleanups: Array<() => void> = []

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wa-adapter-test-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function writeWorkerScript(kind: 'silent' | 'die-on-command' | 'connected'): string {
  const dir = makeTmpDir()
  const path = join(dir, 'fake-worker.mjs')
  // Silent worker: read stdin, do nothing. No events, no exit.
  // Die-on-command: exit as soon as we see any NDJSON line on stdin.
  // Connected worker: announce a connected state and then stay silent.
  const silentBody = `
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', () => {})
    // Keep the process alive until the parent kills it.
    setInterval(() => {}, 60_000)
  `
  const dieBody = `
    let buf = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (c) => {
      buf += c
      if (buf.includes('\\n')) process.exit(1)
    })
    setInterval(() => {}, 60_000)
  `
  const connectedBody = `
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', () => {})
    process.stdout.write(JSON.stringify({ type: 'connected', jid: 'test@s.whatsapp.net', name: 'Tester' }) + '\\n')
    setInterval(() => {}, 60_000)
  `
  writeFileSync(
    path,
    kind === 'silent' ? silentBody : kind === 'die-on-command' ? dieBody : connectedBody,
  )
  return path
}

function writeStderrDiagnosticsWorker(): string {
  const dir = makeTmpDir()
  const path = join(dir, 'stderr-worker.mjs')
  const body = `
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', () => {})
    process.stderr.write([
      '[wa-worker] starting — build=2026-09-11T21:54:10.381Z sha=f35d5299a1b4 provenance=robb-wa-worker-git:f35d5299a1b4 selfChatMode=true pairingMode=qr',
      '[wa-worker] upsert type=append count=86',
      '[wa-worker] upsert skip: history (ts=100 cutoff=200)',
      '[wa-worker] upsert msg fromMe=true remoteJid=111@lid selfJid=222@s.whatsapp.net selfLid=111@lid bareRemote=111@lid msgKeys=imageMessage',
      '[wa-worker] upsert msg fromMe=false remoteJid=? selfJid=? selfLid=? bareRemote=? msgKeys=<no message>',
      '[wa-worker] upsert msg fromMe=false remoteJid=111@lid selfJid=222@s.whatsapp.net selfLid=111@lid bareRemote=111@lid msgKeys=',
      '[wa-worker] upsert skip: own_outbound',
      '[wa-worker] upsert emit: channelId=111@lid textLen=4 attachments=1',
      'Session error:Error: Bad MAC Error: Bad MAC',
      'failed to decrypt message',
      'at SessionCipher.decrypt (/app/node_modules/libsignal/index.js:42:7)',
      '[wa-worker] upsert skip: history (ts=100 cutoff=200) Bad MAC',
      '[wa-worker] upsert skip: own_outbound Bad MAC',
      '[wa-worker] upsert msg fromMe=true remoteJid=111@lid selfJid=222@s.whatsapp.net selfLid=111@lid bareRemote=111@lid msgKeys=imageMessage Bad MAC',
      '[wa-worker] upsert emit: channelId=111@lid textLen=4 attachments=1 Bad MAC',
    ].join('\\n') + '\\n')
    setInterval(() => {}, 60_000)
  `
  writeFileSync(path, body)
  return path
}

async function makeAdapter(opts: {
  workerScript: string
  sendTimeoutMs?: number
  workerIdleTimeoutMs?: number
  logger?: MessagingLogger
}): Promise<WhatsAppAdapter> {
  const adapter = new WhatsAppAdapter()
  const authDir = makeTmpDir()
  const cfg: WhatsAppConfig = {
    workerEntry: opts.workerScript,
    authStateDir: authDir,
    nodeBin: process.execPath,
    sendTimeoutMs: opts.sendTimeoutMs,
    workerIdleTimeoutMs: opts.workerIdleTimeoutMs,
    logger: opts.logger,
  }
  await adapter.initialize(cfg)
  return adapter
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition was not met')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function waitForConnected(adapter: WhatsAppAdapter): Promise<void> {
  const deadline = Date.now() + 1_000
  while (!adapter.isConnected()) {
    if (Date.now() > deadline) throw new Error('adapter did not connect')
    await new Promise((r) => setTimeout(r, 10))
  }
}

afterEach(async () => {
  longRunningProcessSupervisor.shutdown('test cleanup')
  for (const c of cleanups.splice(0)) {
    try { c() } catch { /* cleanup best-effort */ }
  }
})

describe('WhatsAppAdapter send lifecycle', () => {
  it('keeps bounded worker diagnostics at info while preserving real stderr warnings', async () => {
    const entries: Array<{ level: 'info' | 'warn' | 'error'; message: string; meta?: MessagingLogMeta }> = []
    const logger: MessagingLogger = {
      info: (message, meta) => entries.push({ level: 'info', message, meta }),
      warn: (message, meta) => entries.push({ level: 'warn', message, meta }),
      error: (message, meta) => entries.push({ level: 'error', message, meta }),
      child: () => logger,
    }
    const adapter = await makeAdapter({
      workerScript: writeStderrDiagnosticsWorker(),
      logger,
    })

    try {
      await waitFor(() => entries.filter((entry) => entry.meta?.event === 'whatsapp_worker_stderr').length === 15)
      const workerEntries = entries.filter((entry) => entry.meta?.event === 'whatsapp_worker_stderr')
      expect(workerEntries.filter((entry) => entry.level === 'info').map((entry) => entry.meta?.line)).toEqual([
        '[wa-worker] starting — build=2026-09-11T21:54:10.381Z sha=f35d5299a1b4 provenance=robb-wa-worker-git:f35d5299a1b4 selfChatMode=true pairingMode=qr',
        '[wa-worker] upsert type=append count=86',
        '[wa-worker] upsert skip: history (ts=100 cutoff=200)',
        '[wa-worker] upsert msg fromMe=true remoteJid=111@lid selfJid=222@s.whatsapp.net selfLid=111@lid bareRemote=111@lid msgKeys=imageMessage',
        '[wa-worker] upsert msg fromMe=false remoteJid=? selfJid=? selfLid=? bareRemote=? msgKeys=<no message>',
        '[wa-worker] upsert msg fromMe=false remoteJid=111@lid selfJid=222@s.whatsapp.net selfLid=111@lid bareRemote=111@lid msgKeys=',
        '[wa-worker] upsert skip: own_outbound',
        '[wa-worker] upsert emit: channelId=111@lid textLen=4 attachments=1',
      ])
      expect(workerEntries.filter((entry) => entry.level === 'warn').map((entry) => entry.meta?.line)).toEqual([
        'Session error:Error: Bad MAC Error: Bad MAC',
        'failed to decrypt message',
        'at SessionCipher.decrypt (/app/node_modules/libsignal/index.js:42:7)',
        '[wa-worker] upsert skip: history (ts=100 cutoff=200) Bad MAC',
        '[wa-worker] upsert skip: own_outbound Bad MAC',
        '[wa-worker] upsert msg fromMe=true remoteJid=111@lid selfJid=222@s.whatsapp.net selfLid=111@lid bareRemote=111@lid msgKeys=imageMessage Bad MAC',
        '[wa-worker] upsert emit: channelId=111@lid textLen=4 attachments=1 Bad MAC',
      ])
    } finally {
      await adapter.destroy()
    }
  })

  it('times out a pending send when the worker never responds', async () => {
    const adapter = await makeAdapter({
      workerScript: writeWorkerScript('silent'),
      sendTimeoutMs: 200,
    })
    try {
      await expect(adapter.sendText('chan-1', 'hello')).rejects.toThrow(
        /send timed out after 200ms/,
      )
    } finally {
      await adapter.destroy()
    }
  })

  it('drains pending sends when the worker exits', async () => {
    const adapter = await makeAdapter({
      workerScript: writeWorkerScript('die-on-command'),
      sendTimeoutMs: 5_000, // well beyond the expected exit time
    })
    try {
      await expect(adapter.sendText('chan-1', 'hello')).rejects.toThrow(
        /worker exited/,
      )
    } finally {
      // destroy is a no-op once the worker has already exited
      await adapter.destroy()
    }
  })

  it('drains pending sends when destroy() is called', async () => {
    const adapter = await makeAdapter({
      workerScript: writeWorkerScript('silent'),
      sendTimeoutMs: 10_000,
    })
    const pending = adapter.sendText('chan-1', 'hello')
    // Ensure the command is queued before destroy races the exit handler.
    await new Promise((r) => setTimeout(r, 50))
    await adapter.destroy()
    // The drain message can come from either `exit` (SIGKILL race) or the
    // defensive drain in destroy() — both are acceptable.
    await expect(pending).rejects.toThrow(
      /worker exited|adapter destroyed/,
    )
  })

  it('does not idle-terminate a connected worker', async () => {
    const adapter = await makeAdapter({
      workerScript: writeWorkerScript('connected'),
      workerIdleTimeoutMs: 5,
    })
    try {
      await waitForConnected(adapter)
      await new Promise((r) => setTimeout(r, 15))
      await longRunningProcessSupervisor.sweep()
      const hasRunningWorker = longRunningProcessSupervisor
        .snapshot()
        .processes
        .some((process) => process.ownerId === 'whatsapp' && process.status === 'running')
      expect(hasRunningWorker).toBe(true)
    } finally {
      await adapter.destroy()
    }
  })
})

// ---------------------------------------------------------------------------
// Regression for #719: incoming events with attachments must be translated
// to IncomingMessage with attachments[].localPath populated.
// ---------------------------------------------------------------------------

/**
 * Write a fake worker that emits a single `incoming` NDJSON event with
 * attachments after a short delay (so the parent has time to attach a
 * messageHandler), then stays alive on stdin.
 */
function writeIncomingAttachmentWorker(): string {
  const dir = makeTmpDir()
  const path = join(dir, 'incoming-worker.mjs')
  const body = `
    const ev = {
      type: 'incoming',
      channelId: 'chan-1',
      messageId: 'MID-7',
      senderId: 'sender-1',
      senderName: 'Alice',
      text: '',
      attachments: [
        {
          type: 'voice',
          fileName: 'voice.ogg',
          mimeType: 'audio/ogg',
          fileSize: 1234,
          localPath: '/tmp/fake-voice.ogg',
        },
      ],
      timestamp: 1700000000000,
    }
    setTimeout(() => {
      process.stdout.write(JSON.stringify(ev) + '\\n')
    }, 50)
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', () => {})
    setInterval(() => {}, 60_000)
  `
  writeFileSync(path, body)
  return path
}

describe('WhatsAppAdapter incoming attachment translation (#719)', () => {
  it('translates worker incoming attachments into IncomingMessage attachments', async () => {
    const adapter = await makeAdapter({
      workerScript: writeIncomingAttachmentWorker(),
    })

    const seen: IncomingMessage[] = []
    adapter.onMessage(async (msg) => {
      seen.push(msg)
    })

    // Wait for the fake worker to emit the event and the adapter to route it.
    await new Promise((r) => setTimeout(r, 250))

    try {
      expect(seen.length).toBe(1)
      const msg = seen[0]!
      expect(msg.platform).toBe('whatsapp')
      expect(msg.text).toBe('')
      expect(msg.attachments?.length).toBe(1)

      const att = msg.attachments![0]!
      expect(att.type).toBe('voice')
      expect(att.fileName).toBe('voice.ogg')
      expect(att.mimeType).toBe('audio/ogg')
      expect(att.fileSize).toBe(1234)
      expect(att.localPath).toBe('/tmp/fake-voice.ogg')
      // Adapter reuses messageId as fileId since WhatsApp has no separate
      // server-side file_id (unlike Telegram).
      expect(att.fileId).toBe('MID-7')
    } finally {
      await adapter.destroy()
    }
  })

  it('plain text messages still work (no attachments key on the IncomingMessage)', async () => {
    // Sanity regression: the non-media path must not be perturbed.
    const dir = makeTmpDir()
    const workerPath = join(dir, 'plain-text-worker.mjs')
    writeFileSync(
      workerPath,
      `
      const ev = {
        type: 'incoming',
        channelId: 'chan-1',
        messageId: 'MID-8',
        senderId: 'sender-1',
        text: 'hello',
        timestamp: 1700000000000,
      }
      setTimeout(() => {
        process.stdout.write(JSON.stringify(ev) + '\\n')
      }, 50)
      process.stdin.setEncoding('utf8')
      process.stdin.on('data', () => {})
      setInterval(() => {}, 60_000)
    `,
    )

    const adapter = await makeAdapter({ workerScript: workerPath })
    const seen: IncomingMessage[] = []
    adapter.onMessage(async (msg) => {
      seen.push(msg)
    })
    await new Promise((r) => setTimeout(r, 250))

    try {
      expect(seen.length).toBe(1)
      expect(seen[0]?.text).toBe('hello')
      expect(seen[0]?.attachments).toBeUndefined()
    } finally {
      await adapter.destroy()
    }
  })
})
