import { createHash } from "node:crypto";
import { join } from "node:path";
import { nodeTitle, writeNodeOutput, readNodeOutput, runDir } from "@craft-agent/shared/tasks";
import { HOST_PARENT_REVIEW_INSTRUCTION, prependHostDelegatedReviewerScope } from "../../../sessions/delegated-review-outcome.ts";
import { MAX_REVIEW_NODE_OUTPUT_CHARS, MAX_REVIEW_EVIDENCE_CHARS, MAX_REVIEW_RUBRIC_CHARS, MAX_REVIEW_RESULT_CHARS, MAX_REVIEW_REASON_CHARS, MAX_HOST_REVIEW_CRITERIA, REVIEWER_NODE_ID, REVIEW_EVIDENCE_CRITERION_ID, REVIEW_OUTCOME_CRITERION_ID, truncateForReview, reviewTextExceedsLimit, repairOutputFingerprint } from "../review.ts";
import type { ReviewerContract } from "../review.ts";
import type { ActiveRun } from '../active-run.ts';

export function createReviewerContract(transportOwner: ActiveRun, reviewerSessionId: string): ReviewerContract {
    let remainingEvidenceChars = MAX_REVIEW_EVIDENCE_CHARS;
    const evidenceNodes: Array<{
        id: string;
        title: string;
        output: string;
    }> = [];
    for (const node of transportOwner["spec"].nodes) {
        const raw = transportOwner["outputs"][node.id]?.text ?? '(no output)';
        const excerpt = truncateForReview(raw, Math.max(0, Math.min(MAX_REVIEW_NODE_OUTPUT_CHARS, remainingEvidenceChars)));
        remainingEvidenceChars = Math.max(0, remainingEvidenceChars - Array.from(excerpt).length);
        evidenceNodes.push({
            id: node.id,
            title: nodeTitle(node),
            output: excerpt || '…[evidence omitted: review input limit reached]',
        });
    }
    const rubric = truncateForReview(transportOwner["spec"].acceptance_criteria ?? transportOwner["spec"].goal, MAX_REVIEW_RUBRIC_CHARS);
    const evidenceFingerprint = repairOutputFingerprint(transportOwner["spec"].nodes.map((node) => node.id).sort(), transportOwner["outputs"]);
    const evidenceText = JSON.stringify({
        schemaVersion: 1,
        taskId: transportOwner["spec"].id,
        taskRunId: transportOwner["runId"],
        reviewerSessionId,
        title: transportOwner["spec"].title,
        acceptanceContract: rubric,
        reviewedOutputFingerprint: evidenceFingerprint,
        nodes: evidenceNodes,
    }, null, 2);
    const nodeByCriterion = new Map<string, string>();
    // host-review-v2 permits at most 32 receipt criteria. Reserve one for the
    // whole outcome and one for the durable evidence read; excess nodes safely
    // degrade to whole-run repair rather than weakening the host protocol.
    const mappedNodes = transportOwner["spec"].nodes.slice(0, MAX_HOST_REVIEW_CRITERIA - 2);
    const nodeCriteria = mappedNodes.map((node, index) => {
        const criterionId = `node-${index + 1}`;
        nodeByCriterion.set(criterionId, node.id);
        return criterionId;
    });
    const criteria = [
        REVIEW_OUTCOME_CRITERION_ID,
        ...nodeCriteria,
        REVIEW_EVIDENCE_CRITERION_ID,
    ];
    const objectiveId = `task:${transportOwner["spec"].id}:${transportOwner["runId"]}`;
    const targetPath = join(runDir(transportOwner["deps"].workspaceRoot, transportOwner["slug"], transportOwner["runId"]), 'nodes', `${REVIEWER_NODE_ID}.json`);
    const acceptanceSha256 = createHash('sha256').update(JSON.stringify({
        objectiveId,
        criteria,
        evidenceFingerprint,
        rubric,
        targetPath,
    }), 'utf8').digest('hex');
    return {
        objectiveId,
        acceptanceSha256,
        criteria,
        nodeByCriterion,
        evidenceFingerprint,
        evidenceText,
        targetPath,
    };
}

