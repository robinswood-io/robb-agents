import { posix } from "node:path";
import { BOUNDED_OSS_ATOMIC_WRITE_ROOT, BOUNDED_OSS_ATOMIC_WRITE_TOOL } from './connector-classification.ts';
import { externalActionAuthorityPolicySegments, hasDynamicOrGlobTargetSyntax } from './host-authorization.ts';
import { isSensitiveRemoteTransferSource } from './remote-scope-targets.ts';
import { hasGlobalExternalActionRevocation, isNonAuthorizingRequest, requestClauses, targetIsNamed, targetIsNegatedInClause } from './request-authorization.ts';
import { isClosedTargetFreeProgressFollowUp, isTargetFreeGenericContinuation } from './structured-gmail-send.ts';
import { normalizeForMatch } from './target-syntax.ts';
import type { SensitiveExternalAction } from './types.ts';

/** Classify only high-confidence external mutations; ordinary local/read actions return null. */
export const BOUNDED_REMOTE_HOST_PROMPT_TOOLS = new Set([
  'mcp__rbw-servers__ssh_execute',
  'mcp__rbw-servers__ssh_execute_sudo',
]);

export function literalCanonicalAbsolutePosixPath(value: unknown): string | undefined {
  if (typeof value !== 'string' || value !== value.trim()
    || value.length < 2 || value.length > 512
    || !posix.isAbsolute(value) || posix.normalize(value) !== value
    || value.includes('\\') || hasDynamicOrGlobTargetSyntax(value)) return undefined;
  const components = value.slice(1).split('/');
  if (components.some(component => component === '.' || component === '..'
    || !/^[A-Za-z0-9._@%+=:,() -]+$/u.test(component))) return undefined;
  return value;
}

function boundedOssAtomicWriteLiteralPath(value: unknown): string | undefined {
  const path = literalCanonicalAbsolutePosixPath(value);
  if (!path || !path.startsWith(`${BOUNDED_OSS_ATOMIC_WRITE_ROOT}/`)) return undefined;
  const relativePath = path.slice(BOUNDED_OSS_ATOMIC_WRITE_ROOT.length + 1);
  if (isSensitiveRemoteTransferSource({ localPath: `/${relativePath}` })) {
    return undefined;
  }
  return path;
}

export function boundedOssAtomicWritePath(
  input: Record<string, unknown>,
): string | undefined {
  const path = boundedOssAtomicWriteLiteralPath(input["path"]);
  if (!path || typeof input["content"] !== 'string'
    || input["content"].length === 0
    || input["content"].length > 1_000_000
    || input["content"].includes('\0')
    || Object.keys(input).some(key => ![
      'path', 'content', '_displayName', '_intent',
    ].includes(key))) return undefined;
  const validMetadata = ['_displayName', '_intent'].every(key => {
    const value = input[key];
    return value === undefined || typeof value === 'string'
      && value.length <= 1_000
      && !/[\0\r\n]/u.test(value);
  });
  return validMetadata ? path : undefined;
}

/** Open one OSS artifact only when the latest authenticated human boundary is
 * a signed resume contract that repeats both the exact connector and the same
 * literal canonical absolute path. The ordinary broad "write file" MCP
 * classifier deliberately cannot infer this capability. */
interface SignedOssAtomicWriteDecision {
  authorized: boolean;
  sessionId?: string;
}

