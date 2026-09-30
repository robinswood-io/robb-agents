import * as React from 'react'
import { useTranslation } from 'react-i18next'
import type { UserInputAnswer, UserInputRequest, UserInputResponse, UserInputResponseResult } from '@craft-agent/core/types'
import { USER_INPUT_LIMITS, normalizeUserInputResponse } from '@craft-agent/core'

export interface UserInputCardProps {
  request: UserInputRequest
  readOnly?: boolean
  onRespond?: (sessionId: string, response: UserInputResponse) => Promise<UserInputResponseResult>
  onRecordedRetryChange?: (requestId: string, available: boolean) => void
}

export function userInputAnswersComplete(request: UserInputRequest, answers: UserInputAnswer[]): boolean {
  try { normalizeUserInputResponse(request, { requestId: request.id, answers }); return true }
  catch { return false }
}

export function answersFromUserInputDrafts(request: UserInputRequest, drafts: Record<string, UserInputAnswer>): UserInputAnswer[] {
  return request.questions.map(question => {
    const draft = drafts[question.id]
    return {
      questionId: question.id,
      optionIds: draft?.optionIds ?? [],
      ...(draft?.text?.trim() ? { text: draft.text.trim() } : {}),
    }
  })
}

/** Questions are explicit UI state, never reconstructed from tool log text. */
export function UserInputCard({ request, readOnly = false, onRespond, onRecordedRetryChange }: UserInputCardProps) {
  const { t } = useTranslation()
  const prefix = React.useId()
  const [drafts, setDrafts] = React.useState<Record<string, UserInputAnswer>>({})
  const [sending, setSending] = React.useState(false)
  const sendingRef = React.useRef(false)
  const [error, setError] = React.useState<'requiredAnswer' | 'submitFailed' | null>(null)
  const [ack, setAck] = React.useState<{ status: 'answered' | 'cancelled'; answers?: UserInputAnswer[] }>()
  const status = request.status === 'pending' ? ack?.status ?? request.status : request.status
  const answers = request.status === 'pending' ? ack?.answers : request.answers
  const pending = status === 'pending'
  const interactive = pending && !readOnly && !!onRespond
  const recordedRetryAvailable = status === 'answered' && error === 'submitFailed'
    && !readOnly && !!onRespond && !!request.answers?.length
  React.useEffect(() => {
    onRecordedRetryChange?.(request.id, recordedRetryAvailable)
    return () => onRecordedRetryChange?.(request.id, false)
  }, [request.id, recordedRetryAvailable, onRecordedRetryChange])
  const text = (key: string, fallback: string) => t(`chat.userInput.${key}`, { defaultValue: fallback })

  const update = (questionId: string, patch: Partial<UserInputAnswer>) => {
    setDrafts(previous => ({ ...previous, [questionId]: { ...(previous[questionId] ?? { questionId, optionIds: [] }), ...patch } }))
    setError(null)
  }
  const respond = async (cancelled = false, retryRecordedAnswer = false) => {
    const recordedRetry = retryRecordedAnswer && request.status === 'answered'
      && error === 'submitFailed' && !!request.answers?.length && !readOnly
    if ((!interactive && !recordedRetry) || sendingRef.current || !onRespond) return
    // A response may already be durable even when dispatch fails. Re-submit
    // exactly that accepted response; a draft can belong to another client.
    const submitted = recordedRetry ? request.answers! : answersFromUserInputDrafts(request, drafts)
    if (!cancelled && !userInputAnswersComplete(request, submitted)) { setError('requiredAnswer'); return }
    sendingRef.current = true
    setSending(true)
    if (!recordedRetry) setError(null)
    try {
      const result = await onRespond(request.sessionId, { requestId: request.id, ...(cancelled ? { cancelled: true } : { answers: submitted }) })
      if (!['accepted', 'already_answered', 'cancelled'].includes(result.status)) throw new Error('Unrecognized response receipt')
      // An already-answered receipt must never attribute this local draft to
      // another client's answer. Wait for its authoritative snapshot instead.
      setAck(result.status === 'cancelled' ? { status: 'cancelled' }
        : { status: 'answered', ...(result.status === 'accepted' ? { answers: submitted } : {}) })
      setError(null)
    } catch {
      setError('submitFailed')
    } finally {
      sendingRef.current = false
      setSending(false)
    }
  }

  if (!pending) {
    const summary = request.questions.map(question => {
      const answer = answers?.find(item => item.questionId === question.id)
      if (!answer) return ''
      return [...answer.optionIds.map(id => question.options?.find(option => option.id === id)?.label ?? ''), answer.text].filter(Boolean).join(', ')
    }).filter(Boolean).join(' · ')
    return (
      <div className="mx-3 my-3 text-[13px]" data-testid="user-input-card" data-request-id={request.id} data-status={status}>
      <details className="rounded-lg border border-foreground/10 px-3 py-2">
        <summary className="cursor-pointer text-foreground/65 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">
          <span className="font-medium">{text(status === 'answered' ? 'answered' : 'cancelled', status === 'answered' ? 'Réponse envoyée' : 'Question annulée')}</span>
          {summary && <span className="ml-2 break-words text-foreground/50">{summary.length > 120 ? `${summary.slice(0, 120)}…` : summary}</span>}
        </summary>
        <div className="mt-3 space-y-3">
          {request.questions.map(question => {
            const answer = answers?.find(item => item.questionId === question.id)
            return <div key={question.id}>
              <p className="font-medium">{question.question}</p>
              {answer && <p className="mt-1 whitespace-pre-wrap break-words text-foreground/70">{[
                ...answer.optionIds.map(id => question.options?.find(option => option.id === id)?.label ?? ''), answer.text,
              ].filter(Boolean).join('\n')}</p>}
            </div>
          })}
        </div>
      </details>
      {status === 'answered' && error === 'submitFailed' && <div className="mt-2">
        <p role="alert" className="text-xs text-destructive">{text('resumeFailed', 'Votre réponse est enregistrée, mais la reprise n’a pas pu être confirmée. Réessayez.')}</p>
        {recordedRetryAvailable && <button type="button" disabled={sending}
          data-testid="retry-recorded-user-input" onClick={() => { void respond(false, true) }}
          className="mt-2 rounded-lg bg-foreground px-3 py-2 text-[13px] font-medium text-background disabled:opacity-50">
          {t(sending ? 'common.retrying' : 'common.retry')}
        </button>}
      </div>}
      </div>
    )
  }

  return (
    <section className="mx-3 my-4 rounded-xl border border-foreground/15 bg-foreground/[0.02] p-4" data-testid="user-input-card" data-request-id={request.id} data-status="pending" aria-labelledby={`${prefix}-title`}>
      <h3 id={`${prefix}-title`} className="mb-4 text-sm font-medium">{text('title', 'Votre réponse')}</h3>
      <form onSubmit={event => { event.preventDefault(); void respond() }} aria-busy={sending}>
        <div className="space-y-5">
          {request.questions.map((question, questionIndex) => {
            const draft = drafts[question.id]
            const questionId = `${prefix}-${questionIndex}`
            return (
              <fieldset key={question.id} disabled={!interactive || sending} aria-describedby={question.options?.length ? `${questionId}-hint` : undefined}>
                <legend className="mb-1 text-[13px] font-medium leading-5">{question.question}</legend>
                {!!question.options?.length && <>
                  <p id={`${questionId}-hint`} className="mb-2 text-xs text-foreground/55">{text(question.multiSelect ? 'multipleHint' : 'singleHint', question.multiSelect ? 'Plusieurs choix possibles, ou une réponse libre.' : 'Un choix, ou une réponse libre.')}</p>
                  <div className="space-y-2">
                    {question.options.map((option, optionIndex) => <label key={option.id} htmlFor={`${questionId}-${optionIndex}`} className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-foreground/10 px-3 py-2.5 has-[:checked]:border-foreground/35 has-[:checked]:bg-foreground/5">
                      <input id={`${questionId}-${optionIndex}`} name={questionId} type={question.multiSelect ? 'checkbox' : 'radio'} className="mt-0.5 size-4 shrink-0 accent-current" checked={draft?.optionIds.includes(option.id) ?? false}
                        onChange={event => update(question.id, { optionIds: question.multiSelect
                          ? event.target.checked ? [...(draft?.optionIds ?? []), option.id] : (draft?.optionIds ?? []).filter(id => id !== option.id)
                          : [option.id] })} />
                      <span className="min-w-0 text-[13px] leading-5"><span className="font-medium">{option.label}</span>
                        {option.recommended && <span className="ml-2 text-xs text-foreground/50">{text('recommended', 'Recommandé')}</span>}
                        {option.description && <span className="mt-0.5 block text-foreground/60">{option.description}</span>}
                      </span>
                    </label>)}
                  </div>
                  {!!draft?.optionIds.length && <button type="button" onClick={() => update(question.id, { optionIds: [] })} className="mt-2 text-xs text-foreground/55 underline underline-offset-2">{text('clearSelection', 'Effacer la sélection')}</button>}
                </>}
                <label htmlFor={`${questionId}-text`} className="mb-1 mt-3 block text-xs text-foreground/65">{text('freeTextLabel', 'Réponse libre ou précision')}</label>
                <textarea
                  id={`${questionId}-text`}
                  rows={2}
                  maxLength={USER_INPUT_LIMITS.maxAnswerLength}
                  value={draft?.text ?? ''}
                  onChange={event => update(question.id, { text: event.target.value })}
                  onKeyDown={event => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault()
                      void respond()
                    }
                  }}
                  placeholder={text('freeTextPlaceholder', 'Écrivez votre réponse…')}
                  className="w-full resize-y rounded-lg border border-foreground/15 bg-background px-3 py-2 text-[13px] leading-5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
                />
              </fieldset>
            )
          })}
        </div>
        {error && <p role="alert" className="mt-3 text-xs text-destructive">{text(error, error === 'requiredAnswer' ? 'Répondez à chaque question, avec un choix ou du texte.' : 'La réponse n’a pas été envoyée. Vous pouvez réessayer.')}</p>}
        {interactive ? <div className="mt-4 flex flex-wrap items-center gap-3">
          <button type="submit" disabled={sending} className="rounded-lg bg-foreground px-3 py-2 text-[13px] font-medium text-background disabled:opacity-50">{text(sending ? 'submitting' : 'submit', sending ? 'Envoi…' : 'Envoyer la réponse')}</button>
          <button type="button" disabled={sending} onClick={() => { void respond(true) }} className="rounded-lg px-2 py-2 text-[13px] text-foreground/55 disabled:opacity-50">{text('cancel', 'Annuler')}</button>
        </div> : <p className="mt-3 text-xs text-foreground/50">{text('readOnlyPending', 'Une réponse est attendue dans la conversation active.')}</p>}
      </form>
    </section>
  )
}
