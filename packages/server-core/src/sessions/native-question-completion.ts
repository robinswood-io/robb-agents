import {
  LEGACY_USER_INPUT_ANSWER_MESSAGE_PREFIX,
  USER_INPUT_ANSWER_MESSAGE_PREFIX,
} from '@craft-agent/core';
import type { Message, ObjectiveOutcomeDeclaration } from '@craft-agent/core/types';
import type { ActiveSessionObjective } from '@craft-agent/shared/sessions';

type Question = { id: string; question: string; options?: Array<{ id: string; label: string }>; multiSelect: boolean };
const ANSWER_PREFIXES = [
  USER_INPUT_ANSWER_MESSAGE_PREFIX,
  LEGACY_USER_INPUT_ANSWER_MESSAGE_PREFIX,
] as const;

function questions(value: unknown): Question[] | undefined {
  if (!Array.isArray(value) || value.length !== 3) return;
  const result: Question[] = [];
  for (const item of value) {
    if (!item || typeof item.id !== 'string' || !item.id || typeof item.question !== 'string' || !item.question
      || (item.multiSelect !== undefined && typeof item.multiSelect !== 'boolean')) return;
    if (item.options !== undefined && (!Array.isArray(item.options) || item.options.length < 2 || item.options.length > 20
      || item.options.some((option: any) => !option || typeof option.id !== 'string' || !option.id || typeof option.label !== 'string' || !option.label)
      || new Set(item.options.map((option: any) => option.id)).size !== item.options.length)) return;
    result.push({ id: item.id, question: item.question,
      ...(item.options ? { options: item.options.map((option: any) => ({ id: option.id, label: option.label })) } : {}),
      multiSelect: item.multiSelect === true });
  }
  if (new Set(result.map(question => question.id)).size !== 3 || !result[0]!.options || result[0]!.multiSelect
    || !result[1]!.options || !result[1]!.multiSelect || result[2]!.options || result[2]!.multiSelect) return;
  return result;
}

/** Consume the complete, explicitly bounded native-card recipe, including its
 * literal JSON questions. This is not a keyword exemption for ordinary work. */
function recipe(text: string): Question[] | undefined {
  if (text.length > 16_000) return;
  const boundary = text.indexOf('\n{');
  if (boundary < 0) return;
  const clauses = text.slice(0, boundary).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().trim().split(/\.\s*/).filter(Boolean);
  const allowed = [
    /^(?:recette|test|controle) de la carte de questions, limitee? a cette conversation$/,
    /^aucune action externe, aucun fichier, aucune source, aucun navigateur, aucun sous-agent$/,
    /^utilise uniquement request_user_input, une seule fois, avec exactement (?:les trois|3) questions json ci-dessous \(identifiants et libelles inchanges\)$/,
    /^la premiere est un choix unique, la deuxieme un choix multiple, la troisieme du texte libre$/,
    /^attends les reponses utilisateur : aucune hypothese, aucune reponse finale avant leur reception$/,
    /^apres leur reception, reponds uniquement avec un bref bilan qui reprend les libelles reellement selectionnes et la note libre exacte$/,
    /^ne repose pas les questions$/,
    /^cette recette ne necessite aucun autre outil$/,
  ];
  if (clauses.length !== allowed.length || !allowed.every((pattern, index) => pattern.test(clauses[index]!))) return;
  try {
    const data = JSON.parse(text.slice(boundary));
    if (!data || Object.keys(data).length !== 1 || !Object.hasOwn(data, 'questions')) return;
    return questions(data.questions);
  } catch { return; }
}

/** A native answer receipt can check only its own question-only deliverable.
 * No flags, criteria, budgets, stored messages or execution authority change. */
