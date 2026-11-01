import { isJsonObject, parseJsonObject, isUnknownArray } from '../../../utils/json.ts';

export interface IndependentReviewReceipt {
  objectiveId?: string;
  acceptanceSha256?: string;
  /** Host-owned message id returned by wait_sessions for the exact completed
   * reviewer snapshot. It is never read from the reviewer's JSON prose. */
  reviewMessageId?: string;
  verdict: 'PASS' | 'FAIL';
  criteria: Array<{ id: string; passed: boolean }>;
  findings: unknown[];
}

/** Host context for a review returned by a delegated session, never inferred from its prose. */
export interface IndependentReviewContext {
  toolName: string;
  sessionIds?: readonly string[];
  objectiveId: string;
  acceptanceSha256: string;
}

export const WAIT_SESSIONS_TOOL_PATTERN = /^(?:mcp__session__|session__)?wait_sessions$/;

function jsonCandidates(result: string): string[] {
  const candidates = [result.trim()];
  const fences = result.split('```');
  for (let index = 1; index + 1 < fences.length; index += 2) {
    const fenced = fences[index]!.replace(/^json/i, '').trim();
    if (fenced) candidates.push(fenced);
  }
  const firstBrace = result.indexOf('{');
  const lastBrace = result.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(result.slice(firstBrace, lastBrace + 1));
  return [...new Set(candidates)].filter(candidate => candidate.length <= 32_000);
}

function parseDirectReviewReceipt(result: string): IndependentReviewReceipt | undefined {
  for (const candidate of jsonCandidates(result)) {
    try {
      const value = JSON.parse(candidate) as Partial<IndependentReviewReceipt>;
      if (value.verdict !== 'PASS' && value.verdict !== 'FAIL') continue;
      if (!isUnknownArray(value.criteria) || value.criteria.length === 0 || !isUnknownArray(value.findings)) continue;
      const criteria = value.criteria.filter(item => (
        !!item && typeof item.id === 'string' && typeof item.passed === 'boolean'
      ));
      if (criteria.length !== value.criteria.length) continue;
      return { verdict: value.verdict, criteria, findings: value.findings,
        ...(typeof value.objectiveId === 'string' ? { objectiveId: value.objectiveId } : {}),
        ...(typeof value.acceptanceSha256 === 'string' ? { acceptanceSha256: value.acceptanceSha256 } : {}),
      };
    } catch {
      // Try the next bounded candidate.
    }
  }
  return undefined;
}

export function parseIndependentReviewReceipt(
  result: string,
  context?: IndependentReviewContext,
): IndependentReviewReceipt | undefined {
  if (!context || !WAIT_SESSIONS_TOOL_PATTERN.test(context.toolName)) return parseDirectReviewReceipt(result);
  // wait_sessions returns a host envelope, not a bare reviewer response. Only
  // consider a completed, requested session and the exact current contract.
  // Never search arbitrary nested prose or accept an unrelated/historical PASS.
  if (!context.sessionIds?.length || context.sessionIds.length > 8
    || !context.objectiveId || !context.acceptanceSha256 || result.length > 256_000) return undefined;
  try {
    const envelope = parseJsonObject(result);
    if (!envelope || envelope["outcome"] !== 'completed' || !isUnknownArray(envelope["sessions"])
      || envelope["sessions"].length > 8) return undefined;
    const requested = new Set(context.sessionIds);
    const seen = new Set<string>();
    const matches: IndependentReviewReceipt[] = [];
    for (const snapshot of envelope["sessions"] as unknown[]) {
      if (!isJsonObject(snapshot) || typeof snapshot["sessionId"] !== 'string' || !requested.has(snapshot["sessionId"])) continue;
      if (seen.has(snapshot["sessionId"])) return undefined;
      seen.add(snapshot["sessionId"]);
      if (snapshot["state"] !== 'idle' || snapshot["reason"] !== 'complete'
        || snapshot["finalTextTruncated"] || snapshot["needsAttention"] || snapshot["changed"] === false
        || typeof snapshot["finalText"] !== 'string' || snapshot["finalText"].length > 32_000) continue;
      // A review example followed by a conflicting verdict is ambiguous even
      // within one session. Do not prefer the first parseable fenced receipt.
      // Only the delegated envelope uses this stricter unambiguous spelling;
      // legacy standalone review parsing remains backward compatible.
      const verdictCount = [...snapshot["finalText"].matchAll(/"verdict"\s*:/g)].length;
      if (verdictCount > 1) return undefined;
      if (verdictCount !== 1) continue;
      const receipt = parseDirectReviewReceipt(snapshot["finalText"]);
      if (receipt?.objectiveId === context.objectiveId && receipt.acceptanceSha256 === context.acceptanceSha256) {
        const reviewMessageId = typeof snapshot["finalMessageId"] === 'string'
          && /^msg-[1-9]\d{0,19}-[a-z0-9]{16,64}$/.test(snapshot["finalMessageId"])
          ? snapshot["finalMessageId"]
          : undefined;
        matches.push({ ...receipt, ...(reviewMessageId ? { reviewMessageId } : {}) });
      }
    }
    // More than one applicable verdict needs an explicit host selection; do
    // not silently prefer a PASS over another review's FAIL.
    return matches.length === 1 ? matches[0] : undefined;
  } catch {
    return undefined;
  }
}
