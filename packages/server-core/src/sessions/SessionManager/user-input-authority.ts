import { LEGACY_USER_INPUT_ANSWER_MESSAGE_PREFIX, USER_INPUT_ANSWER_MESSAGE_PREFIX, type UserInputRequest, type UserInputQuestion } from "@craft-agent/core";
import { MODEL_REGISTRY } from "@craft-agent/shared/config";
import type { ManagedSession } from './managed-session.ts';
import type { SourceActivationRestartHost } from './source-activation.ts';

const AUTHENTICATED_USER_ANSWER_MARKER = '[host-authenticated-user-answer:v1]'

export const AUTHENTICATED_USER_AUTHORIZATION_MARKER = '[host-authenticated-user-authorization:v1]'

export const MAX_CLEAN_RETRY_SAFE_SETUP_FAILURES = 4

export const MAX_CLEAN_RETRY_CONDITIONAL_SETUP_FAILURES = 2

export const MAX_CLEAN_RETRY_SETUP_BACKOFF_MS = 30 * 60 * 1_000

export const CLEAN_RETRY_SETUP_FAILURE_CLASSES = new Set([
  'interactive-auth-required', 'credential-required', 'permission-denied', 'invalid-input',
  'conflict', 'rate-limited', 'timeout', 'network-unavailable',
  'execution-bridge-unavailable', 'service-unavailable', 'resource-exhausted',
  'model-unavailable', 'backend-init-failed', 'sandbox-denied', 'unknown',
])

export const CLEAN_RETRY_NEVER_SETUP_FAILURE_CLASSES = new Set([
  'interactive-auth-required', 'credential-required', 'permission-denied',
  'invalid-input', 'sandbox-denied',
])

export const CLEAN_RETRY_CONDITIONAL_SETUP_FAILURE_CLASSES = new Set([
  'conflict', 'rate-limited', 'resource-exhausted', 'model-unavailable',
  'backend-init-failed',
])

export const CONTEXT_LIMIT_NEXT_STEP_QUESTIONS: UserInputQuestion[] = [{
  id: 'context-limit-next-step',
  question: 'La limite sûre de contexte est atteinte et aucun transfert autonome borné ne peut être prouvé. Quelle suite souhaitez-vous ?',
  options: [
    {
      id: 'provide-guidance',
      label: 'Préciser la reprise',
      description: 'Fournissez uniquement le fait ou le choix manquant pour reprendre avec un contexte neuf.',
      recommended: true,
    },
    {
      id: 'stop-objective',
      label: 'Arrêter cette mission',
      description: 'Conserver les résultats actuels sans nouvel appel fournisseur.',
    },
  ],
}]

// Retained solely to retire prompts emitted by older hosts. Retry exhaustion
// is a terminal machine state, not evidence that a human can provide a fact.
export const LEGACY_AUTOMATIC_RECOVERY_NEXT_STEP_QUESTION: UserInputQuestion = {
  id: 'automatic-recovery-next-step',
  question: 'Les stratégies autonomes sûres ont été épuisées sans preuve suffisante pour terminer. Quelle suite souhaitez-vous ?',
  options: [
    {
      id: 'resume-with-guidance',
      label: 'Préciser puis reprendre',
      description: 'Ajoutez l’information ou le choix manquant afin que la mission reprenne sur le même objectif.',
      recommended: true,
    },
    {
      id: 'stop-objective',
      label: 'Arrêter cette mission',
      description: 'Conserver les résultats actuels et ne plus lancer de tentative automatique.',
    },
  ],
}

export const COST_LIMIT_NEXT_STEP_QUESTIONS: UserInputQuestion[] = [{
  id: 'cost-limit-next-step',
  question: 'La limite monétaire dure de cette mission est atteinte. Tout nouvel appel fournisseur est arrêté. Quelle suite souhaitez-vous ?',
  options: [
    {
      id: 'stop-objective',
      label: 'Arrêter cette mission',
      description: 'Conserver les résultats actuels sans reprise automatique supplémentaire.',
      recommended: true,
    },
    {
      id: 'continue-once',
      label: 'Autoriser une reprise',
      description: 'Autoriser explicitement un unique tour utilisateur ; toute nouvelle reprise automatique sera de nouveau arrêtée.',
    },
  ],
}]

export const LEGACY_ALLOCATED_CONTEXT_LIMIT_PROMPT_WINDOW_MS = 5 * 60 * 1_000

