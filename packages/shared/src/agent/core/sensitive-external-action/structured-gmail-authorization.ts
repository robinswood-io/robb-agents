import { GMAIL_SEND_TOOL } from './connector-classification.ts';
import { hasGlobalExternalActionRevocation } from './request-authorization.ts';
import type { StructuredGmailSendAuthorizationDecision, StructuredGmailSendAuthorizationDiagnostic } from './structured-gmail-send.ts';
import { canonicalGmailSendInputMismatchCategories, isTargetFreeGenericContinuation, parseStructuredGmailSendResumeSegment } from './structured-gmail-send.ts';
import { normalizeForMatch } from './target-syntax.ts';

/** Bind a mutating Gmail call to the newest applicable authenticated restart
 * segment. A later revocation, retarget, or send-specific amendment owns the
 * boundary and cannot fall through to an older structured authorization. */
export function structuredGmailSendAuthorizationDiagnostic(
  toolName: string,
  input: Record<string, unknown>,
  objectiveSegments: readonly string[],
): StructuredGmailSendAuthorizationDiagnostic {
  if (toolName !== GMAIL_SEND_TOOL) {
    return { decision: 'not-applicable', mismatchCategories: [] };
  }
  const hasStructuredMarker = objectiveSegments.some(segment => (
    /\[robb-resume(?::|\])/iu.test(segment)
  ));
  if (!hasStructuredMarker) {
    return { decision: 'not-applicable', mismatchCategories: [] };
  }
  for (let index = objectiveSegments.length - 1; index >= 0; index -= 1) {
    const segment = objectiveSegments[index] ?? '';
    const normalized = normalizeForMatch(segment);
    if (!normalized) continue;
    if (/\[robb-resume(?::|\])/iu.test(segment)) {
      const payload = parseStructuredGmailSendResumeSegment(segment);
      if (!payload) {
        return {
          decision: 'invalid',
          mismatchCategories: ['authenticated-contract-unavailable'],
        };
      }
      const mismatchCategories = canonicalGmailSendInputMismatchCategories(input, payload);
      return {
        decision: mismatchCategories.length === 0 ? 'authorized' : 'invalid',
        mismatchCategories,
      };
    }
    if (hasGlobalExternalActionRevocation(segment)) {
      return { decision: 'invalid', mismatchCategories: ['authorization-boundary'] };
    }
    if (isTargetFreeGenericContinuation(normalized)) continue;
    // A structured restart is a closed exact-effect capability. Any newer
    // substantive authenticated segment owns the boundary, including terse
    // changes to the body/subject/attachment or an indirect stop instruction.
    // Only a target-free generic continuation may preserve the older payload.
    return { decision: 'invalid', mismatchCategories: ['authorization-boundary'] };
  }
  return {
    decision: 'invalid',
    mismatchCategories: ['authenticated-contract-unavailable'],
  };
}

export function structuredGmailSendAuthorizationDecision(
  toolName: string,
  input: Record<string, unknown>,
  objectiveSegments: readonly string[],
): StructuredGmailSendAuthorizationDecision {
  return structuredGmailSendAuthorizationDiagnostic(
    toolName,
    input,
    objectiveSegments,
  ).decision;
}

export function isStructuredGmailSendAuthorizedByObjective(
  toolName: string,
  input: Record<string, unknown>,
  objectiveSegments: readonly string[],
): boolean {
  return structuredGmailSendAuthorizationDecision(
    toolName,
    input,
    objectiveSegments,
  ) === 'authorized';
}
