import * as React from 'react'
import { useStore } from 'jotai'
import { useTranslation } from 'react-i18next'
import { LoaderCircle, RotateCcw } from 'lucide-react'
import { toast } from 'sonner'
import { sessionAtomFamily } from '@/atoms/sessions'
import type { SessionPermissionRecovery } from '@/atoms/session-permission-recovery'
import { createRetryTurnAction } from './retry-turn-action'

/** Restarting the turn asks for a fresh decision; it never grants permission. */
export function PermissionRecoveryCard({ request, showSessionName = false }: {
  request: SessionPermissionRecovery
  showSessionName?: boolean
}) {
  const { t } = useTranslation()
  const store = useStore()
  const [retrying, setRetrying] = React.useState(false)
  const retry = React.useMemo(() => createRetryTurnAction({
    sessionId: request.sessionId,
    sessionCommand: (sessionId, command) => window.electronAPI.sessionCommand(sessionId, command),
    isProcessing: () => !!store.get(sessionAtomFamily(request.sessionId))?.isProcessing,
    onPendingChange: setRetrying,
    onAlreadyRunning: () => toast.info(t('chat.retryAlreadyRunning')),
    onError: error => toast.error(t('chat.retryFailed'), {
      description: error instanceof Error ? error.message : String(error),
    }),
  }), [request.sessionId, store, t])

  return (
    <section className="mx-3 my-4 rounded-lg border border-foreground/10 p-4 text-[13px] leading-6" data-testid="permission-recovery">
      <p className="font-medium">{t('chat.permissionRecovery.title')}</p>
      {showSessionName && request.sessionName && <p className="mt-1 text-foreground/75">{request.sessionName}</p>}
      <p className="mt-1 text-foreground/65">{t('chat.permissionRecovery.description')}</p>
      <button type="button" disabled={retrying} onClick={() => { void retry(request.userMessageId) }}
        className="mt-3 inline-flex items-center gap-2 rounded-md border border-foreground/15 px-3 py-1.5 font-medium hover:bg-foreground/5 disabled:cursor-wait disabled:opacity-50">
        {retrying ? <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin motion-reduce:animate-none" />
          : <RotateCcw aria-hidden="true" className="size-3.5" />}
        {t(retrying ? 'common.retrying' : 'chat.permissionRecovery.resume')}
      </button>
    </section>
  )
}