export function nativeQuestionCompletionRefs(objective: ActiveSessionObjective, messages: readonly Message[]): Set<string> {
  const empty = new Set<string>();
  if (objective.lastUserMessageId !== objective.userMessageId || objective.amendments?.length || objective.acceptanceNeedsReview || objective.requiresExecutionEvidence
    || objective.requiresObservationEvidence || objective.requiresAcceptanceCriteria || objective.acceptanceCriteria?.length
    || objective.evidenceRequirement || objective.procedure || objective.delegatedRole
    || objective.completionCriteria.some(id => !['requested-outcome-delivered', 'relevant-checks-passed', 'no-safe-work-remaining'].includes(id))) return empty;
  const start = messages.findIndex(message => message.id === objective.userMessageId && message.role === 'user'
    && !message.hidden && !message.internalOrigin && !message.agentDelivery && !message.isQueued && !message.isPending);
  if (start < 0 || messages.filter(message => message.id === objective.userMessageId).length !== 1) return empty;
  const original = messages[start]!;
  if (original.content !== objective.originalText) return empty;
  const expected = recipe(original.content);
  if (!expected) return empty;
  const scoped = messages.slice(start + 1);
  if (new Set(messages.map(message => message.id)).size !== messages.length) return empty;
  if (scoped.some(message => message.role === 'user' && !message.hidden)) return empty;
  const tools = scoped.filter(message => message.role === 'tool');
  if (tools.length !== 1) return empty;
  const tool = tools[0]!;
  if (!/^(?:mcp__session__|session__)?request_user_input$/.test(tool.toolName ?? '')
    || tool.toolExecuted !== true || tool.isError || tool.toolStatus !== 'completed' || !tool.toolUseId
    || messages.filter(message => message.toolUseId === tool.toolUseId).length !== 1
    || JSON.stringify(questions(tool.toolInput?.questions)) !== JSON.stringify(expected)) return empty;
  let request: any;
  try { request = JSON.parse(tool.toolResult ?? ''); } catch { return empty; }
  if (!request || request.status !== 'pending' || typeof request.requestId !== 'string' || !request.requestId) return empty;
  const answers = scoped.filter(message => message.role === 'user' && message.hidden
    && message.internalOrigin?.kind === 'user-input'
    && ANSWER_PREFIXES.some(prefix => message.content.startsWith(prefix)));
  if (answers.length !== 1) return empty;
  const answer = answers[0]!;
  if (answer.isQueued || answer.isPending || answer.agentDelivery) return empty;
  if (answer.timestamp < tool.timestamp || scoped.indexOf(answer) <= scoped.indexOf(tool)) return empty;
  const answerPrefix = ANSWER_PREFIXES.find(prefix => answer.content.startsWith(prefix));
  if (!answerPrefix) return empty;
  let payload: any;
  try { payload = JSON.parse(answer.content.slice(answerPrefix.length)); } catch { return empty; }
  if (!payload || payload.requestId !== request.requestId || JSON.stringify(questions(payload.questions)) !== JSON.stringify(expected)
    || !Array.isArray(payload.answers) || payload.answers.length !== 3
    || new Set(payload.answers.map((item: any) => item?.questionId)).size !== 3) return empty;
  const values: string[] = [];
  for (const question of expected) {
    const response = payload.answers.find((item: any) => item?.questionId === question.id);
    if (!response || !Array.isArray(response.optionIds)) return empty;
    if (question.options) {
      if (response.text || response.optionIds.length < 1 || (!question.multiSelect && response.optionIds.length !== 1)
        || new Set(response.optionIds).size !== response.optionIds.length) return empty;
      const selected = response.optionIds.map((id: unknown) => question.options!.find(option => option.id === id)?.label);
      if (selected.some((label: unknown) => typeof label !== 'string')) return empty;
      values.push(selected.join(', '));
    } else {
      if (response.optionIds.length || typeof response.text !== 'string' || !response.text || response.text.length > 4_000 || /[\r\n]/.test(response.text)) return empty;
      values.push(response.text);
    }
  }
  const final = scoped.findLast(message => message.role === 'assistant');
  if (!final || final.isIntermediate || final.isStreaming || final.isPending || final.isQueued
    || final.timestamp < answer.timestamp || scoped.indexOf(final) <= scoped.indexOf(answer)) return empty;
  const lines = final.content.trim().split(/\r?\n/).filter(line => line.trim());
  if (lines.length !== 3 || !lines.every((line, index) => {
    const match = /^\s*(?:\*\*)?[^:\r\n]{1,100}:\s*(?:\*\*)?\s?(.*?)\s*$/.exec(line);
    return match?.[1] === values[index];
  })) return empty;
  return new Set([tool.id, tool.toolUseId, answer.id, request.requestId]);
}

export interface HostNativeQuestionOutcome extends ObjectiveOutcomeDeclaration {
  hostProvenance: {
    schemaVersion: 1;
    kind: 'native-question-completion';
    objectiveId: string;
    finalMessageId: string;
    nativeEvidence: string[];
    reportedOutcome: ObjectiveOutcomeDeclaration;
  };
}

/** Correct only a false policy report that says the already fulfilled native
 * recipe lacks a check. The complete transcript proof, not that report, is the
 * authority. The caller must still validate this receipt through every gate. */
export function deriveNativeQuestionOutcome(
  declaration: ObjectiveOutcomeDeclaration,
  objective: ActiveSessionObjective,
  messages: Message[],
): HostNativeQuestionOutcome | undefined {
  const expected = ['requested-outcome-delivered', 'relevant-checks-passed', 'no-safe-work-remaining'];
  if (declaration.state !== 'blocked_policy' || declaration.blocker?.kind !== 'policy'
    || declaration.remainingWork.length || declaration.criteria.length !== expected.length
    || objective.completionCriteria.length !== expected.length
    || expected.some(id => !objective.completionCriteria.includes(id as never))
    || declaration.blocker.evidence.length !== 1 || declaration.blocker.evidence[0] !== objective.userMessageId) return;
  for (const id of expected) {
    const matching = declaration.criteria.filter(item => item.id === id);
    if (matching.length !== 1) return;
    const item = matching[0]!;
    if (item.satisfied !== (id !== 'relevant-checks-passed') || item.evidence.length !== 1
      || item.evidence[0] !== (id === 'relevant-checks-passed' ? objective.userMessageId : 'assistant-final')) return;
  }
  const nativeEvidence = [...nativeQuestionCompletionRefs(objective, messages)];
  if (nativeEvidence.length !== 4) return;
  const final = messages.findLast(message => message.role === 'assistant')!;
  return {
    state: 'complete_verified', blocker: null, remainingWork: [],
    criteria: expected.map(id => ({ id, satisfied: true,
      evidence: id === 'relevant-checks-passed' ? [...nativeEvidence] : ['assistant-final', final.id] })),
    hostProvenance: { schemaVersion: 1, kind: 'native-question-completion',
      objectiveId: objective.objectiveId ?? objective.userMessageId, finalMessageId: final.id,
      nativeEvidence, reportedOutcome: structuredClone(declaration) },
  };
}
