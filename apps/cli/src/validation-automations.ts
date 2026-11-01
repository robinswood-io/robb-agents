import type { CliAutomationTestResult } from './rpc-shapes.ts';
import { isWebhookHistoryEntry } from './rpc-shapes.ts';
import { cleanupAutomationArtifacts } from './validation-events.ts';
import type { ValidateLabel, ValidateMessagesResponse, ValidateSession, ValidateStatus, ValidateStep } from './validation-types.ts';

export function getAutomationValidationSteps(): ValidateStep[] {
  return [
// ----- Automation lifecycle -----
    {
      name: 'automation:create',
      fn: async (_client, ctx) => {
        if (!ctx.createdSessionId || !ctx.workspaceRootPath) return 'skipped (no session or workspace)'
        const configPath = `${ctx.workspaceRootPath}/automations.json`
        const historyPath = `${ctx.workspaceRootPath}/automations-history.jsonl`
        const { readFile, writeFile } = await import('fs/promises')

        // Always backup + overwrite with deterministic validation config,
        // then restore during cleanup.
        const existingConfig = await readFile(configPath, 'utf-8').catch(() => null)
        ctx.automationsJsonBackup = existingConfig
        ctx.automationsHistoryBackup = await readFile(historyPath, 'utf-8').catch(() => null)

        const templatePath = `${process.cwd()}/.github/agents/automations.json`
        const templateConfig = await readFile(templatePath, 'utf-8').catch(() => null)
        if (!templateConfig) {
          throw new Error(`Missing automation template at ${templatePath}`)
        }

        const parsed = JSON.parse(templateConfig) as {
          automations?: { SessionStatusChange?: Array<{ name?: string }> }
        }
        const entries = parsed?.automations?.SessionStatusChange
        if (!Array.isArray(entries) || entries.length === 0) {
          throw new Error('Automation template missing automations.SessionStatusChange entries')
        }

        const blocked = entries.find((e) => e.name === 'CLI Validate Condition Blocked')
        const pass = entries.find((e) => e.name === 'CLI Validate Condition Pass')
        if (!blocked?.name || !pass?.name) {
          throw new Error('Automation template must define both "CLI Validate Condition Blocked" and "CLI Validate Condition Pass"')
        }

        ctx.automationBlockedName = blocked.name
        ctx.automationName = pass.name

        await writeFile(configPath, templateConfig)
        ctx.createdAutomation = true
        // ConfigWatcher auto-detects automations.json changes (debounced)
        await new Promise((r) => setTimeout(r, 2000))
        return `wrote config from template (blocked=${ctx.automationBlockedName}, pass=${ctx.automationName})`
      },
    },
{
      name: 'automation:trigger (status change)',
      fn: async (client, ctx) => {
        if (!ctx.createdSessionId || !ctx.workspaceId) return 'skipped (no session or workspace)'
        // Get available statuses to find one containing "in-progress"
        const statuses = (await client.invoke('statuses:list', ctx.workspaceId)) as ValidateStatus[]
        const inProgress = statuses?.find((s) =>
          (s.id ?? '').toLowerCase().includes('in-progress') ||
          (s.label ?? '').toLowerCase().includes('in progress')
        )
        const statusValue = inProgress?.id ?? 'in-progress'

        // Change session status to trigger the automations
        await client.invoke('sessions:command', ctx.createdSessionId, {
          type: 'setSessionStatus',
          state: statusValue,
        })

        // Poll for expected automation behavior:
        // - pass automation MUST create a session
        // - blocked automation MUST NOT create a session
        let delay = 1000
        const deadline = Date.now() + 60_000
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, delay))
          delay = Math.min(delay * 1.5, 10_000)
          const sessions = (await client.invoke('sessions:get', ctx.workspaceId)) as ValidateSession[]

          const blockedSession = sessions?.find((s) =>
            s.name === ctx.automationBlockedName && s.id !== ctx.createdSessionId
          )
          if (blockedSession) {
            ctx.automationBlockedSessionId = blockedSession.id
            throw new Error(`Blocked automation unexpectedly triggered (session=${blockedSession.id})`)
          }

          const passSession = sessions?.find((s) =>
            s.name === ctx.automationName && s.id !== ctx.createdSessionId
          )
          if (passSession) {
            ctx.automationTestSessionId = passSession.id

            // Guard against delayed blocked-automation session creation.
            await new Promise((r) => setTimeout(r, 2000))
            const sessionsAfter = (await client.invoke('sessions:get', ctx.workspaceId)) as ValidateSession[]
            const blockedAfter = sessionsAfter?.find((s) =>
              s.name === ctx.automationBlockedName && s.id !== ctx.createdSessionId
            )
            if (blockedAfter) {
              ctx.automationBlockedSessionId = blockedAfter.id
              throw new Error(`Blocked automation unexpectedly triggered after delay (session=${blockedAfter.id})`)
            }

            return `pass triggered → session ${passSession.id}; blocked automation did not trigger (status=${statusValue})`
          }
        }
        throw new Error('Passing automation-created session not found within 60s')
      },
    },
{
      name: 'automation:verify session',
      fn: async (client, ctx) => {
        if (!ctx.automationTestSessionId) return 'skipped (no automation session)'
        // Wait for the automation session to complete
        let delay = 1000
        const deadline = Date.now() + 90_000
        while (Date.now() < deadline) {
          const session = (await client.invoke('sessions:getMessages', ctx.automationTestSessionId)) as ValidateMessagesResponse
          const messages = session?.messages ?? session?.conversation ?? []
          const hasAssistant = messages.some((m) => m.role === 'assistant')
          if (hasAssistant) {
            const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant')
            const text = typeof lastAssistant?.content === 'string'
              ? lastAssistant.content
              : Array.isArray(lastAssistant?.content)
                ? lastAssistant.content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join(' ')
                : ''
            return `session has assistant response (${text.slice(0, 80).trim()})`
          }
          await new Promise((r) => setTimeout(r, delay))
          delay = Math.min(delay * 1.5, 10_000)
        }
        throw new Error('Automation session did not complete within 90s')
      },
    },
{
      name: 'automation:verify labels',
      fn: async (client, ctx) => {
        if (!ctx.automationTestSessionId || !ctx.workspaceId) return 'skipped (no automation session)'
        // Verify label was auto-created
        const labels = (await client.invoke('labels:list', ctx.workspaceId)) as ValidateLabel[]
        const found = labels?.find((l) => (l.id ?? l.name ?? '') === 'cli-validate-label')
        if (!found) throw new Error('Label cli-validate-label was not auto-created')
        ctx.createdLabelId = found.id ?? 'cli-validate-label'

        // Verify the automation session has the label
        const sessions = (await client.invoke('sessions:get', ctx.workspaceId)) as ValidateSession[]
        const automationSession = sessions?.find((s) => s.id === ctx.automationTestSessionId)
        const sessionLabels: string[] = automationSession?.labels ?? []
        const hasLabel = sessionLabels.some((l: string) => l.includes('cli-validate-label'))
        if (!hasLabel) throw new Error(`Automation session missing label (has: ${sessionLabels.join(', ')})`)
        return `label created and assigned: ${ctx.createdLabelId}`
      },
    },
{
      name: 'automations:getLastExecuted',
      fn: async (client, ctx) => {
        if (!ctx.workspaceId) return 'skipped (no workspace)'
        const history = (await client.invoke('automations:getLastExecuted', ctx.workspaceId)) as Record<string, number>
        const entries = Object.entries(history)
        if (entries.length === 0) throw new Error('No automation execution history found')
        // Verify at least one automation ran recently (within last 2 minutes)
        const recentThreshold = Date.now() - 120_000
        const recent = entries.find(([, ts]) => ts > recentThreshold)
        if (!recent) throw new Error(`No recent automation execution (latest: ${Math.max(...entries.map(([, ts]) => ts))})`)
        return `${entries.length} automation(s), latest ran ${Math.round((Date.now() - recent[1]) / 1000)}s ago`
      },
    },