export function buildReviewerPrompt(transportOwner: ActiveRun, contract: ReviewerContract): string {
    const receiptCriteria = contract.criteria.map((id) => ({ id, passed: true }));
    const nodeCriteria = [...contract.nodeByCriterion.entries()].map(([criterionId, nodeId]) => ({
        criterionId,
        nodeId,
    }));
    const brief = [
        `Independently review the completed task ${JSON.stringify(transportOwner["spec"].title)}.`,
        'This is the task terminal review. Do not spawn or request another reviewer.',
        '',
        `Read the exact durable evidence bundle at ${JSON.stringify(contract.targetPath)}.`,
        `Before inspecting it, register exactly one target-bound check named ${REVIEW_EVIDENCE_CRITERION_ID}: tool Read, input ${JSON.stringify({ file_path: contract.targetPath })}, check ${JSON.stringify({ path: '$.params.reviewedOutputFingerprint', equals: contract.evidenceFingerprint })}.`,
        `The receipt criterion mapping is ${JSON.stringify(nodeCriteria)}. Mark ${REVIEW_OUTCOME_CRITERION_ID} false when the whole result must be redone.`,
        `Known Task node ids: ${JSON.stringify(transportOwner["spec"].nodes.map((node) => node.id))}. Nodes beyond the bounded mapping require a whole-result FAIL.`,
        'Verify the observable outcome against the acceptance contract and evidence. Inspect only read-only workspace state when useful.',
        'Do not accept completion claims as proof. Missing checks, artifacts, receipts, or source-grounded facts require FAIL.',
        `Return the host-bound receipt with exactly these criterion ids: ${JSON.stringify(contract.criteria)}. A PASS example is ${JSON.stringify({
            objectiveId: contract.objectiveId,
            acceptanceSha256: contract.acceptanceSha256,
            verdict: 'PASS',
            criteria: receiptCriteria,
            findings: [],
        })}.`,
    ].join('\n');
    const contractEnvelope = {
        protocol: 'host-review-v2' as const,
        objectiveId: contract.objectiveId,
        acceptanceSha256: contract.acceptanceSha256,
        criteria: contract.criteria,
        targetChecks: [],
        singleTarget: { target: contract.targetPath },
        instruction: HOST_PARENT_REVIEW_INSTRUCTION,
    };
    return `${prependHostDelegatedReviewerScope(brief)}\n\n<host_parent_review_contract>${JSON.stringify(contractEnvelope).replace(/</g, '\\u003c')}</host_parent_review_contract>`;
}

export function persistReviewerOutput(transportOwner: ActiveRun, reviewerSessionId: string | undefined, reviewerState: 'pending' | 'invalid' | 'pass' | 'fail', response: string, parseFailure?: string, pendingEvidence?: string): void {
    if (reviewerSessionId)
        transportOwner["pendingReviewerSessionIds"].add(reviewerSessionId);
    const reviewerSessionIds = [...transportOwner["pendingReviewerSessionIds"]];
    const boundedResponse = truncateForReview(response, MAX_REVIEW_RESULT_CHARS);
    writeNodeOutput(transportOwner["deps"].workspaceRoot, transportOwner["slug"], transportOwner["runId"], '__verdict__', {
        text: reviewerState === 'pending' && pendingEvidence !== undefined
            ? pendingEvidence
            : boundedResponse,
        params: {
            schemaVersion: 1,
            reviewerState,
            ...(reviewerSessionId ? { reviewerSessionId } : {}),
            ...(reviewerSessionIds.length > 0 ? { reviewerSessionIds } : {}),
            ...(transportOwner["opts"].orchestratorSessionId
                ? { reviewerParentSessionId: transportOwner["opts"].orchestratorSessionId }
                : {}),
            reviewerAttempt: transportOwner["unparsedReAsks"] + 1,
            reviewedOutputFingerprint: repairOutputFingerprint(transportOwner["spec"].nodes.map((node) => node.id).sort(), transportOwner["outputs"]),
            responseHash: createHash('sha256').update(response, 'utf8').digest('hex'),
            responseTruncated: reviewTextExceedsLimit(response, MAX_REVIEW_RESULT_CHARS),
            ...(parseFailure
                ? { parseFailure: truncateForReview(parseFailure, MAX_REVIEW_REASON_CHARS) }
                : {}),
        },
    });
}

/** Update only the durable reviewer identity set without replacing a
     * response/evidence payload that may still be eligible for reconciliation. */
export function persistReviewerCandidateIds(transportOwner: ActiveRun): void {
    const existing = readNodeOutput(transportOwner["deps"].workspaceRoot, transportOwner["slug"], transportOwner["runId"], REVIEWER_NODE_ID);
    const reviewerSessionIds = [...transportOwner["pendingReviewerSessionIds"]];
    if (!existing) {
        if (reviewerSessionIds.length === 0)
            return;
        transportOwner["persistReviewerOutput"](reviewerSessionIds[0], 'invalid', '', 'reviewer retirement pending');
        return;
    }
    const { reviewerSessionId: _previousReviewerSessionId, reviewerSessionIds: _previousReviewerSessionIds, ...params } = existing.params ?? {};
    writeNodeOutput(transportOwner["deps"].workspaceRoot, transportOwner["slug"], transportOwner["runId"], REVIEWER_NODE_ID, {
        ...existing,
        params: {
            ...params,
            ...(reviewerSessionIds[0] ? { reviewerSessionId: reviewerSessionIds[0] } : {}),
            ...(reviewerSessionIds.length > 0 ? { reviewerSessionIds } : {}),
        },
    });
}
