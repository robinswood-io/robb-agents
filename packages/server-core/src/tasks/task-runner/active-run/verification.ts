import { omitUndefined } from '@craft-agent/shared/utils/json';
import { inferTaskNodeProfile, resolveTaskModelSettings, type TaskNodeExecutionRoute } from "../../task-node-execution";
import { type TaskNode, authorizeWorkspacePath, validateExecutionIsolationPolicy, type ExecutionIsolationPolicy } from "@craft-agent/shared/tasks";
import { RUNNING_STATUS, FAILED_STATUS, resolveIsolationPolicy } from "../shared.ts";
import { REVIEWER_RETIRE_TIMEOUT_MS, REVIEWER_NODE_ID, parseReviewerVerdict } from "../review.ts";
import type { ActiveRun } from '../active-run.ts';

export async function sendVerification(transportOwner: ActiveRun, generation: number): Promise<void> {
    const orchestrator = transportOwner["opts"].orchestratorSessionId;
    if (!orchestrator) {
        if (transportOwner["isCurrentVerification"](generation)) {
            transportOwner["failReviewer"](undefined, 'reviewer parent is unavailable');
        }
        return;
    }
    try {
        const recoveredResultReusable = transportOwner.recoveredReviewerResultReusable;
        transportOwner.recoveredReviewerResultReusable = true;
        const recoveredReviewer = await transportOwner.retirePendingReviewer();
        if (!transportOwner["isCurrentVerification"](generation))
            return;
        if (recoveredReviewer?.reason === 'complete' && recoveredResultReusable) {
            const recoveredText = recoveredReviewer.finalText
                ?? transportOwner["deps"].host.getSessionFinalText(recoveredReviewer.sessionId)
                ?? '';
            const recoveredContract = transportOwner.createReviewerContract(recoveredReviewer.sessionId);
            if (parseReviewerVerdict(recoveredText, recoveredContract).result !== 'unparsed') {
                transportOwner["reviewerSessionId"] = recoveredReviewer.sessionId;
                transportOwner.reviewerContract = recoveredContract;
                transportOwner.handleVerdict(recoveredText, recoveredReviewer.sessionId);
                return;
            }
            // A completed but unbound/malformed recovered result is not eligible
            // for reuse. Retire it durably before creating a replacement so a
            // later recovery cannot rediscover it as the current reviewer.
            await transportOwner["deps"].host.setSessionStatus(recoveredReviewer.sessionId, FAILED_STATUS);
            await transportOwner["deps"].host.setKanbanColumn(recoveredReviewer.sessionId, 'todo');
        }
        else if (recoveredReviewer?.reason === 'complete') {
            await transportOwner["deps"].host.setSessionStatus(recoveredReviewer.sessionId, FAILED_STATUS);
            await transportOwner["deps"].host.setKanbanColumn(recoveredReviewer.sessionId, 'todo');
        }
        const budget = transportOwner.schedulingBudgetBreach();
        if (budget) {
            transportOwner.failForBudget(budget.metric, budget.value, budget.limit);
            return;
        }
        const cwd = transportOwner["deps"].host.getSessionWorkingDirectory(orchestrator) ?? transportOwner["spec"].cwd;
        const basePolicy = resolveIsolationPolicy(transportOwner["spec"], cwd ?? transportOwner["deps"].workspaceRoot);
        const reviewerPolicy: ExecutionIsolationPolicy = {
            ...basePolicy,
            allowedReadPaths: [...basePolicy.allowedReadPaths],
            allowedWritePaths: [],
            networkAccess: 'disabled',
            allowedHosts: [],
        };
        const isolationDecision = validateExecutionIsolationPolicy(reviewerPolicy, transportOwner["deps"].workspaceRoot);
        if (!isolationDecision.allowed) {
            transportOwner["failReviewer"](undefined, `reviewer isolation rejected: ${isolationDecision.reason ?? 'blocked'}`);
            return;
        }
        if (cwd) {
            const cwdDecision = authorizeWorkspacePath(reviewerPolicy.workspaceRoot, cwd, ['.']);
            if (!cwdDecision.allowed) {
                transportOwner["failReviewer"](undefined, `reviewer working directory rejected: ${cwdDecision.reason}`);
                return;
            }
        }
        const reviewerNode: TaskNode = {
            id: 'independent-review',
            title: `Independent review: ${transportOwner["spec"].title}`,
            prompt: 'Independently verify the completed task against its acceptance criteria and observable evidence.',
            kind: 'judge',
            effect: 'read',
        };
        const attempt = transportOwner.unparsedReAsks + 1;
        const defaults = await transportOwner["deps"].getModelDefaults?.(orchestrator);
        if (!transportOwner["isCurrentVerification"](generation))
            return;
        const inferredProfile = inferTaskNodeProfile(reviewerNode, attempt);
        const explicitSettings = resolveTaskModelSettings(reviewerNode, transportOwner["spec"], defaults);
        const route: TaskNodeExecutionRoute = transportOwner["deps"].resolveNodeRoute
            ? await transportOwner["deps"].resolveNodeRoute({
                node: reviewerNode,
                spec: transportOwner["spec"],
                attempt,
                ...(defaults !== undefined ? { defaults: defaults } : {}),
            })
            : omitUndefined<TaskNodeExecutionRoute>({
                profile: inferredProfile,
                ...explicitSettings,
                thinkingLevel: explicitSettings.thinkingLevel ?? 'medium',
                strategy: 'pinned' as const,
            });
        if (!transportOwner["isCurrentVerification"](generation))
            return;
        if (route.blockedReason) {
            transportOwner["failReviewer"](undefined, `reviewer model routing blocked: ${route.blockedReason}`);
            return;
        }
        const idempotencyKey = transportOwner["idempotencyKey"]('independent-review');
        const guardDecision = await transportOwner["deps"].executionGuard?.({
            workspaceId: transportOwner["deps"].workspaceId,
            missionId: transportOwner["spec"].id,
            runId: transportOwner["runId"],
            nodeId: reviewerNode.id,
            idempotencyKey,
            ...(cwd !== undefined ? { workingDirectory: cwd } : {}),
            policy: reviewerPolicy,
            effect: 'read',
            permissionMode: 'safe',
            fullAutonomyInherited: false,
            reviewOnly: true,
            resourceLimitsExplicit: transportOwner["spec"].execution?.max_cpu_percent !== undefined
                || transportOwner["spec"].execution?.max_memory_mb !== undefined,
        });
        if (!transportOwner["isCurrentVerification"](generation))
            return;
        if (guardDecision && !guardDecision.allowed) {
            transportOwner["failReviewer"](undefined, `execution guard rejected reviewer: ${guardDecision.reason ?? 'blocked'}`);
            return;
        }
        const reviewerCreation = transportOwner["deps"].host.createSession(transportOwner["deps"].workspaceId, {
            parentSessionId: orchestrator,
            taskSlug: transportOwner["slug"],
            taskRunId: transportOwner["runId"],
            // Host-persisted marker used to discover a reviewer even if the process
            // dies between createSession returning and the run output update.
            taskNodeId: REVIEWER_NODE_ID,
            missionRole: 'reviewer',
            executionIsolation: { effect: 'read', policy: reviewerPolicy },
            name: `Independent review: ${transportOwner["spec"].title}`,
            ...(route.model !== undefined ? { model: route.model } : {}),
            modelRoutePinned: route.modelRoutePinned === true,
            ...(route.llmConnection !== undefined ? { llmConnection: route.llmConnection } : {}),
            connectionRoutePinned: route.connectionRoutePinned === true,
            thinkingLevel: route.thinkingLevel,
            thinkingLevelPinned: route.thinkingLevelPinned === true,
            permissionMode: 'safe',
            applyTaskLabel: true,
            ...(transportOwner["spec"].sources?.length ? { enabledSourceSlugs: transportOwner["spec"].sources } : {}),
            projectId: transportOwner["spec"].project,
            ...(cwd ? { workingDirectory: cwd } : {}),
            sessionStatus: RUNNING_STATUS,
        }).then((reviewer) => {
            // Track and persist the identity before resolving the creation fence.
            // A terminal drain that raced createSession will wait for this promise
            // and then see the reviewer in pendingReviewerSessionIds.
            transportOwner["pendingReviewerSessionIds"].add(reviewer.id);
            transportOwner["log"]({ kind: 'node-spawned', nodeId: REVIEWER_NODE_ID, sessionId: reviewer.id });
            transportOwner["persistReviewerCandidateIds"]();
            return reviewer;
        });
        transportOwner["activeCreations"].add(reviewerCreation);
        void reviewerCreation.then(() => transportOwner["activeCreations"].delete(reviewerCreation), () => transportOwner["activeCreations"].delete(reviewerCreation)).catch((error: unknown) => {
            transportOwner["failForUnexpectedAsyncError"]('reviewer creation bookkeeping', error);
        });
        const reviewer = await reviewerCreation;
        if (!transportOwner["isCurrentVerification"](generation)) {
            if (transportOwner["terminalIntent"])
                return;
            await transportOwner["deps"].host.cancelProcessingAndWait(reviewer.id, REVIEWER_RETIRE_TIMEOUT_MS);
            await transportOwner["deps"].host.setSessionStatus(reviewer.id, 'cancelled');
            await transportOwner["deps"].host.setKanbanColumn(reviewer.id, 'todo');
            transportOwner["pendingReviewerSessionIds"].delete(reviewer.id);
            transportOwner["persistReviewerCandidateIds"]();
            return;
        }
        // Authenticate this Task child before its first provider turn. SessionManager
        // checks the durable node-spawned binding when accepting internalOrigin.
        transportOwner["reviewerSessionId"] = reviewer.id;
        transportOwner["reviewerPending"] = true;
        const reviewerContract = transportOwner.createReviewerContract(reviewer.id);
        transportOwner.reviewerContract = reviewerContract;
        transportOwner["persistReviewerOutput"](reviewer.id, 'pending', '', undefined, reviewerContract.evidenceText);
        transportOwner.attachVerdictListener(reviewer.id, generation);
        await transportOwner["deps"].host.setKanbanColumn(reviewer.id, 'in-progress');
        if (!transportOwner["isCurrentReviewer"](reviewer.id, generation))
            return;
        const authenticatedTaskText = transportOwner.buildReviewerPrompt(reviewerContract);
        // The SessionManager host-review contract requires the authenticated
        // spawned root message to equal the objective text byte-for-byte. The
        // isolation policy, route and reviewer role are already host metadata;
        // prepending generic specialist prose would make the root unverifiable.
        const message = authenticatedTaskText;
        await transportOwner.sendToReviewer(reviewer.id, message, generation, reviewerPolicy.timeoutMs, authenticatedTaskText);
    }
    catch (error) {
        if (transportOwner["isCurrentVerification"](generation)) {
            transportOwner["failReviewer"](transportOwner["reviewerSessionId"], `reviewer dispatch failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}

/** Accept completions only from the exact reviewer session and generation. */
export function attachVerdictListener(transportOwner: ActiveRun, reviewerSessionId: string, generation: number): void {
    transportOwner["verdictOff"]?.();
    transportOwner["verdictOff"] = transportOwner["deps"].host.onSessionComplete((evt) => {
        if (!transportOwner["isCurrentReviewer"](reviewerSessionId, generation) || evt.sessionId !== reviewerSessionId)
            return;
        transportOwner["verdictOff"]?.();
        transportOwner["verdictOff"] = undefined;
        transportOwner["clearReviewerTimeout"]();
        transportOwner["reviewerPending"] = false;
        const budget = transportOwner["accountSessionUsage"](evt);
        if (budget) {
            const reason = budget.metric === 'invalid'
                ? budget.reason
                : `reviewer exceeded ${budget.metric} budget`;
            transportOwner["persistReviewerOutput"](reviewerSessionId, 'invalid', '', reason);
            transportOwner["bestEffortHostMetadata"]('mark over-budget reviewer needs-review', reviewerSessionId, () => (transportOwner["deps"].host.setSessionStatus(reviewerSessionId, FAILED_STATUS)));
            transportOwner["bestEffortHostMetadata"]('return over-budget reviewer column to todo', reviewerSessionId, () => (transportOwner["deps"].host.setKanbanColumn(reviewerSessionId, 'todo')));
            transportOwner["reviewerSessionId"] = undefined;
            transportOwner["failForUsageIssue"](budget);
            return;
        }
        if (evt.reason !== 'complete') {
            transportOwner["failReviewer"](reviewerSessionId, `reviewer ended with ${evt.reason}`);
            return;
        }
        const text = evt.finalText ?? transportOwner["deps"].host.getSessionFinalText(reviewerSessionId) ?? '';
        transportOwner.handleVerdict(text, reviewerSessionId);
    });
}

export async function sendToReviewer(transportOwner: ActiveRun, reviewerSessionId: string, message: string, generation: number, timeoutMs: number, authenticatedTaskText?: string): Promise<void> {
    const priorSend = transportOwner.reviewerSend;
    const dispatch = (async () => {
        if (priorSend) {
            try {
                await priorSend;
            }
            catch { /* the owning call records its own failure */ }
        }
        if (!transportOwner["isCurrentReviewer"](reviewerSessionId, generation))
            return;
        // sendMessage resolves only after the provider turn has stopped in the
        // production SessionManager. Arm before awaiting it so a hung first byte,
        // provider stream or completion path is still bounded.
        transportOwner.armReviewerTimeout(reviewerSessionId, generation, timeoutMs);
        await transportOwner["deps"].host.sendMessage(reviewerSessionId, message, undefined, undefined, authenticatedTaskText && transportOwner["opts"].orchestratorSessionId
            ? {
                internalOrigin: {
                    kind: 'spawned-session',
                    senderSessionId: transportOwner["opts"].orchestratorSessionId,
                    authenticatedTaskText,
                },
            }
            : undefined);
    })();
    transportOwner.reviewerSend = dispatch;
    try {
        await dispatch;
    }
    catch (error) {
        if (transportOwner["isCurrentReviewer"](reviewerSessionId, generation)) {
            transportOwner["failReviewer"](reviewerSessionId, `reviewer send failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    finally {
        if (transportOwner.reviewerSend === dispatch)
            delete transportOwner.reviewerSend;
    }
}
