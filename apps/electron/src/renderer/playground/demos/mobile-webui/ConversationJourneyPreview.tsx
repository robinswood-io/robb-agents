import * as React from 'react'
import { useStore } from 'jotai'
import type { Message, UserInputRequest, UserInputResponse } from '@craft-agent/core/types'
import type { ActiveSessionObjective } from '@craft-agent/shared/sessions'
import type { PermissionRequest, Session } from '../../../../shared/types'
import { ChatDisplay } from '@/components/app-shell/ChatDisplay'
import { AppShellProvider, useAppShellContext } from '@/context/AppShellContext'
import { sessionAtomFamily } from '@/atoms/sessions'
import { MobilePlaygroundProviders } from './MobilePlaygroundProviders'
import { buildMockSession, MOBILE_WORKSPACE_ID, MOCK_LLM_CONNECTIONS, MOCK_SESSION_STATUSES } from './mock-mobile-data'

export type JourneyScenario = 'working' | 'checking' | 'succeeded' | 'failed' | 'final-rejected' | 'final-recovery' | 'final-child' | 'final-produced-checking' | 'final-produced-verified' | 'final-produced-history' | 'final-malformed-checking' | 'permission' | 'permission-recovery' | 'question-single' | 'question-multiple' | 'question-free' | 'question-answered' | 'question-child' | 'question-error' | 'question-dispatch-error' | 'question-restored' | 'question-busy'
type Viewport = 'desktop' | 'mobile'

export const JOURNEY_SCENARIOS: { value: JourneyScenario; label: string }[] = [
  { value: 'working', label: 'En cours' },
  { value: 'checking', label: 'Vérification' },
  { value: 'succeeded', label: 'Réussite vérifiée' },
  { value: 'failed', label: 'Échec sans réponse finale' },
  { value: 'final-rejected', label: 'Bilan reçu · validation refusée' },
  { value: 'final-recovery', label: 'Bilan reçu · reprise en attente' },
  { value: 'final-child', label: 'Bilan reçu · agent délégué actif' },
  { value: 'final-produced-checking', label: 'Livrable produit · vérification en cours' },
  { value: 'final-produced-verified', label: 'Livrable produit · résumé final vérifié' },
  { value: 'final-produced-history', label: 'Livrable conservé · nouvelle demande' },
  { value: 'final-malformed-checking', label: 'Livrable produit · reçu en réparation' },
  { value: 'permission', label: 'Autorisation requise' },
  { value: 'permission-recovery', label: 'Autorisation à redemander après redémarrage' },
  { value: 'question-single', label: 'Question · choix unique' },
  { value: 'question-multiple', label: 'Questions · choix multiples' },
  { value: 'question-free', label: 'Question · texte libre' },
  { value: 'question-answered', label: 'Question · réponse reçue' },
  { value: 'question-child', label: 'Question · agent délégué' },
  { value: 'question-error', label: 'Question · erreur puis nouvelle tentative' },
  { value: 'question-dispatch-error', label: 'Question · réponse enregistrée, reprise en erreur' },
  { value: 'question-restored', label: 'Question · historique en chargement' },
  { value: 'question-busy', label: 'Question · travail en parallèle' },
]

const SESSION_ID = 'playground-conversation-journey'
const USER_ID = 'journey-user'
const TIMESTAMP = Date.UTC(2026, 8, 7, 14)
const REQUEST = 'Prépare le lancement de mon livre : une page de présentation et un email pour les lecteurs. Vérifie que les deux reprennent les mêmes informations.'
const STEPS = ['Rassembler les informations du livre', 'Préparer la page et l’email', 'Vérifier la cohérence des deux supports']

/** Technical sentinels must remain in the audit data but never in the public transcript. */
export const JOURNEY_HIDDEN_SENTINELS = [
  'TECH_TOOL_SENTINEL', 'TECH_COMMENTARY_SENTINEL', 'TECH_WARNING_SENTINEL',
  'TECH_CHILD_SENTINEL', 'TECH_INTERNAL_SENTINEL', 'TECH_RETRY_SENTINEL',
  'TECH_STATUS_SENTINEL', 'TECH_FAILED_PLAN_SENTINEL', 'TECH_ERROR_SENTINEL',
]

