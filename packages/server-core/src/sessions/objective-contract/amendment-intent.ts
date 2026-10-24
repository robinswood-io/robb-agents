import { isContextDependentDirectTurn } from "@craft-agent/shared/config";
import { isExplicitReadOnlyReview } from './closure-intent.ts';
import { classifyObjectiveRequest, isObjectiveMutationRequested } from './execution-authority.ts';
import { AMENDMENT_OBSERVATION_REQUEST, OBSERVATION_REQUEST_PATTERN } from './intent-vocabulary.ts';
import { isExplicitQuestionAnswerOnlyRequest } from './question-answer-authority.ts';
import { foldForIntent } from './types.ts';

export function isChatResponseOnlyEdit(text: string): boolean {
  const normalized = foldForIntent(text).replace(/\s*[.!?]+$/, '');
  if (/^(?:(?:please|merci de|tu peux|vous pouvez)\s+)?(?:correct|fix|modify|edit|corrige|modifie|edite|redige|ecris)\s+(?:(?:only|just|uniquement|seulement|simplement)\s+)?(?:(?:(?:the|le|la)\s+)?(?:wording|style|spelling|orthographe|formulation|fautes?\s+(?:de|dorthographe))\s+(?:of|de)\s+)?(?:(?:the|your|my|our|ton|ta|votre|ma|notre|la)\s+)?(?:answer|response|reponse)(?:\s+(?:here|in (?:this|the) chat|ici|dans (?:ce|le) chat))?$/.test(normalized)) return true;

  // An inline rewrite is a response deliverable, not an external artifact
  // mutation. Keep the exception closed to a literal colon-delimited payload:
  // files, documents, URLs, paths and appended operational instructions retain
  // normal mutation authority and verification requirements.
  const accentFolded = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[’']/g, "'");
  const inline = /^\s*(?:(?:please|merci de)\s+)?(?:ameliore(?:z)?|improve)\s+(?:(?:le|ce|the|this)\s+)?(?:texte|text)\s*:\s*(\S[\s\S]*?)\s*$/iu.exec(accentFolded);
  if (!inline) return false;
  const payload = inline[1]!.trim();
  if (/^(?:(?:dans|sur|de|du|in|on|of)\s+)?(?:(?:le|la|un|une|the|a)\s+)?(?:fichier|file|document|doc|site|page|url|chemin|path|source|repo|repository|externe|external)\b/iu.test(payload)) return false;
  if (/(?:https?:\/\/|file:\/\/|www\.)/iu.test(payload)
    || /(?:^|[\s("'`])(?:~\/|\.{1,2}\/|\/(?!\/)|[a-z]:[\\/])/iu.test(payload)
    || /\b[\w-]+\.(?:txt|md|docx?|rtf|html?|json|ya?ml|tsx?|jsx?|py|css)\b/iu.test(payload)) return false;
  return !classifyObjectiveRequest(payload).mutationRequested
    && !OBSERVATION_REQUEST_PATTERN.test(payload);
}

/** A presentation preference changes the reply, not the target being verified. */
export function isResponsePresentationOnlyAmendment(text: string): boolean {
  if (classifyObjectiveRequest(text).mutationRequested || OBSERVATION_REQUEST_PATTERN.test(text)) return false;
  const normalized = foldForIntent(text);
  // Consume the whole instruction. A former permissive `.*presentation.*`
  // shape let “Réponds brièvement et renvoie le mail” retain the terminal
  // lock despite containing a new action.
  const responseWithPresentation = /^(?:(?:please|merci de|tu peux|vous pouvez)\s+)?(?:reponds?|repondez|answer|respond|reply)\s+(?:(?:plus|more)\s+)?(?:bref|brievement|concis|court|simple|clairement|detaille|francais|anglais|english|french|markdown|json|en\s+(?:liste|puces?|tableau)|in\s+(?:a\s+)?(?:list|bullets?|table)|en\s+(?:une\s+)?phrase|in\s+(?:one\s+)?sentence)(?:\s+(?:dans|pour|in|for)\s+(?:(?:le|la|the|your|ton|ta|votre)\s+)?(?:message\s+final|final\s+(?:answer|response|message)|reponse))?$/.test(normalized);
  const targetedPresentation = /^(?:(?:please|merci de)\s+)?(?:keep|make|rends?|rendez|garde|gardez)\s+(?:(?:the|your|ton|ta|votre|le|la)\s+)?(?:final\s+)?(?:answer|response|message|reponse|message final)\s+(?:more\s+|plus\s+)?(?:brief|short|simple|clear|concise|direct|bref|court|simple|clair|concis|direct)$/.test(normalized);
  const standaloneTone = /^(?:(?:please|merci de)\s+)?(?:utilise|utilisez|adopte|adoptez|garde|gardez|use|adopt|keep)\s+(?:(?:un|une|a)\s+)?(?:ton|tone|style)\s+(?:plus\s+|more\s+)?(?:bref|court|simple|clair|concis|direct|brief|short|simple|clear|concise|direct)$/.test(normalized);
  const continuationLanguage = /^(?:continue|continuer|poursuis|poursuivez|respond|reply|answer)\s+(?:uniquement\s+|only\s+)?(?:en|in)\s+(?:francais|anglais|english|french)$/.test(normalized);
  return responseWithPresentation || targetedPresentation || standaloneTone
    || continuationLanguage || isChatResponseOnlyEdit(text);
}

/** Cost routing accepts a broad continuation prefix; contract amendments must
 * consume the whole request before treating it as a content-free resume. */
export function isBareObjectiveContinuation(text: string): boolean {
  if (!isContextDependentDirectTurn(text)) return false;
  const folded = foldForIntent(text).replace(/-/g, ' ').replace(/\s+/g, ' ');
  return /^(?:(?:ok|oui|yes|daccord)\s+)?(?:(?:go|vas y|allez y|continue|poursui(?:s|t|vre)|reprend(?:s|re)?|avance)(?:\s+(?:le travail|la suite|le reste|la mission|cet objectif|ce chantier))?|(?:fais|faites) le)(?:\s+(?:stp|svp|sil te plait|sil vous plait))?$/.test(folded);
}

export function amendmentEvidenceRequests(text: string, delegatedRole?: 'worker' | 'reviewer') {
  const normalized = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const readOnly = delegatedRole === 'reviewer' || isExplicitReadOnlyReview(text);
  const questionOnly = isExplicitQuestionAnswerOnlyRequest(text);
  // French restrictive "ne ... que" and a named exception are affirmative
  // work with a narrower target. A conditional "sauf si" remains excluded.
  const affirmative = normalized
    .replace(/\bne\s+(modifie|corrige|cree|verifie|inspecte)\s+que\b/gi, '$1')
    .replace(/\bne\s+(cree|modifie|corrige)\s+(?:aucun(?:e)?\s+(?:fichier|document|rapport)|rien)\s+sauf\s+(?=(?:le|la|les|un|une|des)\s)/gi, '$1 ');
  const execution = isObjectiveMutationRequested(affirmative) && !isChatResponseOnlyEdit(affirmative);
  return {
    execution: !readOnly && !questionOnly && execution,
    observation: !questionOnly && (readOnly || AMENDMENT_OBSERVATION_REQUEST.test(affirmative)),
  };
}

export function independentInstructionClauses(text: string): string[] {
  return text.split(/[.!?;\n]+/u).map(clause => clause.trim()).filter(Boolean);
}

export function withoutClauseConnector(text: string): string {
  return text.replace(/^\s*(?:finalement|mais|puis|ensuite|et|but|finally|then|and)\s+/iu, '').trim();
}