export function resolveManagedSessionContextWindow(managed: ManagedSession): number | undefined {
  if (managed.tokenUsage?.contextWindow && Number.isFinite(managed.tokenUsage.contextWindow)) {
    return managed.tokenUsage.contextWindow
  }
  const modelName = (managed.activeObjective?.model ?? managed.model ?? '').trim().toLowerCase()
  if (!modelName) return undefined
  if (modelName.includes('[1m]')) return 1_000_000
  const bareModelName = modelName.includes('/') ? modelName.split('/').pop()! : modelName
  const registered = MODEL_REGISTRY.find(entry => {
    const id = entry.id.toLowerCase()
    return id === modelName || id === bareModelName
  })
  if (registered?.contextWindow && Number.isFinite(registered.contextWindow)) {
    return registered.contextWindow
  }
  if (modelName.includes('gpt-5.6')) return 1_050_000
  if (modelName.includes('gpt-6') || modelName.includes('gpt-5') || modelName.includes('codex')) return 272_000
  if (modelName.includes('gemini')) return 1_000_000
  if (modelName.includes('opus-5') || modelName.includes('opus-4-7') || modelName.includes('opus-4-8')
    || modelName.includes('sonnet-5') || modelName.includes('fable-5')) return 1_000_000
  if (modelName.includes('mistral-vibe')) return 262_144
  if (modelName.includes('claude') || modelName.includes('anthropic')) return 200_000
  if (modelName.includes('gpt-4') || modelName.includes('o1') || modelName.includes('o3')) return 128_000
  if (modelName.includes('deepseek')) return 128_000
  return 200_000
}

export function isExactContextLimitNextStepQuestion(request: UserInputRequest): boolean {
  return JSON.stringify(request.questions) === JSON.stringify(CONTEXT_LIMIT_NEXT_STEP_QUESTIONS)
}

function isExactCostLimitNextStepQuestion(request: UserInputRequest): boolean {
  return JSON.stringify(request.questions) === JSON.stringify(COST_LIMIT_NEXT_STEP_QUESTIONS)
}

export function isCostLimitContinuationAnswer(request: UserInputRequest): boolean {
  return isExactCostLimitNextStepQuestion(request)
    && request.answers?.some(answer => (
      answer.questionId === 'cost-limit-next-step'
      && answer.optionIds.includes('continue-once')
    )) === true
}

export function userInputAnswerMessageContent(
  requestId: string,
  questions: readonly UserInputQuestion[],
  answers: NonNullable<UserInputRequest['answers']>,
): string {
  return USER_INPUT_ANSWER_MESSAGE_PREFIX
    + JSON.stringify({ requestId, questions, answers })
}

export function legacyUserInputAnswerMessageContent(
  requestId: string,
  questions: readonly UserInputQuestion[],
  answers: NonNullable<UserInputRequest['answers']>,
): string {
  return LEGACY_USER_INPUT_ANSWER_MESSAGE_PREFIX
    + JSON.stringify({ requestId, questions, answers })
}

export function canonicalUserInputAnswerContents(request: UserInputRequest): string[] {
  if (!request.answers?.length) return []
  return [
    userInputAnswerMessageContent(request.id, request.questions, request.answers),
    legacyUserInputAnswerMessageContent(request.id, request.questions, request.answers),
  ]
}

