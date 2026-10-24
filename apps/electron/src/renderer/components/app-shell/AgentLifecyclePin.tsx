import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Spinner } from '@craft-agent/ui'
import { ShieldAlert } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { SessionMeta } from '@/atoms/sessions'
import type { SessionSubagentSummary } from '@/utils/session-subagent-summary'

export type AgentLifecycleState = 'processing' | 'error' | 'pending_prompt' | 'mission_completed' | 'objective_reopened' | 'idle'

export interface AgentLifecyclePinProps {
  item: SessionMeta
  subagentSummary?: SessionSubagentSummary
  hasPendingPrompt?: boolean
  className?: string
  size?: 'sm' | 'md'
}

export function resolveAgentLifecycleState(
  item: SessionMeta,
  subagentSummary?: SessionSubagentSummary,
  hasPendingPrompt?: boolean
): AgentLifecycleState {
  const isProcessing = item.isProcessing || (subagentSummary?.runningCount ?? 0) > 0
  if (isProcessing) return 'processing'

  if (hasPendingPrompt || item.hasPendingUserInput || item.hasPendingAuth) {
    return 'pending_prompt'
  }

  const isError =
    item.lastMessageRole === 'error' ||
    item.activeObjective?.terminalState === 'exhausted' ||
    item.activeObjective?.terminalState === 'blocked_policy' ||
    item.sessionStatus === 'error' ||
    item.sessionStatus === 'failed'

  if (isError) return 'error'

  const isObjectiveReopened =
    item.activeObjective?.terminalState === 'active' &&
    (item.activeObjective?.acceptanceNeedsReview === true || (item.activeObjective?.amendments?.length ?? 0) > 0)
  if (isObjectiveReopened) return 'objective_reopened'

  const isMissionCompleted = item.activeObjective?.terminalState === 'complete_verified'
  if (isMissionCompleted) return 'mission_completed'

  return 'idle'
}

export function AgentLifecyclePin({
  item,
  subagentSummary,
  hasPendingPrompt,
  className,
  size = 'md',
}: AgentLifecyclePinProps) {
  const { t } = useTranslation()
  const state = resolveAgentLifecycleState(item, subagentSummary, hasPendingPrompt)

  if (state === 'processing') {
    return (
      <span
        title={t('session.statusProcessing', 'En cours d\'exécution')}
        className={cn('flex items-center justify-center shrink-0', className)}
      >
        <Spinner className={cn(size === 'sm' ? 'w-3 h-3' : 'w-3.5 h-3.5', 'text-accent')} />
      </span>
    )
  }

  if (state === 'pending_prompt') {
    return (
      <span
        title={t('session.hasPendingPrompt', 'Confirmation requise')}
        className={cn('flex items-center justify-center text-info animate-pulse shrink-0', className)}
      >
        <ShieldAlert className={cn(size === 'sm' ? 'w-3 h-3' : 'w-3.5 h-3.5')} />
      </span>
    )
  }

  if (state === 'error') {
    return (
      <span
        title={t('session.statusError', 'Erreur survenue')}
        className={cn('relative flex items-center justify-center shrink-0', className)}
      >
        <span
          style={{ '--shadow-color': 'var(--destructive-rgb)' } as React.CSSProperties}
          className={cn(
            'rounded-full bg-destructive shadow-tinted shrink-0 transition-transform duration-150',
            size === 'sm' ? 'w-2 h-2' : 'w-2.5 h-2.5'
          )}
        />
        <span className="absolute w-1 h-1 rounded-full bg-background/40" />
      </span>
    )
  }

  if (state === 'mission_completed') {
    return (
      <span
        title={t('session.statusMissionCompleted', 'Mission accomplie — Ouvrir un nouveau chat conseillé')}
        className={cn('relative flex items-center justify-center shrink-0', className)}
      >
        <span
          style={{ '--shadow-color': 'var(--success-rgb)' } as React.CSSProperties}
          className={cn(
            'rounded-full bg-success shadow-tinted shrink-0 transition-transform duration-150',
            size === 'sm' ? 'w-2 h-2' : 'w-2.5 h-2.5'
          )}
        />
        <span className="absolute w-1 h-1 rounded-full bg-background/40" />
      </span>
    )
  }

  if (state === 'objective_reopened') {
    return (
      <span
        title={t('session.statusObjectiveReopened', 'Objectif rouvert pour approfondissement suite à votre retour')}
        className={cn('relative flex items-center justify-center shrink-0', className)}
      >
        <span
          style={{ '--shadow-color': 'var(--info-rgb)' } as React.CSSProperties}
          className={cn(
            'rounded-full bg-info shadow-tinted shrink-0 transition-transform duration-150 animate-pulse',
            size === 'sm' ? 'w-2 h-2' : 'w-2.5 h-2.5'
          )}
        />
        <span className="absolute w-1 h-1 rounded-full bg-background/60" />
      </span>
    )
  }

  // Idle / Finished turn (prêt pour la suite)
  return (
    <span
      title={t('session.statusIdle', 'Prêt pour la suite')}
      className={cn('relative flex items-center justify-center shrink-0', className)}
    >
      <span
        className={cn(
          'rounded-full bg-accent/80 shadow-xs shrink-0 transition-transform duration-150',
          size === 'sm' ? 'w-1.5 h-1.5' : 'w-2 h-2'
        )}
      />
    </span>
  )
}
