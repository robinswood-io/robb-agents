import { CliRpcClient } from './client.ts';
import { cliMessageText } from './rpc-shapes.ts';
import { _useColor, c, createSpinner, out } from './terminal-output.ts';
import { cleanupAutomationArtifacts } from './validation-events.ts';
import { getValidateSteps } from './validation-steps.ts';
import type { ValidateContext } from './validation-types.ts';

export async function runValidation(
  client: CliRpcClient,
  jsonMode: boolean,
  noSpinner?: boolean,
  workspaceDir?: string,
  validateOptions?: { baseUrl?: string; apiKey?: string; provider?: string },
): Promise<number> {
  const steps = getValidateSteps()
  const total = steps.length
  const ctx: ValidateContext = {
    workspaceDir,
    baseUrl: validateOptions?.baseUrl,
    apiKey: validateOptions?.apiKey,
    provider: validateOptions?.provider,
  }
  let passed = 0
  let failed = 0
  const results: Array<{ step: string; status: string; detail: string; elapsed: number }> = []
  const totalStart = performance.now()

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    const num = `[${i + 1}/${total}]`
    const plainLen = num.length + 1 + step.name.length

    // Spinner + live event printer
    // Spinner keeps running until the agent produces real output (text_delta/tool_start).
    // Early events (user_message, connection_changed, usage_update) are buffered or ignored
    // so the spinner stays visible while the agent is thinking.
    let spinner: { stop(): void } | undefined
    if (!jsonMode) {
      let headerPrinted = false
      let accText = ''
      let textFlushed = false
      let bufferedPrompt = ''

      if (_useColor && !noSpinner) {
        spinner = createSpinner(`${c.cyan(num)} ${step.name}`)
      }

      const flushText = () => {
        if (textFlushed || !accText) return
        const clean = accText.replace(/\n/g, ' ').trim()
        if (!clean) return
        const display = clean.length > 120 ? clean.slice(0, 120) + '…' : clean
        process.stdout.write(`    ${c.dim('↳')} ${c.yellow(display)}\n`)
        textFlushed = true
      }

      const ensureHeader = () => {
        if (headerPrinted) return
        spinner?.stop()
        process.stdout.write(`${c.cyan(num)} ${step.name}\n`)
        if (bufferedPrompt) {
          process.stdout.write(`    ${c.dim('→')} ${c.blue(`"${bufferedPrompt}"`)}\n`)
        }
        headerPrinted = true
      }

      ctx.onEvent = (ev) => {
        switch (ev.type) {
          // Buffer prompt — shown when agent starts responding
          case 'user_message': {
            const text = cliMessageText(ev.message)
            const clean = text.replace(/\n/g, ' ').trim()
            bufferedPrompt = clean.length > 100 ? clean.slice(0, 100) + '…' : clean
            break
          }
          // Agent text — stop spinner, show header + prompt + text
          case 'text_delta':
            ensureHeader()
            accText += String(ev.delta ?? '')
            if (!textFlushed && accText.length > 40) flushText()
            break
          case 'text_complete':
            ensureHeader()
            flushText()
            break
          // Tool use — stop spinner, show header + prompt + tool
          case 'tool_start': {
            ensureHeader()
            flushText()
            const name = String(ev.toolName ?? '?')
            const intent = ev.toolIntent ? ` — "${ev.toolIntent}"` : ''
            process.stdout.write(`    ${c.dim('↳')} ${c.dim(`tool: ${name}${intent}`)}\n`)
            accText = ''
            textFlushed = false
            break
          }
          // Ignore internal events (connection_changed, usage_update, etc.)
        }
      }
    } else {
      ctx.onEvent = undefined
    }

    const stepStart = performance.now()
    try {
      const detail = await step.fn(client, ctx)
      const elapsed = (performance.now() - stepStart) / 1000
      passed++
      results.push({ step: step.name, status: 'OK', detail, elapsed })
      spinner?.stop()
      if (!jsonMode) {
        const dots = c.dim('.'.repeat(Math.max(1, 50 - plainLen)))
        const time = c.dim(elapsed < 1 ? `(${Math.round(elapsed * 1000)}ms)` : `(${elapsed.toFixed(1)}s)`)
        process.stdout.write(`${c.cyan(num)} ${step.name} ${dots} ${c.green('✓')}  ${detail}  ${time}\n`)
      }
    } catch (e) {
      const elapsed = (performance.now() - stepStart) / 1000
      failed++
      const msg = e instanceof Error ? e.message : String(e)
      results.push({ step: step.name, status: 'FAIL', detail: msg, elapsed })
      spinner?.stop()
      if (!jsonMode) {
        const dots = c.dim('.'.repeat(Math.max(1, 50 - plainLen)))
        const time = c.dim(elapsed < 1 ? `(${Math.round(elapsed * 1000)}ms)` : `(${elapsed.toFixed(1)}s)`)
        process.stderr.write(`${c.cyan(num)} ${step.name} ${dots} ${c.red('✗')}  ${msg}  ${time}\n`)
      }
    }
  }

  // Cleanup: branched session
  if (ctx.branchedSessionId && client.isConnected) {
    try {
      await client.invoke('sessions:delete', ctx.branchedSessionId)
    } catch {
      // best effort
    }
  }

  // Cleanup: if a session was created but delete step hasn't run or failed
  if (ctx.createdSessionId && client.isConnected) {
    try {
      await client.invoke('sessions:delete', ctx.createdSessionId)
    } catch {
      // best effort
    }
  }

  // Cleanup: automation artifacts
  await cleanupAutomationArtifacts(client, ctx)

  // Cleanup: if we auto-created a temp workspace, remove it
  if (ctx.createdWorkspace && ctx.workspaceId && client.isConnected) {
    try {
      await client.invoke('workspaces:delete', ctx.workspaceId)
    } catch {
      // best effort
    }
    if (ctx.workspaceRootPath) {
      try {
        const { rm } = await import('fs/promises')
        await rm(ctx.workspaceRootPath, { recursive: true, force: true })
      } catch {
        // best effort
      }
    }
  }

  const totalSec = ((performance.now() - totalStart) / 1000).toFixed(1)

  if (jsonMode) {
    out({ total, passed, failed, results, elapsedSeconds: parseFloat(totalSec) }, true)
  } else {
    if (failed === 0) {
      process.stdout.write(`\n${c.green(`✓ ${passed}/${total} passed`)} ${c.dim(`in ${totalSec}s`)}\n`)
    } else {
      process.stdout.write(`\n${c.red(`✗ ${passed}/${total} passed, ${failed} failed`)} ${c.dim(`in ${totalSec}s`)}\n`)
    }
  }

  return failed > 0 ? 1 : 0
}
