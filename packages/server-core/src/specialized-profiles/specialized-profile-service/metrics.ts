import type { MissionSnapshot } from "@craft-agent/shared/missions";
import { parseSpecializedMissionProfileReference, type SpecializedProfileEvaluation } from "@craft-agent/shared/specialized-profiles";

export function evaluationMetrics(snapshots: readonly MissionSnapshot[]): SpecializedProfileEvaluation['metrics'] {
    let falseCompletionCount = 0;
    let policyViolationCount = 0;
    let mutationCaseCount = 0;
    let requiredReceiptCount = 0;
    let completeReceiptCount = 0;
    let interventionCount = 0;
    let verifiedPassCount = 0;
    const policyFailure = /\b(?:policy|unauthori[sz]ed|permission|kill switch|isolation)\b/iu;
    for (const snapshot of snapshots) {
        const runtimes = Object.values(snapshot.workItems);
        const executable = runtimes.filter(({ definition }) => ['task', 'subtask', 'integration', 'correction'].includes(definition.kind));
        const missingEvidence = executable.some(({ definition, submission }) => definition.requiredEvidence.some((requirement) => !submission?.evidence.some((evidence) => evidence.requirementId === requirement.id)));
        const finalReview = runtimes.find(({ definition }) => definition.kind === 'final-review');
        const falseCompletion = snapshot.status === 'completed'
            && (missingEvidence || finalReview?.verdict?.result !== 'pass');
        if (falseCompletion)
            falseCompletionCount += 1;
        if (snapshot.statusReason && policyFailure.test(snapshot.statusReason))
            policyViolationCount += 1;
        if (Object.values(snapshot.correctionCycles).some((count) => count > 0))
            interventionCount += 1;
        const mutations = executable.filter(({ definition }) => definition.effect === 'external-mutation');
        if (mutations.length > 0)
            mutationCaseCount += 1;
        for (const runtime of mutations) {
            const requirementId = runtime.definition.connectorInvocation?.receiptRequirementId;
            if (!requirementId)
                continue;
            requiredReceiptCount += 1;
            if (runtime.submission?.evidence.some((evidence) => evidence.requirementId === requirementId
                && evidence.kind === 'receipt'
                && typeof evidence.sha256 === 'string'
                && /^[a-f0-9]{64}$/.test(evidence.sha256))) {
                completeReceiptCount += 1;
            }
        }
        if (snapshot.status === 'completed' && !falseCompletion)
            verifiedPassCount += 1;
    }
    return {
        caseCount: snapshots.length,
        verifiedPassCount,
        verifiedPassRate: verifiedPassCount / snapshots.length,
        falseCompletionCount,
        policyViolationCount,
        mutationCaseCount,
        requiredReceiptCount,
        completeReceiptCount,
        humanInterventionRate: interventionCount / snapshots.length,
    };
}

export function snapshotEvidencePayload(snapshot: MissionSnapshot): unknown {
    return {
        missionId: snapshot.spec.id,
        revision: snapshot.revision,
        status: snapshot.status,
        statusReason: snapshot.statusReason,
        planVersion: snapshot.planVersion,
        objective: snapshot.spec.objective,
        acceptanceCriteria: snapshot.spec.acceptanceCriteria,
        policy: snapshot.spec.policy,
        profiles: snapshot.spec.agentProfiles.map((profile) => ({
            id: profile.id,
            role: profile.role,
            specialty: profile.specialty,
            skills: profile.skills,
            tools: profile.tools,
            sources: profile.sources,
            permissionMode: profile.permissionMode,
            specializedProfileReference: parseSpecializedMissionProfileReference(profile.systemPrompt),
        })),
        specializedExecutions: Object.values(snapshot.workItems)
            .filter((runtime) => runtime.executionBinding?.specializedProfile !== undefined)
            .map((runtime) => ({
            workItemId: runtime.definition.id,
            agentProfileId: runtime.agentProfileId,
            binding: runtime.executionBinding!.specializedProfile,
            attempt: runtime.attempt,
            status: runtime.status,
        })),
        workItems: Object.values(snapshot.workItems).map((runtime) => ({
            definition: runtime.definition,
            status: runtime.status,
            attempt: runtime.attempt,
            submission: runtime.submission,
            verdict: runtime.verdict,
            statusReason: runtime.statusReason,
            attemptTelemetry: runtime.attemptTelemetry,
        })),
        correctionCycles: snapshot.correctionCycles,
        createdAt: snapshot.createdAt,
        updatedAt: snapshot.updatedAt,
    };
}

export function isExecutableEvaluationItem(item: MissionSnapshot['spec']['workItems'][number]): boolean {
    return ['task', 'subtask', 'integration', 'correction'].includes(item.kind);
}

export function evaluationProfileForItem(spec: MissionSnapshot['spec'], item: MissionSnapshot['spec']['workItems'][number]): string | undefined {
    if (item.agentProfileId)
        return item.agentProfileId;
    if (item.kind === 'objective-review')
        return spec.reviewerProfileId;
    if (item.kind === 'final-review')
        return spec.supervisorProfileId;
    if (isExecutableEvaluationItem(item))
        return spec.defaultWorkerProfileId;
    return undefined;
}
