
import { CheckCircle2, XCircle, CircleSlash, Pause, Play, Square, ClipboardCopy, ShieldCheck, AlertTriangle, Wrench, GitBranch, FileCheck2 } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { Spinner, Markdown } from '@craft-agent/ui';

import { resolveNodeStatePill } from './node-state-pill';

import { type TaskResults, Btn } from "./task-editor-primitives";

export function ResultsPanel({
  results,
  loading,
  onControl,
  onResolveApproval,
  onRepairNode,
}: {
  results: TaskResults | null
  loading: boolean
  onControl: (action: 'pause' | 'resume' | 'stop') => void
  onResolveApproval: (requestId: string, decision: 'approved' | 'rejected') => void
  onRepairNode: (nodeId: string) => void
}) {
  const { t } = useTranslation()

  if (loading && !results) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center rounded-xl border border-border bg-card text-foreground/50 shadow-minimal">
        <Spinner className="text-lg" />
      </div>
    )
  }

  if (!results) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 rounded-xl border border-border bg-card px-6 text-center text-foreground/50 shadow-minimal">
        <CircleSlash className="h-6 w-6 text-foreground/30" strokeWidth={2} />
        <p className="text-[12.5px]">{t('tasks.resultsEmpty')}</p>
      </div>
    )
  }

  const verdict = results.verdict
  const verdicts = results.verdicts ?? (verdict ? [verdict] : [])
  const repair = results.repair
  const control = results.controlRoom
  const task = results.task
  const repairableRun = ['completed', 'failed', 'stopped'].includes(results.runStatus ?? '')
  const evaluationLabel = control?.evaluation.status === 'passing'
    ? t('tasks.evaluationPassing')
    : control?.evaluation.status === 'failing'
      ? t('tasks.evaluationFailing')
      : control?.evaluation.status === 'pending'
        ? t('tasks.evaluationPending')
        : t('tasks.evaluationNotEvaluated')
  const costLabel = control?.cost.status === 'within-budget'
    ? t('tasks.costWithinBudget')
    : control?.cost.status === 'warning'
      ? t('tasks.costWarning')
      : control?.cost.status === 'exceeded'
        ? t('tasks.costExceeded')
        : control?.cost.status === 'tracking'
          ? t('tasks.costTracking')
          : t('tasks.costUntracked')
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto rounded-xl border border-border bg-card p-4 shadow-minimal">
      {task && (
        <section data-testid="durable-task-overview" className="rounded-[12px] border border-border bg-background/60 p-3.5">
          <div className="flex flex-wrap items-start gap-2">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-[14px] font-bold">{task.title}</span>
                <span className="rounded-full border border-border bg-card px-2 py-0.5 text-[10.5px] font-semibold text-foreground/55">
                  {task.visualState.label}
                </span>
                <span className="text-[10.5px] text-foreground/35">v{task.revision}</span>
              </div>
              <p className="mt-1 text-[12px] leading-relaxed text-foreground/65">{task.description}</p>
            </div>
            <div className="rounded-lg border border-border/70 bg-card px-2.5 py-1.5 text-[10.5px] text-foreground/55">
              {task.executor.agent} · {task.executor.wrapper}
              {task.executor.model ? ` · ${task.executor.model}` : ''}
            </div>
          </div>
          <div className="mt-3 grid gap-2 md:grid-cols-3">
            <div className="rounded-lg border border-border/60 bg-card/70 px-3 py-2">
              <div className="text-[10px] font-bold uppercase tracking-wide text-foreground/40">{t('tasks.nextAction')}</div>
              <div className="mt-1 text-[11.5px] leading-relaxed text-foreground/70">{task.nextAction}</div>
            </div>
            <div className="rounded-lg border border-border/60 bg-card/70 px-3 py-2">
              <div className="text-[10px] font-bold uppercase tracking-wide text-foreground/40">{t('tasks.sources')}</div>
              <div className="mt-1 text-[11.5px] text-foreground/70">{task.sources.join(', ') || t('tasks.noneSelected')}</div>
            </div>
            <div className="rounded-lg border border-border/60 bg-card/70 px-3 py-2">
              <div className="text-[10px] font-bold uppercase tracking-wide text-foreground/40">{t('tasks.project')}</div>
              <div className="mt-1 text-[11.5px] text-foreground/70">{task.projectId || t('tasks.noProject')}</div>
            </div>
          </div>
          {(task.externalRefs.craftTaskId || task.externalRefs.googleTaskId || task.externalRefs.temporalWorkflowId) && (
            <div className="mt-2 flex flex-wrap gap-1.5 text-[10.5px] text-foreground/50">
              {task.externalRefs.craftTaskId && <span className="rounded bg-foreground/[0.05] px-1.5 py-0.5">Craft · {task.externalRefs.craftTaskId}</span>}
              {task.externalRefs.googleTaskId && <span className="rounded bg-foreground/[0.05] px-1.5 py-0.5">Google Tasks · {task.externalRefs.googleTaskId}</span>}
              {task.externalRefs.temporalWorkflowId && <span className="rounded bg-foreground/[0.05] px-1.5 py-0.5">Temporal · {task.externalRefs.temporalWorkflowId}</span>}
            </div>
          )}
        </section>
      )}

      {!results.runId && (
        <div className="flex min-h-36 flex-col items-center justify-center gap-2 rounded-xl border border-border bg-card px-6 text-center text-foreground/50">
          <CircleSlash className="h-6 w-6 text-foreground/30" strokeWidth={2} />
          <p className="text-[12.5px]">{t('tasks.resultsEmpty')}</p>
        </div>
      )}

      {control && (
        <section className="rounded-[12px] border border-indigo-500/20 bg-indigo-500/[0.035] p-3.5">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <ShieldCheck className="h-4 w-4 shrink-0 text-indigo-500 dark:text-indigo-300" strokeWidth={2.25} />
              <div className="min-w-0">
                <div className="text-[11px] font-bold uppercase tracking-wide text-foreground/45">{t('tasks.controlRoom')}</div>
                <div className="truncate text-[13px] font-semibold">{control.objective}</div>
              </div>
            </div>
            <span className="rounded-full border border-indigo-500/20 bg-indigo-500/[0.08] px-2 py-0.5 text-[10.5px] font-bold text-indigo-600 dark:text-indigo-300">
              {control.status}
            </span>
            {control.status === 'running' && (
              <Btn className="h-7 px-2" onClick={() => onControl('pause')}>
                <Pause className="h-3 w-3" /> {t('tasks.pauseMission')}
              </Btn>
            )}
            {control.status === 'paused' && (
              <Btn className="h-7 px-2" onClick={() => onControl('resume')}>
                <Play className="h-3 w-3" /> {t('tasks.resumeMission')}
              </Btn>
            )}
            {!['completed', 'failed', 'stopped'].includes(control.status) && (
              <Btn className="h-7 px-2" onClick={() => onControl('stop')}>
                <Square className="h-3 w-3" /> {t('tasks.stopMission')}
              </Btn>
            )}
            {results.reportMarkdown && (
              <Btn
                className="h-7 px-2"
                onClick={() => {
                  const report = results.reportMarkdown
                  if (!report) return
                  void navigator.clipboard.writeText(report).then(() => {
                    toast.success(t('tasks.reportCopied'))
                  })
                }}
              >
                <ClipboardCopy className="h-3 w-3" /> {t('tasks.copyReport')}
              </Btn>
            )}
          </div>

          <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
            <div className="rounded-lg border border-border/60 bg-card/70 px-3 py-2">
              <div className="text-[10.5px] font-bold uppercase tracking-wide text-foreground/40">{t('tasks.progress')}</div>
              <div className="mt-1 text-[16px] font-bold tabular-nums">{control.progress.percent}%</div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-foreground/[0.08]">
                <div className="h-full rounded-full bg-indigo-500" style={{ width: `${control.progress.percent}%` }} />
              </div>
            </div>
            <div className="rounded-lg border border-border/60 bg-card/70 px-3 py-2">
              <div className="text-[10.5px] font-bold uppercase tracking-wide text-foreground/40">{t('tasks.budget')}</div>
              <div className="mt-1 text-[12px] font-semibold tabular-nums">
                {control.budget.tokensUsed != null
                  ? `${control.budget.tokensUsed}${control.budget.maxTokens ? ` / ${control.budget.maxTokens}` : ''} tokens`
                  : t('tasks.costUntracked')}
              </div>
            </div>
            <div
              data-testid="mission-control-cost"
              className={cn(
                'rounded-lg border bg-card/70 px-3 py-2',
                control.cost.status === 'exceeded'
                  ? 'border-red-500/35'
                  : control.cost.status === 'warning'
                    ? 'border-amber-500/35'
                    : 'border-border/60',
              )}
            >
              <div className="text-[10.5px] font-bold uppercase tracking-wide text-foreground/40">{t('tasks.cost')}</div>
              <div className="mt-1 text-[12px] font-semibold tabular-nums">
                {control.cost.used != null
                  ? `${control.cost.used} ${control.cost.currency}`
                  : t('tasks.costUntracked')}
              </div>
              <div className="mt-0.5 truncate text-[10.5px] text-foreground/50">
                {costLabel}
                {control.cost.limit != null ? ` · ${control.cost.percentUsed ?? 0}% / ${control.cost.limit} ${control.cost.currency}` : ''}
              </div>
            </div>
            <div
              data-testid="mission-control-evaluation"
              className={cn(
                'rounded-lg border bg-card/70 px-3 py-2',
                control.evaluation.status === 'failing'
                  ? 'border-red-500/35'
                  : control.evaluation.status === 'passing'
                    ? 'border-emerald-500/35'
                    : 'border-border/60',
              )}
            >
              <div className="text-[10.5px] font-bold uppercase tracking-wide text-foreground/40">{t('tasks.evaluation')}</div>
              <div className="mt-1 text-[12px] font-semibold">{evaluationLabel}</div>
              <div className="mt-0.5 truncate text-[10.5px] text-foreground/50">
                {t('tasks.nodeEvidence', {
                  successful: control.evaluation.successfulNodes,
                  evaluated: control.evaluation.evaluatedNodes,
                })}
                {control.evaluation.safetyIssueCount > 0
                  ? ` · ${t('tasks.safetyIssueCount', { count: control.evaluation.safetyIssueCount })}`
                  : ''}
              </div>
            </div>
            <div className="rounded-lg border border-border/60 bg-card/70 px-3 py-2">
              <div className="text-[10.5px] font-bold uppercase tracking-wide text-foreground/40">{t('tasks.events')}</div>
              <div className="mt-1 text-[16px] font-bold tabular-nums">{control.eventCount}</div>
              {control.latestEventAt && <div className="mt-0.5 truncate text-[10.5px] text-foreground/45">{control.latestEventAt}</div>}
            </div>
          </div>

          {control.approvals.some((approval) => approval.status === 'pending') && (
            <div className="mt-3 space-y-2">
              <div className="text-[11px] font-bold uppercase tracking-wide text-foreground/45">{t('tasks.approvalInbox')}</div>
              {control.approvals.filter((approval) => approval.status === 'pending').map((approval) => (
                <div key={approval.requestId} className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/25 bg-amber-500/[0.06] px-3 py-2">
                  <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
                  <span className="min-w-0 flex-1 text-[12px] text-foreground/70">{approval.reason}</span>
                  <span className="text-[10.5px] font-semibold text-foreground/45">{approval.owner}</span>
                  <Btn className="h-7 px-2" onClick={() => onResolveApproval(approval.requestId, 'rejected')}>
                    {t('tasks.reject')}
                  </Btn>
                  <Btn variant="primary" className="h-7 px-2" onClick={() => onResolveApproval(approval.requestId, 'approved')}>
                    {t('tasks.approve')}
                  </Btn>
                </div>
              ))}
            </div>
          )}

          {control.blockers.length > 0 && (
            <div className="mt-3 space-y-1.5">
              <div className="text-[11px] font-bold uppercase tracking-wide text-foreground/45">{t('tasks.blockers')}</div>
              {control.blockers.map((blocker) => (
                <div key={blocker.id} className="rounded-lg border border-red-500/20 bg-red-500/[0.04] px-3 py-2 text-[11.5px]">
                  <div className="font-semibold text-foreground/75">{blocker.cause}</div>
                  <div className="mt-0.5 text-foreground/45">
                    {blocker.owner} · {blocker.resolution}
                  </div>
                </div>
              ))}
            </div>
          )}

          {results.replayPlan?.blockedNodeIds.length ? (
            <p className="mt-3 text-[11px] text-amber-600 dark:text-amber-300">
              {t('tasks.replayBlocked', { nodes: results.replayPlan.blockedNodeIds.join(', ') })}
            </p>
          ) : null}
        </section>
      )}

      {results.acceptanceCriteria && (
        <div className="rounded-[10px] border border-border/70 bg-foreground/[0.015] px-3 py-2.5">
          <div className="text-[11px] font-bold uppercase tracking-wide text-foreground/45">{t('tasks.acceptanceCriteria')}</div>
          <p className="mt-1 text-[12px] leading-relaxed text-foreground/70">{results.acceptanceCriteria}</p>
        </div>
      )}

      {results.userEvidence && (
        <section className="rounded-[10px] border border-border/70 bg-foreground/[0.015] px-3 py-2.5">
          <div className="mb-2 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-foreground/45">
            <FileCheck2 className="h-3.5 w-3.5" /> {t('tasks.userProof')}
          </div>
          <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-5">
            {[
              [t('tasks.actionRequested'), results.userEvidence.actionRequested],
              [t('tasks.actionAttempted'), results.userEvidence.actionAttempted.join('; ') || t('tasks.noneRecorded')],
              [t('tasks.mutationApplied'), results.userEvidence.mutationsApplied.join('; ') || t('tasks.noneRecorded')],
              [t('tasks.realVerification'), results.userEvidence.userVerification],
              [t('tasks.remainingLimitation'), results.userEvidence.remainingLimitations.join('; ') || t('tasks.noneRecorded')],
            ].map(([label, value]) => (
              <div key={label} className="rounded-lg border border-border/60 bg-card/70 px-2.5 py-2">
                <div className="text-[10px] font-bold uppercase tracking-wide text-foreground/40">{label}</div>
                <div className="mt-1 text-[11.5px] leading-relaxed text-foreground/70">{value}</div>
              </div>
            ))}
          </div>
        </section>
      )}

      {verdict && (
        <div
          className={cn(
            'flex items-start gap-2.5 rounded-[10px] border px-3 py-2.5',
            verdict.result === 'pass'
              ? 'border-emerald-500/30 bg-emerald-500/[0.06]'
              : verdict.result === 'fail'
                ? 'border-red-500/30 bg-red-500/[0.06]'
                : 'border-border bg-foreground/[0.03]',
          )}
        >
          {verdict.result === 'pass' ? (
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" strokeWidth={2.5} />
          ) : verdict.result === 'fail' ? (
            <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" strokeWidth={2.5} />
          ) : (
            <CircleSlash className="mt-0.5 h-4 w-4 shrink-0 text-foreground/40" strokeWidth={2.5} />
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-bold">
                {verdict.result === 'pass' ? t('tasks.verdictPass') : verdict.result === 'fail' ? t('tasks.verdictFail') : t('tasks.verdictUnparsed')}
              </span>
              {repair && (
                <span className="ml-auto shrink-0 rounded-full bg-foreground/[0.06] px-2 py-0.5 text-[10.5px] font-bold text-foreground/55">
                  {t('tasks.repairAttempt', { used: repair.used, max: repair.max })}
                </span>
              )}
            </div>
            {verdict.reason && <p className="mt-0.5 text-[12px] leading-relaxed text-foreground/65">{verdict.reason}</p>}
            {verdict.nodes && verdict.nodes.length > 0 && (
              <p className="mt-1 text-[11px] text-foreground/45">{t('tasks.repairNodes', { nodes: verdict.nodes.join(', ') })}</p>
            )}
          </div>
        </div>
      )}

      {verdicts.length > 1 && (
        <div className="rounded-[10px] border border-border/70 bg-foreground/[0.015] px-3 py-2.5">
          <div className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-foreground/45">{t('tasks.verdictHistory')}</div>
          <div className="flex flex-col gap-1">
            {verdicts.map((v, i) => (
              <div key={i} className="flex items-start gap-2 text-[11.5px]">
                {v.result === 'pass' ? (
                  <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" strokeWidth={2.5} />
                ) : v.result === 'fail' ? (
                  <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-500" strokeWidth={2.5} />
                ) : (
                  <CircleSlash className="mt-0.5 h-3.5 w-3.5 shrink-0 text-foreground/40" strokeWidth={2.5} />
                )}
                <span className="min-w-0 flex-1 text-foreground/60">
                  {v.reason || (v.result === 'pass' ? t('tasks.verdictPass') : v.result === 'fail' ? t('tasks.verdictFail') : t('tasks.verdictUnparsed'))}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {results.nodes.map((node) => {
        const pill = resolveNodeStatePill(node.state)
        return (
        <div key={node.id} className="rounded-[10px] border border-border/70 bg-foreground/[0.015] p-3">
          <div className="flex items-center gap-2">
            <GitBranch className="h-3.5 w-3.5 shrink-0 text-foreground/35" />
            <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{node.title}</span>
            <span className={cn('shrink-0 rounded-full border px-2 py-0.5 text-[10.5px] font-bold', pill.className)}>
              {pill.labelKey ? t(pill.labelKey) : node.state}
            </span>
            <button
              type="button"
              disabled={!repairableRun || !node.repair?.allowed}
              title={!repairableRun ? t('tasks.repairRunMustSettle') : node.repair?.reason}
              onClick={() => onRepairNode(node.id)}
              className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-1 text-[11.5px] font-semibold text-indigo-500 hover:bg-indigo-500/10 disabled:cursor-not-allowed disabled:text-foreground/25 dark:text-indigo-300"
            >
              <Wrench className="h-3 w-3" strokeWidth={2.5} /> {t('tasks.repairNode')}
            </button>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[10.5px] text-foreground/45">
            <span>{t('tasks.attemptCount', { count: node.attempt ?? 0 })}</span>
            <span>·</span>
            <span>
              {t('tasks.dependencies')}: {node.dependsOn?.length ? node.dependsOn.join(' → ') : t('tasks.noDependencies')}
            </span>
            {node.proofHash && (
              <>
                <span>·</span>
                <span title={node.proofHash}>{t('tasks.proof')}: {node.proofHash.slice(0, 12)}…</span>
              </>
            )}
          </div>
          {node.output ? (
            <div className="mt-2 max-h-72 overflow-y-auto rounded-md border border-border/50 bg-background px-3 py-2 text-[12px] leading-relaxed">
              <Markdown>{node.output}</Markdown>
            </div>
          ) : (
            <p className="mt-1.5 text-[11.5px] text-foreground/40">{t('tasks.noOutput')}</p>
          )}
        </div>
        )
      })}
    </div>
  )
}