function foldedUserInputAnswer(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/gu, '').toLowerCase()
    .replace(/[’']/gu, ' ').replace(/[^a-z0-9]+/gu, ' ').trim()
}

const STRUCTURED_ANSWER_ACTION_FAMILIES = [
  '(?:deploie|deployer|deploiement|deploy|deployment)',
  '(?:modifie|modifier|modification|corrige|corriger|correction|applique|appliquer|modify|modification|fix|apply)',
  '(?:execute|execution|executer|execute|execution)',
  '(?:change|changer|changement|change)',
  '(?:ecris|ecrire|write)',
  '(?:envoie|envoyer|envoi|send)',
  '(?:publie|publier|publication|publish)',
  '(?:paie|payer|paiement|pay)',
  '(?:pousse|pousser|push)',
  '(?:demarre|demarrer|redemarre|redemarrer|redemarrage|start|restart)',
  '(?:transfere|transferer|transfert|transfer)',
  '(?:supprime|supprimer|suppression|delete)',
  '(?:cree|creer|creation|create)',
] as const

function structuredAnswerNegatesAction(text: string, action: string): boolean {
  return new RegExp(`\\b(?:sans (?:aucun |aucune )?|without (?:any )?)${action}\\b`, 'u').test(text)
    || new RegExp(`\\b(?:pas de|sauf|hors|except|excluding) ${action}\\b`, 'u').test(text)
    || new RegExp(`\\b(?:do not|don t|never)\\b.{0,80}\\b${action}\\b`, 'u').test(text)
    || new RegExp(`\\b(?:ne|n) (?:pas|jamais|plus|rien)\\b.{0,80}\\b${action}\\b`, 'u').test(text)
    || new RegExp(`\\b(?:ne|n)\\b.{0,80}\\b${action}\\b.{0,80}\\b(?:pas|jamais|plus|rien)\\b`, 'u').test(text)
    || new RegExp(`\\b${action}\\s+(?:absolutely\\s+)?nothing\\b`, 'u').test(text)
    || new RegExp(`\\b(?:je )?refuse(?:r)? (?:de|d)\\b.{0,40}\\b${action}\\b`, 'u').test(text)
}

function structuredAnswerMentionsAction(text: string, action: string): boolean {
  return new RegExp(`\\b${action}\\b`, 'u').test(text)
}

function answerAffirmativelyConfirmsDisplayedScope(
  question: UserInputQuestion,
  answer: NonNullable<UserInputRequest['answers']>[number],
): boolean {
  if (answer.optionIds.length !== 1) return false
  const selected = question.options?.find(option => option.id === answer.optionIds[0])
  if (!selected) return false
  const label = foldedUserInputAnswer(selected.label)
  const affirmative = /^(?:oui|yes|autorise|authorize|approve|approuve|confirm|confirme|procede|proceed|continue|go ahead|execute|applique|corrige|deploie|deploy)(?:\b|$)/u.test(label)
  if (!affirmative) return false
  const questionScope = foldedUserInputAnswer(question.question)
  const selectionScope = foldedUserInputAnswer([
    selected.label,
    selected.description ?? '',
    answer.text ?? '',
  ].join(' '))
  const selectedScope = `${questionScope} ${selectionScope}`.trim()
  const globalNoEffect = /\b(?:ne|n) (?:fais|faites|faire) (?:absolument )?rien\b|\b(?:ne|n) rien faire\b|\baucune action\b|\bdo (?:absolutely )?nothing\b|\b(?:do not|don t) do anything\b/u.test(selectedScope)
  const contradictsAffirmedCategory = STRUCTURED_ANSWER_ACTION_FAMILIES.some(action => {
    const actionAffirmed = structuredAnswerMentionsAction(questionScope, action)
        && !structuredAnswerNegatesAction(questionScope, action)
      || structuredAnswerMentionsAction(selectionScope, action)
        && !structuredAnswerNegatesAction(selectionScope, action)
    return actionAffirmed && structuredAnswerNegatesAction(selectedScope, action)
  })
  return !/^(?:non|no|stop|annule|cancel|local only|uniquement local)(?:\b|$)/u.test(selectedScope)
    && !globalNoEffect
    && !contradictsAffirmedCategory
    && !/\b(?:lecture seule|read only)\b/u.test(selectedScope)
    && !/\b(?:only prepare|prepare only|preparer uniquement|uniquement preparer|seulement preparer|preparer seulement)\b/u.test(selectedScope)
}

/**
 * Turn one host-validated answer into policy input without trusting the hidden
 * provider envelope. The displayed question is included only when the user
 * selected one unambiguously affirmative option; a local-only/negative answer
 * therefore constrains older authority instead of inheriting the question's
 * model-authored mutation verbs.
 */
export function authenticatedUserInputAnswerAuthoritySegments(
  request: UserInputRequest,
): string[] {
  if (request.status !== 'answered' || !request.answers?.length) return []
  const segments: string[] = []
  for (const answer of request.answers) {
    const question = request.questions.find(candidate => candidate.id === answer.questionId)
    if (!question) continue
    const selected = answer.optionIds.map(optionId => (
      question.options?.find(option => option.id === optionId)
    ))
    if (selected.some(option => !option)) continue
    const selectedText = selected.flatMap(option => option ? [
      option.label,
      ...(option.description ? [option.description] : []),
    ] : [])
    if (answer.text?.trim()) selectedText.push(answer.text.trim())
    if (selectedText.length === 0) continue
    if (answerAffirmativelyConfirmsDisplayedScope(question, answer)) {
      const scope = question.question.trim()
      let scopeEnd = scope.length
      while (scopeEnd > 0 && (scope[scopeEnd - 1] === '?' || scope[scopeEnd - 1] === '？')) scopeEnd--
      const displayedScope = scope.slice(0, scopeEnd).trimEnd()
      segments.push([
        AUTHENTICATED_USER_AUTHORIZATION_MARKER,
        `Authenticated question id: ${question.id}`,
        `The user affirmatively selected: ${selectedText.join(' ')}`,
        `Displayed scope affirmed by that selection: ${displayedScope}.`,
      ].join('\n'))
    } else {
      segments.push([
        AUTHENTICATED_USER_ANSWER_MARKER,
        `Authenticated question id: ${question.id}`,
        `Displayed scope not affirmed: ${question.question.trim()}`,
        `The user selected only: ${selectedText.join(' ')}`,
      ].join('\n'))
    }
  }
  return segments
}

/**
 * Consume the one-shot marker that distinguishes an intentional source
 * activation restart from a broken provider stream.
 */
export function consumeSourceActivationRestart(
  host: SourceActivationRestartHost,
  generation: number,
): boolean {
  if (host.sourceActivationRestartGeneration !== generation) return false
  delete host.sourceActivationRestartGeneration;
  return true
}