// ----- Webhook validation -----
    {
      name: 'webhook:test (RPC)',
      fn: async (client, ctx) => {
        if (!ctx.workspaceId) return 'skipped (no workspace)'
        const r = (await client.invoke('automations:test', {
          workspaceId: ctx.workspaceId,
          actions: [{
            type: 'webhook',
            url: 'http://127.0.0.1:19999/validate-test',
            method: 'GET',
          }],
        })) as CliAutomationTestResult
        const result = r?.actions?.[0]
        if (result?.success) throw new Error('Expected webhook to fail (nothing listening)')
        if (!result?.error && result?.statusCode !== 0) throw new Error('Expected error or statusCode 0 in result')
        return `correctly failed: ${(result.error ?? `statusCode=${result.statusCode}`).slice(0, 80)}`
      },
    },
{
      name: 'webhook:verify failure',
      fn: async (_client, ctx) => {
        if (!ctx.workspaceRootPath) return 'skipped (no workspace root)'
        const { readFile } = await import('fs/promises')
        const historyPath = `${ctx.workspaceRootPath}/automations-history.jsonl`

        const start = Date.now()
        const deadline = start + 15_000
        let delay = 200

        let lastLineCount = 0
        let lastWebhookCount = 0
        let lastSummary = 'no entries'

        while (Date.now() < deadline) {
          const content = await readFile(historyPath, 'utf-8').catch(() => '')
          const lines = content.trim().split('\n').filter(Boolean)
          lastLineCount = lines.length

          const entries = lines
            .map((l): unknown => {
              try {
                return JSON.parse(l)
              } catch {
                return null
              }
            })
            .filter(isWebhookHistoryEntry)

          const webhookEntries = entries
          lastWebhookCount = webhookEntries.length

          if (webhookEntries.length > 0) {
            const recentThreshold = Date.now() - 120_000
            const recentFailed = webhookEntries.find((e) =>
              !e.ok && e.ts > recentThreshold && e.webhook?.method === 'POST'
            )
            if (recentFailed) {
              return `webhook failure recorded: method=${recentFailed.webhook.method}, url=${recentFailed.webhook.url?.slice(0, 50)}`
            }

            const latest = webhookEntries[webhookEntries.length - 1]
            lastSummary = `latest: ok=${String(latest?.ok)} method=${String(latest?.webhook?.method ?? 'n/a')} ts=${String(latest?.ts ?? 'n/a')}`
          }

          await new Promise((r) => setTimeout(r, delay))
          delay = Math.min(Math.round(delay * 1.8), 1500)
        }

        const waitedMs = Date.now() - start
        throw new Error(
          `No recent failed POST webhook history entry after ${waitedMs}ms (lines=${lastLineCount}, webhookEntries=${lastWebhookCount}, ${lastSummary})`,
        )
      },
    },
{
      name: 'automation:cleanup',
      fn: async (client, ctx) => {
        const cleaned = await cleanupAutomationArtifacts(client, ctx)
        return cleaned.length > 0 ? `cleaned: ${cleaned.join(', ')}` : 'nothing to clean'
      },
    }
  ]
}