export function signedOssAtomicWriteDecision(
  action: SensitiveExternalAction,
  objectiveSegments: readonly string[],
): SignedOssAtomicWriteDecision | undefined {
  if (action.boundedOssAtomicWrite !== true
    || action.commandPreview !== BOUNDED_OSS_ATOMIC_WRITE_TOOL
    || action.category !== 'external_mutation'
    || action.targetCandidates.length !== 1) return undefined;
  const targetPath = boundedOssAtomicWriteLiteralPath(action.targetCandidates[0]);
  if (!targetPath) return undefined;

  const signedResume = /^\[robb-resume:([a-z0-9]+(?:-[a-z0-9]+)*):[a-f0-9]{6,64}:v[1-9]\d*\][ \t]*$/gmu;
  const signedSource = /^Source OSS exacte autorisée\s*:\s*`([^`\r\n]+)`\.[ \t]*$/gmu;
  const signedSourceLine = /^Source OSS exacte autorisée\s*:/gmu;
  const signedPath = /^Fichier OSS exact autorisé en écriture atomique\s*:\s*`([^`\r\n]+)`\.[ \t]*$/gmu;
  const signedPathLine = /^Fichier OSS exact autorisé en écriture atomique\s*:/gmu;
  const localWriteRevocation = /\b(?:(?:ne|n)\s+(?:ecris|ecrivez|ecrire|modifie|modifiez|modifier|remplace|remplacez|remplacer)[^.!?;\n]{0,80}\b(?:pas|plus|jamais)\b|(?:do not|don t|never)\s+(?:write|modify|replace)\b|(?:ecriture|modification|remplacement|write|writing|modification|replacement)\b[^.!?;\n]{0,50}\b(?:interdit|interdite|forbidden|not allowed))\b/u;
  const sourceRetarget = /\b(?:(?:utilise|utilisez|use)\s+(?:(?:desormais|maintenant|finalement|now|instead)\s+)?(?:une\s+autre|another|other)\s+(?:source|connecteur|connector)|(?:source|connecteur|connector)\s+(?:devient|becomes)\b|(?:plutot|rather|instead)\b[^.!?;\n]{0,60}\b(?:source|connecteur|connector)\b)/u;
  for (let index = objectiveSegments.length - 1; index >= 0; index -= 1) {
    const rawRequest = objectiveSegments[index] ?? '';
    const normalizedRequest = normalizeForMatch(rawRequest);
    if (!normalizedRequest || isTargetFreeGenericContinuation(normalizedRequest)
      || isClosedTargetFreeProgressFollowUp(rawRequest, normalizedRequest)) continue;
    if (hasGlobalExternalActionRevocation(rawRequest)) return { authorized: false };
    const resumeMatches = [...rawRequest.matchAll(signedResume)];
    const sourceMatches = [...rawRequest.matchAll(signedSource)];
    const pathMatches = [...rawRequest.matchAll(signedPath)];
    const contractPath = boundedOssAtomicWriteLiteralPath(pathMatches[0]?.[1]);
    const firstNonWhitespace = rawRequest.search(/\S/u);
    const otherLiteralPaths = [...rawRequest.matchAll(/`([^`\r\n]+)`/gu)]
      .map(match => match[1] ?? '')
      .filter(value => value !== targetPath
        && (value.includes('/') || hasDynamicOrGlobTargetSyntax(value)));
    if (isNonAuthorizingRequest(rawRequest, normalizedRequest)
      || /```|~~~|^\s*>/mu.test(rawRequest)
      || resumeMatches.length !== 1
      || resumeMatches[0]?.index !== firstNonWhitespace
      || (rawRequest.match(/\[robb-resume:/gu)?.length ?? 0) !== 1
      || sourceMatches.length !== 1 || sourceMatches[0]?.[1] !== 'rbw-agents-oss'
      || [...rawRequest.matchAll(signedSourceLine)].length !== 1
      || pathMatches.length !== 1 || contractPath !== targetPath
      || [...rawRequest.matchAll(signedPathLine)].length !== 1
      || otherLiteralPaths.length > 0
      || localWriteRevocation.test(normalizedRequest)
      || sourceRetarget.test(normalizedRequest)) return { authorized: false };
    const clauses = requestClauses(rawRequest);
    const authorized = !clauses.some(clause => targetIsNamed(clause, targetPath)
      && targetIsNegatedInClause(clause, targetPath));
    return {
      authorized,
      ...(authorized ? { sessionId: resumeMatches[0]?.[1] } : {}),
    };
  }
  return { authorized: false };
}

/** Return the session bound by the same exact contract that authorizes this
 * OSS write. PreToolUse compares it with its host-owned active session ID. */
export function signedOssAtomicWriteAuthorizedSessionId(
  action: SensitiveExternalAction,
  objectiveSegments: readonly string[],
): string | undefined {
  const decision = signedOssAtomicWriteDecision(
    action,
    externalActionAuthorityPolicySegments(objectiveSegments),
  );
  return decision?.authorized ? decision.sessionId : undefined;
}

export const BOUNDED_REMOTE_EXACT_SCOPE_DECLARATION = /\b(?:cible exacte autorisee|exact target authorized|exact authorized target)\b|\b(?:cible exacte|exact target)\s*:/u;

export const AFFIRMATIVE_BOUNDED_REMOTE_EXACT_SCOPE_DECLARATION = /^(?:(?:cible exacte autorisee|exact target authorized|exact authorized target)\b|(?:cible exacte|exact target)\s*:)/u;

export const COLON_BOUNDED_REMOTE_EXACT_SCOPE_DECLARATION = /(?:^|[.!?;\n][ \t]*)(?:cible\s+exacte|exact\s+target)\s*:\s*([^.!?;\n]{1,1000})/giu;

export const NEGATIVE_EXACT_SCOPE_VALUE = /\b(?:aucun|aucune|none|nothing|no|not|never|pas|sans|without)\b/u;

export const READ_ONLY_EXACT_SCOPE_QUALIFIER = /\b(?:lecture seule|read only|observation only|sans (?:aucune )?(?:modification|ecriture|mutation)|without (?:any )?(?:change|write|mutation))\b/u;

export const EXPLICIT_BOUNDED_REMOTE_EXECUTION_AUTHORIZATION = /\b(?:deja\s+autorise(?:e|es|s)?|already\s+authorized)\b/u;

export const NEGATED_BOUNDED_REMOTE_EXECUTION_AUTHORIZATION = /\b(?:pas|non|jamais|not|never)\b[^.!?;\n]{0,40}\b(?:autorise(?:e|es|s)?|authorized)\b/u;
