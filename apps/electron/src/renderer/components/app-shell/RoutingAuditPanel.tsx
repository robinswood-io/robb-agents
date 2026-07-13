import * as React from 'react'
import { BarChart3, Clipboard, FileText } from 'lucide-react'
import type { Session } from '../../../shared/types'
import { buildSessionRoutingAuditSummary } from '@craft-agent/shared/audit'
import { Tooltip, TooltipContent, TooltipTrigger } from '@craft-agent/ui'

function formatCurrency(value: number | undefined): string {
  if (typeof value !== 'number') return '—'
  return `${value.toFixed(6)} €`
}

function buildAuditExportJson(session: Session): string {
  const summary = buildSessionRoutingAuditSummary(session.messages)
  return JSON.stringify({
    sessionId: session.id,
    generatedAt: new Date().toISOString(),
    totalEstimatedCostEur: summary.totalEstimatedCostEur,
    totalActualCostEur: summary.totalActualCostEur,
    providers: summary.byConnectionSlug,
    sensitivities: summary.bySensitivity,
    policyRuleHits: summary.policyRuleHits,
  }, null, 2)
}

function buildAuditExportMarkdown(session: Session): string {
  const summary = buildSessionRoutingAuditSummary(session.messages)
  const providerRows = Object.entries(summary.byConnectionSlug)
    .map(([slug, value]) => `| ${slug} | ${value.turns} | ${formatCurrency(value.estimatedCostEur)} | ${formatCurrency(value.actualCostEur)} |`)
    .join('\n') || '| — | 0 | — | — |'
  const sensitivityRows = Object.entries(summary.bySensitivity)
    .map(([sensitivity, value]) => `| ${sensitivity} | ${value.turns} |`)
    .join('\n') || '| — | 0 |'
  const ruleRows = Object.entries(summary.policyRuleHits)
    .map(([ruleId, hits]) => `| ${ruleId} | ${hits} |`)
    .join('\n') || '| — | 0 |'

  return [
    `# Audit IA — session ${session.id}`,
    '',
    `Généré le ${new Date().toISOString()}`,
    '',
    `- Coût estimé total : ${formatCurrency(summary.totalEstimatedCostEur)}`,
    `- Coût réel total : ${formatCurrency(summary.totalActualCostEur)}`,
    '',
    '## Providers / connexions',
    '',
    '| Connexion | Tours | Coût estimé | Coût réel |',
    '|---|---:|---:|---:|',
    providerRows,
    '',
    '## Sensibilités',
    '',
    '| Sensibilité | Tours |',
    '|---|---:|',
    sensitivityRows,
    '',
    '## Règles policy',
    '',
    '| Règle | Hits |',
    '|---|---:|',
    ruleRows,
  ].join('\n')
}

async function copyText(text: string): Promise<void> {
  await navigator.clipboard.writeText(text)
}

export function RoutingAuditPanel({ session }: { session: Session }) {
  const [open, setOpen] = React.useState(false)
  const [copied, setCopied] = React.useState<'json' | 'markdown' | null>(null)
  const summary = React.useMemo(() => buildSessionRoutingAuditSummary(session.messages), [session.messages])
  const providerEntries = Object.entries(summary.byConnectionSlug)
  const sensitivityEntries = Object.entries(summary.bySensitivity)
  const policyRuleEntries = Object.entries(summary.policyRuleHits)
  const hasAudit = providerEntries.length > 0

  const handleCopy = async (kind: 'json' | 'markdown') => {
    await copyText(kind === 'json' ? buildAuditExportJson(session) : buildAuditExportMarkdown(session))
    setCopied(kind)
    window.setTimeout(() => setCopied(null), 1500)
  }

  if (!hasAudit) return null

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pt-3">
      <div className="rounded-md border border-border/60 bg-muted/20 text-xs text-muted-foreground">
        <button
          type="button"
          onClick={() => setOpen(value => !value)}
          className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-muted/30"
        >
          <span className="inline-flex items-center gap-2 font-medium text-foreground/80">
            <BarChart3 className="h-3.5 w-3.5" />
            Audit IA
          </span>
          <span className="truncate">
            {providerEntries.length} connexion{providerEntries.length > 1 ? 's' : ''}
            {summary.totalEstimatedCostEur !== undefined ? ` · ${formatCurrency(summary.totalEstimatedCostEur)} estimé` : ''}
          </span>
        </button>

        {open && (
          <div className="space-y-3 border-t border-border/60 px-3 py-3">
            <div className="grid gap-2 sm:grid-cols-3">
              <div><span className="text-foreground/60">Coût estimé</span><div className="text-foreground">{formatCurrency(summary.totalEstimatedCostEur)}</div></div>
              <div><span className="text-foreground/60">Coût réel</span><div className="text-foreground">{formatCurrency(summary.totalActualCostEur)}</div></div>
              <div><span className="text-foreground/60">Tours audités</span><div className="text-foreground">{providerEntries.reduce((sum, [, value]) => sum + value.turns, 0)}</div></div>
            </div>

            <div className="space-y-1">
              <div className="font-medium text-foreground/80">Connexions</div>
              {providerEntries.map(([slug, value]) => (
                <div key={slug} className="flex justify-between gap-3">
                  <span className="truncate">{slug}</span>
                  <span className="shrink-0">{value.turns} tour{value.turns > 1 ? 's' : ''} · {formatCurrency(value.estimatedCostEur)}</span>
                </div>
              ))}
            </div>

            {sensitivityEntries.length > 0 && (
              <div className="space-y-1">
                <div className="font-medium text-foreground/80">Sensibilités</div>
                {sensitivityEntries.map(([sensitivity, value]) => (
                  <div key={sensitivity} className="flex justify-between gap-3"><span>{sensitivity}</span><span>{value.turns}</span></div>
                ))}
              </div>
            )}

            {policyRuleEntries.length > 0 && (
              <div className="space-y-1">
                <div className="font-medium text-foreground/80">Règles policy</div>
                {policyRuleEntries.map(([ruleId, hits]) => (
                  <div key={ruleId} className="flex justify-between gap-3"><span className="truncate">{ruleId}</span><span>{hits}</span></div>
                ))}
              </div>
            )}

            <div className="flex flex-wrap gap-2 pt-1">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button type="button" onClick={() => handleCopy('json')} className="inline-flex items-center gap-1 rounded border border-border/70 px-2 py-1 hover:bg-muted/40">
                    <Clipboard className="h-3 w-3" /> {copied === 'json' ? 'JSON copié' : 'Copier JSON'}
                  </button>
                </TooltipTrigger>
                <TooltipContent>Export structuré sans secrets ni clés API.</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button type="button" onClick={() => handleCopy('markdown')} className="inline-flex items-center gap-1 rounded border border-border/70 px-2 py-1 hover:bg-muted/40">
                    <FileText className="h-3 w-3" /> {copied === 'markdown' ? 'Markdown copié' : 'Copier Markdown'}
                  </button>
                </TooltipTrigger>
                <TooltipContent>Export lisible pour revue client.</TooltipContent>
              </Tooltip>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
