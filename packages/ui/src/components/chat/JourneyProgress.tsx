import * as React from 'react'
import { Check, ChevronRight, Square, LoaderCircle, Minus, RotateCcw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { projectConversation } from './conversation-presentation'
import type { TodoItem } from './TurnCard'
import { describeJourneyActivity, safeActivityText, type JourneyActivity } from './journey-activity'

type Presentation = ReturnType<typeof projectConversation>
type Progress = NonNullable<Presentation['progress']>
type Outcome = NonNullable<Presentation['outcome']>

type JourneyProgressAgents = {
  activeCount: number
  latest?: { sessionName?: string; activity: JourneyActivity }
}

export interface JourneyProgressProps {
  progress: Progress
  agents?: JourneyProgressAgents
  /** Opt-in low-chrome disclosure used by the Codex-like conversation view. */
  presentation?: 'default' | 'codex'
}

function JourneyPlan({ steps }: { steps: TodoItem[] }) {
  const { t } = useTranslation()
  if (!steps.length) return null
  return (
    <ol aria-label={t('chat.journey.plan', { defaultValue: 'Plan' })} className="mt-4 space-y-2.5">
      {steps.map((step, index) => {
        const done = step.status === 'completed'
        const active = step.status === 'in_progress'
        const Icon = done ? Check : active ? LoaderCircle : step.status === 'interrupted' ? Minus : Square
        return (
          <li key={`${index}:${step.content}`} className="flex items-start gap-2.5 text-[13px] leading-5" data-plan-status={step.status}>
            <span role="img" aria-label={t(`chat.journey.step.${step.status}`)} className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-[3px] ${done ? 'bg-foreground/10 text-foreground/60' : active ? 'text-foreground' : 'text-foreground/30'}`}>
              <Icon aria-hidden="true" className={`size-3.5 ${active ? 'animate-spin motion-reduce:animate-none' : ''}`} strokeWidth={done ? 2.5 : 1.5} />
            </span>
            <span className={done ? 'text-foreground/50' : active ? 'text-foreground' : 'text-foreground/60'}>{safeActivityText(active ? step.activeForm ?? step.content : step.content, 500) ?? t('chat.journey.activity.unavailable')}</span>
          </li>
        )
      })}
    </ol>
  )
}

function CodexJourneyProgress({ progress, agents }: Pick<JourneyProgressProps, 'progress' | 'agents'>) {
  const { t } = useTranslation()
  const waiting = progress.state === 'waiting'
  const activity = progress.activity ?? describeJourneyActivity([], progress.steps)
  const showAgents = !!agents?.activeCount
  // The presentation layer receives typed, filtered summaries. Sanitize again
  // at the visual boundary so a future caller cannot turn this disclosure into
  // a raw tool-log surface.
  const activityTitle = safeActivityText(activity.title)
  const activityDetail = safeActivityText(activity.detail)
  const agentName = safeActivityText(agents?.latest?.sessionName)
  const agentTitle = safeActivityText(agents?.latest?.activity.title)
  const agentDetail = safeActivityText(agents?.latest?.activity.detail)
  const summary = showAgents
    ? agentTitle ?? agentName
    : waiting ? undefined : activityTitle

  return (
    <section className="px-3 py-2" data-testid="journey-progress" data-journey-presentation="codex" aria-busy={!waiting || showAgents}>
      <details className="group rounded-lg border border-foreground/[0.08] bg-foreground/[0.025] px-3 py-2" data-testid="journey-progress-disclosure">
        <summary className="flex cursor-pointer list-none items-center gap-2 text-[13px] outline-none [&::-webkit-details-marker]:hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background">
          <span role="status" aria-live="polite" aria-atomic="true" className="flex min-w-0 flex-1 items-center gap-2">
            <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full bg-current ${waiting ? 'text-foreground/40' : 'text-foreground/70 animate-pulse motion-reduce:animate-none'}`} />
            <span className="shrink-0 font-medium">{t(waiting ? 'chat.journey.waiting' : 'chat.journey.running')}</span>
            {summary && <span className="min-w-0 truncate text-foreground/55">{summary}</span>}
            {!showAgents && activity.totalSteps > 0 && (
              <span className="ml-auto shrink-0 text-xs text-foreground/45" data-testid="journey-step-count">
                {t('chat.journey.activity.steps', { completed: activity.completedSteps, total: activity.totalSteps })}
              </span>
            )}
          </span>
          <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 text-foreground/45 transition-transform duration-150 group-open:rotate-90" strokeWidth={1.8} />
        </summary>
        <div className="border-t border-foreground/[0.07] pt-3">
          {waiting && (
            <p className="text-[13px] leading-5 text-foreground/55">{t('chat.journey.waitingDescription')}</p>
          )}
          {showAgents ? (
            <div className={waiting ? 'mt-2' : undefined} data-testid="journey-agent-activity">
              <p className="text-xs text-foreground/55">{t('chat.journey.agentsRunning', { count: agents!.activeCount })}</p>
              {agentName && <p className="mt-1 text-[13px] font-medium break-words">{agentName}</p>}
              <p className="mt-1 text-[13px] leading-5 text-foreground/80 break-words">
                {agentTitle ?? t('chat.journey.agentActivityUnavailable')}
              </p>
              {agentDetail && <p className="mt-1 text-[13px] leading-5 text-foreground/55 break-words">{agentDetail}</p>}
            </div>
          ) : waiting ? null : activityTitle ? (
            <div className="mt-2" data-testid="journey-observed-activity" data-activity-source={activity.source}>
              <p className="text-[13px] leading-5 text-foreground/80 break-words">{activityTitle}</p>
              {activityDetail && <p className="mt-1 text-[13px] leading-5 text-foreground/55 break-words">{activityDetail}</p>}
            </div>
          ) : (
            <p className="mt-1.5 text-[13px] leading-5 text-foreground/55">{t('chat.journey.activity.unavailable')}</p>
          )}
          {showAgents && progress.steps.length > 0 && <p className="mt-4 text-xs text-foreground/55">{t('chat.journey.parentPlan')}</p>}
          <JourneyPlan steps={progress.steps} />
        </div>
      </details>
    </section>
  )
}

/** One stable progress surface for the user's request, independent of tool volume. */
export function JourneyProgress({ progress, agents, presentation = 'default' }: JourneyProgressProps) {
  const { t } = useTranslation()
  if (presentation === 'codex') return <CodexJourneyProgress progress={progress} agents={agents} />

  const waiting = progress.state === 'waiting'
  const activity = progress.activity ?? describeJourneyActivity([], progress.steps)
  const showAgents = !!agents?.activeCount
  return (
    <section className="px-3 py-4" data-testid="journey-progress" aria-busy={!waiting || showAgents}>
      <div role="status" aria-live="polite" aria-atomic="true">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] font-medium">
          <div className="flex items-center gap-2.5">
            <span aria-hidden="true" className={`size-1.5 rounded-full bg-current ${waiting ? 'text-foreground/40' : 'text-foreground/70 animate-pulse motion-reduce:animate-none'}`} />
            {t(waiting ? 'chat.journey.waiting' : 'chat.journey.running')}
          </div>
          {!showAgents && activity.totalSteps > 0 && (
            <span className="text-xs font-normal text-foreground/50" data-testid="journey-step-count">
              {t('chat.journey.activity.steps', { completed: activity.completedSteps, total: activity.totalSteps })}
            </span>
          )}
        </div>
        {waiting && (
          <p className="mt-1.5 text-[13px] leading-5 text-foreground/55">{t('chat.journey.waitingDescription')}</p>
        )}
        {showAgents ? (
          <div className="mt-2" data-testid="journey-agent-activity">
            <p className="text-xs text-foreground/55">{t('chat.journey.agentsRunning', { count: agents!.activeCount })}</p>
            {agents?.latest?.sessionName && <p className="mt-1 text-[13px] font-medium break-words">{agents.latest.sessionName}</p>}
            <p className="mt-1 text-[13px] leading-5 text-foreground/80 break-words">
              {agents?.latest?.activity.title ?? t('chat.journey.agentActivityUnavailable')}
            </p>
            {agents?.latest?.activity.detail && <p className="mt-1 text-[13px] leading-5 text-foreground/55 break-words">{agents.latest.activity.detail}</p>}
          </div>
        ) : waiting ? null : activity.title ? (
          <div className="mt-2" data-testid="journey-observed-activity" data-activity-source={activity.source}>
            <p className="text-[13px] leading-5 text-foreground/80 break-words">{activity.title}</p>
            {activity.detail && <p className="mt-1 text-[13px] leading-5 text-foreground/55 break-words">{activity.detail}</p>}
          </div>
        ) : (
          <p className="mt-1.5 text-[13px] leading-5 text-foreground/55">{t('chat.journey.activity.unavailable')}</p>
        )}
      </div>
      {showAgents && progress.steps.length > 0 && <p className="mt-4 text-xs text-foreground/55">{t('chat.journey.parentPlan')}</p>}
      <JourneyPlan steps={progress.steps} />
    </section>
  )
}

/** A truthful closing summary, also available when an interrupted provider sends no final. */
export function JourneyOutcome({ outcome, onRetry, retrying = false }: {
  outcome: Outcome
  onRetry?: () => void
  retrying?: boolean
}) {
  const { t } = useTranslation()
  return (
    <section className="mx-3 my-4 border-t border-foreground/10 pt-4 text-[13px] leading-6" data-testid="journey-outcome" data-outcome={outcome.state}>
      <p className="font-medium">{t(`chat.journey.outcome.${outcome.state}`)}</p>
      {outcome.objectiveText && (
        <div className="mt-2">
          <p className="text-xs text-foreground/45">{t('chat.journey.yourRequest')}</p>
          <p className="mt-0.5 whitespace-pre-wrap break-words text-foreground/75">{outcome.objectiveText}</p>
        </div>
      )}
      {!outcome.hasFinalResponse && (
        <p className="mt-2 text-foreground/70">{t(`chat.journey.fallback.${outcome.state}`)}</p>
      )}
      {!!outcome.remainingWork.length && (
        <div className="mt-3">
          <p className="text-xs text-foreground/45">{t('chat.journey.remaining')}</p>
          <ul className="mt-1 list-disc space-y-1 pl-4 text-foreground/75">
            {outcome.remainingWork.map((item, index) => <li key={`${index}:${item}`}>{item}</li>)}
          </ul>
        </div>
      )}
      {!!outcome.validationGaps?.length && (
        <div className="mt-3" data-testid="journey-validation-gaps">
          <p className="font-medium">{t('chat.journey.validationGaps.title')}</p>
          <p className="mt-1 text-foreground/55">{t('chat.journey.validationGaps.description')}</p>
          <ul className="mt-2 list-disc space-y-1 pl-4 text-foreground/75">
            {outcome.validationGaps.map((gap, index) => <li key={`${index}:${gap}`} className="break-words">{gap}</li>)}
          </ul>
        </div>
      )}
      <JourneyPlan steps={outcome.steps ?? []} />
      {outcome.retryUserMessageId && onRetry && (
        <button
          type="button"
          data-testid="retry-interrupted-request"
          disabled={retrying}
          onClick={onRetry}
          className="mt-3 inline-flex items-center gap-2 rounded-md border border-foreground/15 px-3 py-1.5 text-[13px] font-medium hover:bg-foreground/5 disabled:cursor-wait disabled:opacity-50"
        >
          {retrying ? <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin motion-reduce:animate-none" />
            : <RotateCcw aria-hidden="true" className="size-3.5" />}
          {t(retrying ? 'common.retrying' : 'common.retry')}
        </button>
      )}
    </section>
  )
}
