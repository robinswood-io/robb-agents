import * as React from 'react'
import { ChevronDown, ShieldCheck } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { Session } from '../../../shared/types'

export function AutonomyPanel({ session }: { session: Session }) {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)
  const events = session.autonomyEvents ?? []
  if (events.length === 0) return null
  return <div className="mx-auto w-full max-w-3xl px-4 pt-3">
    <div className="rounded-md border border-border/60 bg-muted/20 text-xs text-muted-foreground">
      <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left" onClick={() => setOpen(value => !value)} aria-expanded={open}>
        <ShieldCheck className="h-3.5 w-3.5" /><span className="font-medium text-foreground/80">{t('session.autonomy.title')}</span><span className="ml-auto">{t('session.autonomy.steps', { count: events.length })}</span><ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && <ol className="space-y-2 border-t border-border/50 px-3 py-2">
        {events.slice().reverse().map(event => <li key={event.id} className="border-l-2 border-foreground/15 pl-2">
          <div className="font-medium text-foreground/80">{t(`session.autonomy.phase.${event.phase}`)}{event.toolName ? ` · ${event.toolName}` : ''}</div>
          <div>{event.message}</div>
          {event.escalationReason && <div className="mt-0.5 text-amber-600 dark:text-amber-400">{event.escalationReason}</div>}
        </li>)}
      </ol>}
    </div>
  </div>
}
