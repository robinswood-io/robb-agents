import { createHash } from "node:crypto";
import { type NodeOutput } from "@craft-agent/shared/tasks";

// A malformed reviewer result is re-asked this many times before we give up and fail the run.
// These re-asks are format-only — they do NOT consume the repair (max_iterations) budget.
export const MAX_UNPARSED_REASKS = 2;

export const MAX_REVIEW_NODE_OUTPUT_CHARS = 12000;

export const MAX_REVIEW_EVIDENCE_CHARS = 48000;

export const MAX_REVIEW_RUBRIC_CHARS = 12000;

// Match SessionManager's host-review-v2 receipt bounds exactly. A receipt the
// host accepts must not be rejected by TaskRunner and trigger an impossible
// second terminal turn on the same reviewer objective.
export const MAX_REVIEW_RESULT_CHARS = 32000;

export const MAX_REVIEW_REASON_CHARS = 4000;

export const MAX_REVIEW_NODES = 64;

export const MAX_HOST_REVIEW_CRITERIA = 32;

export const REVIEWER_RETIRE_TIMEOUT_MS = 7500;

export const REVIEWER_NODE_ID = '__verdict__';

export const REVIEW_EVIDENCE_CRITERION_ID = 'task-evidence';

export const REVIEW_OUTCOME_CRITERION_ID = 'task-outcome';

export const INPUTS_REF_RE = /\$\{\s*inputs\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\}/g;

export interface RepairReflection {
    iteration: number;
    reason: string;
    frontier: string[];
    outputFingerprint: string;
}

export interface ReviewerVerdict {
    result: 'pass' | 'fail' | 'unparsed';
    reason?: string;
    nodes?: string[];
}

export interface ReviewerContract {
    objectiveId: string;
    acceptanceSha256: string;
    criteria: string[];
    /** Receipt criterion id → Task node id. Missing entries are run-level criteria. */
    nodeByCriterion: ReadonlyMap<string, string>;
    evidenceFingerprint: string;
    evidenceText: string;
    targetPath: string;
}

export class ReviewerRetirementError extends AggregateError {
    constructor(readonly sessionIds: string[], errors: Error[]) {
        super(errors, 'One or more reviewer sessions could not be retired');
        this.name = 'ReviewerRetirementError';
    }
}

/** Keep reflective prompts bounded without cutting a UTF-16 surrogate pair in half. */
export function truncateForReflection(text: string, maxChars: number): string {
    const chars = Array.from(text.trim());
    if (chars.length <= maxChars)
        return chars.join('');
    return `${chars.slice(0, maxChars).join('')}\n…[truncated]`;
}

/** Bound untrusted reviewer inputs/results without splitting Unicode characters. */
export function truncateForReview(text: string, maxChars: number): string {
    if (maxChars <= 0)
        return '';
    const chars: string[] = [];
    let truncated = false;
    for (const char of text.trim()) {
        if (chars.length === maxChars) {
            truncated = true;
            break;
        }
        chars.push(char);
    }
    if (!truncated)
        return chars.join('');
    const marker = '\n…[truncated]';
    const markerChars = Array.from(marker);
    if (maxChars <= markerChars.length)
        return chars.slice(0, maxChars).join('');
    return `${chars.slice(0, maxChars - markerChars.length).join('')}${marker}`;
}

export function reviewTextExceedsLimit(text: string, maxChars: number): boolean {
    let count = 0;
    for (const _char of text) {
        count += 1;
        if (count > maxChars)
            return true;
    }
    return false;
}

/**
 * Canonical fingerprint of the observable outputs rejected by the verifier.
 * Whitespace-only presentation changes do not count as progress. The run log
 * persists only this hash, never an additional copy of potentially sensitive output.
 */
export function repairOutputFingerprint(frontier: string[], outputs: Record<string, NodeOutput>): string {
    const canonical = frontier.map((nodeId) => ({
        nodeId,
        output: (outputs[nodeId]?.text ?? '')
            .normalize('NFKC')
            .replace(/\s+/g, ' ')
            .trim(),
    }));
    return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}