export function buildJourneyFixture(scenario: JourneyScenario): { session: Session; pendingPermission?: PermissionRequest } {
  const successful = scenario === 'succeeded' || scenario === 'final-child'
  const checking = scenario === 'checking' || successful
  const todos = STEPS.map((content, index) => ({
    content,
    status: successful || index < (checking ? 2 : 1) ? 'completed' as const
      : index === (checking ? 2 : 1) ? 'in_progress' as const : 'pending' as const,
  }))
  const messages: Message[] = [
    { id: USER_ID, role: 'user', content: REQUEST, timestamp: TIMESTAMP },
    { id: 'journey-commentary', role: 'assistant', content: 'TECH_COMMENTARY_SENTINEL: dispatching parallel agents and retrying transport.', isIntermediate: true, timestamp: TIMESTAMP + 1 },
    { id: 'journey-spawn', role: 'tool', content: 'TECH_TOOL_SENTINEL', toolResult: 'TECH_TOOL_SENTINEL child-session-created', toolName: 'mcp__session__spawn_session', toolUseId: 'journey-spawn-call', toolInput: { prompt: 'Draft the book page' }, toolStatus: 'completed', toolExecuted: true, timestamp: TIMESTAMP + 2 },
    { id: 'journey-child', role: 'assistant', content: 'TECH_CHILD_SENTINEL: child review details', parentToolUseId: 'journey-spawn-call', timestamp: TIMESTAMP + 3 },
    { id: 'journey-internal', role: 'user', content: 'TECH_INTERNAL_SENTINEL: report from specialist', internalOrigin: { kind: 'agent-message', senderSessionId: 'journey-specialist' }, timestamp: TIMESTAMP + 4 },
    { id: 'journey-warning', role: 'info', content: 'TECH_WARNING_SENTINEL: transport fallback pass 2', infoLevel: 'warning', timestamp: TIMESTAMP + 5 },
    { id: 'journey-retry', role: 'user', content: 'TECH_RETRY_SENTINEL: continue the original objective', hidden: true, timestamp: TIMESTAMP + 6 },
    { id: 'journey-status', role: 'status', content: 'TECH_STATUS_SENTINEL: compacting', timestamp: TIMESTAMP + 7 },
    { id: 'journey-plan', role: 'tool', content: 'Plan updated', toolName: 'mcp__session__update_plan', toolUseId: 'journey-plan-call', toolInput: { plan: todos.map(todo => ({ step: todo.content, status: todo.status })), explanation: checking ? 'La page et l’email sont rédigés. Je vérifie leur cohérence.' : 'Les informations du livre sont rassemblées. Je rédige la page et l’email.' }, toolResult: 'Plan updated', toolExecuted: true, toolStatus: 'completed', timestamp: TIMESTAMP + 8 },
    // A later rejected update must not replace the confirmed checklist.
    { id: 'journey-failed-plan', role: 'tool', content: 'TECH_FAILED_PLAN_SENTINEL', toolName: 'TodoWrite', toolUseId: 'journey-failed-plan-call', toolInput: { todos: [{ content: 'TECH_FAILED_PLAN_SENTINEL', status: 'completed' }] }, toolResult: 'Permission denied', toolExecuted: false, toolStatus: 'error', isError: true, timestamp: TIMESTAMP + 9 },
  ]
  if (scenario === 'working' || scenario === 'checking') messages.push({ id: 'journey-composing', role: 'status', content: 'Le modèle élabore la réponse', timestamp: TIMESTAMP + 9.5 })
  const activeObjective: ActiveSessionObjective = {
    schemaVersion: 1, objectiveId: 'journey-objective', userMessageId: USER_ID, lastUserMessageId: USER_ID,
    originalText: REQUEST, startedAt: TIMESTAMP, budgetBaselineUsd: 0, tokenBaseline: 0,
    continuationCount: 2, orchestrationMode: 'mission', risk: 'standard',
    completionCriteria: ['requested-outcome-delivered', 'relevant-checks-passed', 'no-safe-work-remaining'],
    terminalState: successful ? 'complete_verified' : scenario === 'failed' ? 'exhausted' : 'active',
  }
  if (successful) {
    messages.push({ id: 'journey-check', role: 'tool', content: 'TECH_TOOL_SENTINEL', toolName: 'mcp__documents__verify', toolUseId: 'journey-check-call', toolResult: '{"pageReady":true,"emailReady":true,"consistent":true}', toolStatus: 'completed', toolExecuted: true, timestamp: TIMESTAMP + 10 })
    messages.push({ id: 'journey-final', role: 'assistant', content: 'La page de présentation et l’email pour vos lecteurs sont prêts. J’ai vérifié le titre, la date de sortie et le lien du livre : les deux supports sont cohérents.\n\nVous pouvez maintenant relire les textes et choisir quand les publier.', timestamp: TIMESTAMP + 11 })
    // This fixture models the host-accepted snapshot, not merely a receipt printed by a model.
    activeObjective.lastOutcome = {
      state: 'complete_verified',
      criteria: activeObjective.completionCriteria.map(id => ({ id, satisfied: true, evidence: ['journey-check-call'] })),
      remainingWork: [], blocker: null,
    }
    activeObjective.completedAt = TIMESTAMP + 12
  } else if (scenario === 'failed') {
    messages.push({ id: 'journey-error', role: 'error', content: 'TECH_ERROR_SENTINEL: provider quota exhausted before a final response', errorCode: 'rate_limit', timestamp: TIMESTAMP + 10 })
  }
  const session: Session = {
    ...buildMockSession(SESSION_ID, { name: 'Préparer le lancement du livre', messages, isProcessing: scenario === 'working' || scenario === 'checking' || scenario === 'permission' }),
    activeObjective,
    ...(scenario === 'checking' ? { pendingTurnRecovery: { userMessageId: USER_ID, startedAt: TIMESTAMP, attempts: 2, lastCause: 'objective_incomplete' as const } } : {}),
  }
  if (scenario === 'final-rejected' || scenario === 'final-recovery') {
    messages.push({ id: 'journey-final', role: 'assistant', timestamp: TIMESTAMP + 11,
      content: 'La page de présentation et l’email sont rédigés. La vérification de leur cohérence reste à terminer.',
      isIntermediate: scenario === 'final-rejected',
      ...(scenario === 'final-rejected' ? { objectiveOutcomeError: 'malformed objective outcome receipt' } : {}),
    })
    if (scenario === 'final-rejected') {
      activeObjective.terminalState = 'exhausted'
      messages.push({ id: 'journey-error', role: 'error', timestamp: TIMESTAMP + 12,
        content: 'La validation de la demande a été interrompue.', errorCode: 'objective_validation_failed',
        errorDetails: ['criterion lacks observed evidence: relevant-checks-passed',
          'missing criterion: no-safe-work-remaining'] })
    } else session.pendingTurnRecovery = { userMessageId: USER_ID, startedAt: TIMESTAMP,
      attempts: 1, lastCause: 'objective_incomplete', lastAttemptAt: TIMESTAMP + 10 }
  }
  if (scenario.startsWith('question-')) {
    const request: UserInputRequest = {
      id: `journey-question-${scenario}`, sessionId: ['question-child', 'question-busy', 'question-answered'].includes(scenario) ? 'playground-question-worker' : SESSION_ID,
      originWorkspaceId: MOBILE_WORKSPACE_ID, createdAt: TIMESTAMP + 10, objectiveUserMessageId: USER_ID,
      status: scenario === 'question-answered' ? 'answered' : 'pending',
      questions: [{ id: 'audience', question: 'À quels lecteurs souhaitez-vous présenter le livre ?',
        ...(scenario === 'question-free' ? {} : { options: [
          { id: 'existing', label: 'Lecteurs de la newsletter', description: 'Ils connaissent déjà votre travail.', recommended: true },
          { id: 'new', label: 'Nouveaux lecteurs', description: 'Présenter le livre et son univers.' },
        ] }), multiSelect: scenario === 'question-multiple',
      }, ...(scenario === 'question-multiple' ? [{ id: 'tone', question: 'Quel ton souhaitez-vous employer ?' }] : [])],
      ...(scenario === 'question-answered' ? { answeredAt: TIMESTAMP + 11, answers: [{ questionId: 'audience', optionIds: ['existing'], text: 'Avec une invitation à partager le livre.' }] } : {}),
    }
    session.userInputRequests = [request]
    session.isProcessing = false
    if (scenario === 'question-restored') session.messages = []
  }
  if (scenario === 'permission-recovery') {
    session.pendingTurnRecovery = { userMessageId: USER_ID, startedAt: TIMESTAMP, attempts: 0,
      waitingForPermission: { requestId: 'journey-restarted-permission', requestedAt: TIMESTAMP + 10,
        toolName: 'Write', recoveryRequired: true } }
  }
  if (scenario.startsWith('final-produced-') || scenario === 'final-malformed-checking') {
    const historical = scenario === 'final-produced-history'
    const verified = scenario === 'final-produced-verified' || historical
    const request = 'Écris 300 lignes numérotées au format N : REPRISE-OK.'
    const receipt = { state: 'complete_verified' as const, criteria: [], remainingWork: [], blocker: null }
    session.name = 'Conserver le livrable pendant sa validation'
    session.messages = [
      { id: USER_ID, role: 'user', content: request, timestamp: TIMESTAMP },
      { id: 'journey-produced', role: 'assistant', timestamp: TIMESTAMP + 1, isIntermediate: true,
        content: Array.from({ length: 300 }, (_, index) => `${index + 1} : REPRISE-OK`).join('\n'),
        ...(scenario === 'final-malformed-checking'
          ? { objectiveOutcomeError: 'malformed objective outcome receipt' } : { objectiveOutcome: receipt }) },
      { id: 'journey-hidden-recovery', role: 'user', timestamp: TIMESTAMP + 2, hidden: true, content: 'TECH_RETRY_SENTINEL' },
      { id: 'journey-check-commentary', role: 'assistant', timestamp: TIMESTAMP + 3, isIntermediate: true,
        content: 'Les lignes sont produites ; je vérifie leur conformité.' },
      ...(verified ? [{ id: 'journey-verified-summary', role: 'assistant' as const, timestamp: TIMESTAMP + 4,
        content: 'Les 300 lignes sont vérifiées.', objectiveOutcome: receipt }] : []),
    ]
    session.isProcessing = !verified
    session.activeObjective = { ...activeObjective, originalText: request, continuationCount: 1,
      terminalState: verified ? 'complete_verified' : 'active',
      ...(verified ? { lastOutcome: receipt, completedAt: TIMESTAMP + 5 } : {}),
    }
    session.pendingTurnRecovery = verified ? undefined : { userMessageId: USER_ID, startedAt: TIMESTAMP,
      attempts: 1, lastCause: 'objective_incomplete', lastAttemptAt: TIMESTAMP + 2 }
    if (historical) {
      const nextRequest = { id: 'journey-new-user', role: 'user' as const, timestamp: TIMESTAMP + 6,
        content: 'Nouvelle demande : prépare une courte introduction.' }
      session.messages.push(nextRequest)
      session.isProcessing = true
      session.activeObjective = { ...activeObjective, objectiveId: nextRequest.id,
        userMessageId: nextRequest.id, lastUserMessageId: nextRequest.id, originalText: nextRequest.content,
        startedAt: nextRequest.timestamp, terminalState: 'active', continuationCount: 0 }
    }
  }
  return {
    session,
    ...(scenario === 'permission' ? { pendingPermission: {
      sessionId: SESSION_ID, requestId: 'journey-permission', toolName: 'Write', type: 'file_write' as const,
      description: 'Enregistrer la page et l’email dans le dossier de lancement du livre.',
    } } : {}),
  }
}

