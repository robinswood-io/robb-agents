import { isLiteralQuestionAnswerScript, normalizedQuestionAnswerRequest, parseBoundedQuestionAnswerEnvelope } from './closure-intent.ts';
import { classifyObjectiveRequest, isObjectiveMutationRequested } from './execution-authority.ts';
import { OBSERVATION_REQUEST_PATTERN } from './intent-vocabulary.ts';

/**
 * A narrowly scoped question/answer exchange is a chat deliverable, even when
 * its introduction calls it a check or its two conversational steps use "then".
 * Consume the entire instruction: an additional inspection/action clause must
 * retain normal evidence requirements. This never reclassifies an existing goal.
 */
export function isExplicitQuestionAnswerOnlyRequest(text: string): boolean {
  if (text.length > 1_200 || classifyObjectiveRequest(text).highRisk) return false;
  const normalized = normalizedQuestionAnswerRequest(text);
  if (isLiteralQuestionAnswerScript(normalized)) return true;
  const envelope = parseBoundedQuestionAnswerEnvelope(normalized);
  if (!envelope) return false;
  const { reply, work } = envelope;
  if (!reply || !/\b(?:reponse|choix|choisi\w*|preference|answer|response|choice|chosen|selected)\b/.test(reply)
    || /\b(?:et|and|puis|then|ensuite|apres|after|avant|before)\b/.test(reply)) return false;
  // Fail closed on positive target work, even inside a syntactically valid
  // question/reply clause or beside a contradictory "no external action" line.
  return !isObjectiveMutationRequested(work) && !OBSERVATION_REQUEST_PATTERN.test(work)
    && !/\b(?:lis|lire|lisez|read|ouvr\w*|open|valid\w*|cherche\w*|recherch\w*|search|browse|execut\w*|run|lanc\w*|analys\w*|analyz\w*|fetch|download|telecharg\w*|calcul\w*|compute|evalu\w*|connect\w*|authentic\w*|send|envo\w*|inform\w*|notify|transmet\w*|transfer\w*|deplo\w*|start|restart|demarr\w*|redemarr\w*|automat\w*|schedul\w*|planifi\w*|enregistr\w*|save|sauvegard\w*|update|submit|archive\w*|cancel|commit|merge|move|rename|renomm\w*|restore|restaur\w*|upload|sync\w*|push|pull|appel\w*|call)\b/.test(work)
    && !/(?:https?:\/\/|\bmcp__|\b(?:mets?|mettez|mise)\s+a\s+jour\b|\b(?:serveur|server|endpoint|api|database|repo|repository|fichier|file|artifact|artefact)\b)/.test(work);
}