/** Strict host-review-v2 receipt; TaskRunner and SessionManager consume the
 * same binding and shape rather than accepting two incompatible protocols. */
export function parseReviewerVerdict(text: string, contract: ReviewerContract): ReviewerVerdict {
    if (text.length === 0)
        return { result: 'unparsed', reason: 'reviewer returned an empty result' };
    if (reviewTextExceedsLimit(text, MAX_REVIEW_RESULT_CHARS)) {
        return { result: 'unparsed', reason: `reviewer result exceeds ${MAX_REVIEW_RESULT_CHARS} characters` };
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(text.trim());
    }
    catch {
        return { result: 'unparsed', reason: 'reviewer result is not a standalone JSON object' };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { result: 'unparsed', reason: 'reviewer result must be a JSON object' };
    }
    const record = parsed as Record<string, unknown>;
    if (record.objectiveId !== contract.objectiveId
        || record.acceptanceSha256 !== contract.acceptanceSha256) {
        return { result: 'unparsed', reason: 'reviewer result does not match the current host binding' };
    }
    if (record.verdict !== 'PASS' && record.verdict !== 'FAIL') {
        return { result: 'unparsed', reason: 'reviewer verdict must be PASS or FAIL' };
    }
    if (!Array.isArray(record.criteria) || record.criteria.length !== contract.criteria.length) {
        return { result: 'unparsed', reason: 'reviewer result must report every bound criterion exactly once' };
    }
    const criterionResults = new Map<string, boolean>();
    for (const item of record.criteria) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
            return { result: 'unparsed', reason: 'reviewer criteria have an invalid shape' };
        }
        const { id, passed } = item as {
            id?: unknown;
            passed?: unknown;
        };
        if (typeof id !== 'string' || typeof passed !== 'boolean'
            || !contract.criteria.includes(id) || criterionResults.has(id)) {
            return { result: 'unparsed', reason: 'reviewer criteria contain an unknown or duplicate id' };
        }
        criterionResults.set(id, passed);
    }
    if (contract.criteria.some((id) => !criterionResults.has(id))) {
        return { result: 'unparsed', reason: 'reviewer result omitted a bound criterion' };
    }
    if (!Array.isArray(record.findings) || record.findings.length > MAX_REVIEW_NODES
        || record.findings.some((finding) => typeof finding !== 'string'
            || finding.trim().length === 0
            || finding.length > MAX_REVIEW_REASON_CHARS
            || /^<.*>$/.test(finding.trim())
            || /replace this example|example[_ -]?only/i.test(finding))) {
        return { result: 'unparsed', reason: 'reviewer findings must be bounded concrete strings' };
    }
    const findings = (record.findings as string[]).map((finding) => finding.trim());
    const failedCriteria = [...criterionResults].filter(([, passed]) => !passed).map(([id]) => id);
    if (record.verdict === 'PASS') {
        if (findings.length > 0 || failedCriteria.length > 0) {
            return { result: 'unparsed', reason: 'PASS cannot contain findings or failed criteria' };
        }
        return { result: 'pass' };
    }
    if (findings.length === 0) {
        return { result: 'unparsed', reason: 'FAIL requires concrete findings' };
    }
    const nodes = failedCriteria.flatMap((criterionId) => {
        const nodeId = contract.nodeByCriterion.get(criterionId);
        return nodeId ? [nodeId] : [];
    });
    const wholeRunFailure = failedCriteria.some((criterionId) => (criterionId === REVIEW_OUTCOME_CRITERION_ID
        || criterionId === REVIEW_EVIDENCE_CRITERION_ID
        || !contract.nodeByCriterion.has(criterionId)));
    const reason = truncateForReview(findings.join('; '), MAX_REVIEW_REASON_CHARS);
    return {
        result: 'fail',
        reason,
        ...(!wholeRunFailure && nodes.length ? { nodes } : {}),
    };
}