function PreviewMode({ viewport, children }: { viewport: Viewport; children: React.ReactNode }) {
  const parent = useAppShellContext()
  const value = React.useMemo(() => ({ ...parent, isCompactMode: viewport === 'mobile' }), [parent, viewport])
  return <AppShellProvider value={value}>{children}</AppShellProvider>
}

function HydrateDelegatedActivity({ sessions }: { sessions: Session[] }) {
  const store = useStore()
  React.useEffect(() => {
    for (const session of sessions) store.set(sessionAtomFamily(session.id), session)
  }, [sessions, store])
  return null
}

/** Production ChatDisplay, isolated contexts and fabricated data: no server or agent calls. */
export function ConversationJourneyPreview({ scenario = 'working', viewport = 'desktop' }: { scenario?: JourneyScenario; viewport?: Viewport }) {
  const [selected, setSelected] = React.useState(scenario)
  const [size, setSize] = React.useState(viewport)
  const [input, setInput] = React.useState('')
  React.useEffect(() => setSelected(scenario), [scenario])
  React.useEffect(() => setSize(viewport), [viewport])
  const fixture = React.useMemo(() => buildJourneyFixture(selected), [selected])
  const activeChildren = React.useMemo<Session[]>(() => {
    if (selected !== 'question-busy' && selected !== 'question-answered') return []
    const answered = selected === 'question-answered'
    return [{ ...buildMockSession(answered ? 'playground-question-worker' : 'playground-review-worker', {
      name: answered ? 'Présentation aux lecteurs' : 'Vérification de la page du livre',
      isProcessing: true,
      messages: [
        { id: 'child-commentary', role: 'assistant', isIntermediate: true, timestamp: TIMESTAMP + 20,
          content: answered ? 'Je prépare le texte pour les lecteurs de la newsletter, avec une invitation à partager le livre.'
            : 'Je compare les informations de la page avec le dossier de lancement.' },
        { id: 'child-tool', role: 'tool', toolName: 'Read', toolStatus: 'executing', timestamp: TIMESTAMP + 21,
          content: '', toolIntent: answered ? 'Lecture du brouillon destiné à la newsletter' : 'Vérification du titre et de la date de sortie',
          toolInput: { path: 'TECH_TOOL_SENTINEL' } },
      ],
    }), parentSessionId: SESSION_ID }]
  }, [selected])
  const descendantMetadata = React.useMemo(() => [
    { id: SESSION_ID, workspaceId: MOBILE_WORKSPACE_ID, isProcessing: fixture.session.isProcessing },
    { id: 'journey-active-child', workspaceId: MOBILE_WORKSPACE_ID, parentSessionId: SESSION_ID,
      isProcessing: selected === 'final-child' },
    ...activeChildren,
  ], [selected, fixture.session.isProcessing, activeChildren])
  const [resolvedQuestions, setResolvedQuestions] = React.useState<UserInputRequest[] | null>(null)
  const [responseTarget, setResponseTarget] = React.useState('')
  const [responsePayloads, setResponsePayloads] = React.useState<UserInputResponse[]>([])
  const failFirstRef = React.useRef(true)
  React.useEffect(() => { setResolvedQuestions(null); setResponseTarget(''); setResponsePayloads([]); failFirstRef.current = true }, [selected])
  const visibleSession = { ...fixture.session, ...(resolvedQuestions ? { userInputRequests: resolvedQuestions, isProcessing: selected !== 'question-dispatch-error' } : {}) }
  return (
    <div className="flex h-full w-full flex-col items-center gap-3" data-testid="journey-demo" data-response-target={responseTarget} data-response-payloads={JSON.stringify(responsePayloads)}>
      <div className="flex w-full flex-wrap items-center gap-3 text-xs">
        <select aria-label="Scénario du parcours" value={selected} onChange={event => setSelected(event.target.value as JourneyScenario)} className="rounded-md border bg-background px-2 py-1.5">
          {JOURNEY_SCENARIOS.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
        </select>
        <select aria-label="Format du parcours" value={size} onChange={event => setSize(event.target.value as Viewport)} className="rounded-md border bg-background px-2 py-1.5">
          <option value="desktop">Ordinateur</option><option value="mobile">Mobile · 390 px</option>
        </select>
        <span className="text-muted-foreground">Données fictives · aucune action externe</span>
      </div>
      <div data-testid="journey-demo-chat" data-scenario={selected} data-viewport={size} className="@container/shell @container/panel relative min-h-0 flex-1 overflow-hidden rounded-lg border bg-background" style={{ width: size === 'mobile' ? 390 : '100%', maxWidth: '100%' }}>
        <MobilePlaygroundProviders session={visibleSession} sessions={descendantMetadata} llmConnections={MOCK_LLM_CONNECTIONS}>
          <HydrateDelegatedActivity sessions={activeChildren} />
          <PreviewMode viewport={size}>
            <ChatDisplay
              session={visibleSession} pendingPermission={fixture.pendingPermission}
              messagesLoading={selected === 'question-restored'}
              onRespondToUserInput={async (originSessionId, response) => {
                setResponsePayloads(previous => [...previous, response])
                if (selected === 'question-error' && failFirstRef.current) { failFirstRef.current = false; throw new Error('Fixture network unavailable') }
                if (selected === 'question-dispatch-error') {
                  if (failFirstRef.current) {
                    failFirstRef.current = false
                    // Model another window's authoritative answer arriving
                    // before this caller learns dispatch failed. A retry must
                    // use the stored answer, never this caller's older draft.
                    setResolvedQuestions((fixture.session.userInputRequests ?? []).map(request => ({ ...request,
                      status: 'answered', answeredAt: Date.now(),
                      answers: [{ questionId: 'audience', optionIds: ['new'], text: 'Réponse enregistrée depuis une autre fenêtre.' }],
                    })))
                    throw new Error('Fixture dispatch failed after durable answer')
                  }
                  await new Promise(resolve => window.setTimeout(resolve, 400))
                  return { status: 'already_answered', delivery: 'started' }
                }
                setResponseTarget(originSessionId)
                setResolvedQuestions((fixture.session.userInputRequests ?? []).map(request => request.id === response.requestId
                  ? { ...request, status: response.cancelled ? 'cancelled' : 'answered', answers: response.answers, answeredAt: Date.now() } : request))
                return { status: response.cancelled ? 'cancelled' : 'accepted', delivery: 'steered' }
              }}
              onSendMessage={() => {}} onOpenFile={() => {}} onOpenUrl={() => {}} onRespondToPermission={() => {}}
              currentModel="haiku" onModelChange={() => {}} permissionMode="ask"
              inputValue={input} onInputChange={setInput}
              sessionStatuses={MOCK_SESSION_STATUSES} workspaceId={MOBILE_WORKSPACE_ID}
              compactMode={size === 'mobile'} enableCompactModelPicker
            />
          </PreviewMode>
        </MobilePlaygroundProviders>
      </div>
    </div>
  )
}
