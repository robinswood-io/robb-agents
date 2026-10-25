import { DEFAULT_STAGNATION_LIMIT } from "@craft-agent/shared/tasks";
import { resolveIsolationPolicy } from "../shared.ts";
import { MAX_UNPARSED_REASKS, repairOutputFingerprint, parseReviewerVerdict } from "../review.ts";
import type { RepairReflection } from "../review.ts";
import type { ActiveRun } from '../active-run.ts';

/**
     * Apply the independent reviewer's parsed result:
     *   PASS      → completed.
     *   unparsed  → re-ask for a well-formed verdict (bounded; not a repair); exhausted → failed.
     *   FAIL      → repair the frontier if budget remains, else failed (iterations/token budget breach).
     */
export function handleVerdict(transportOwner: ActiveRun, text: string, reviewerSessionId: string): void {
    if (transportOwner["runStatus"] !== 'verifying')
        return; // stopped/finalized while awaiting the verdict
    const contract = transportOwner["reviewerContract"] ?? transportOwner["createReviewerContract"](reviewerSessionId);
    const verdict = parseReviewerVerdict(text, contract);
    transportOwner["persistReviewerOutput"](reviewerSessionId, verdict.result === 'unparsed' ? 'invalid' : verdict.result, text, verdict.result === 'unparsed' ? verdict.reason : undefined);
    if (verdict.result === 'pass') {
        transportOwner["log"]({ kind: 'verdict', result: 'pass', reason: verdict.reason, nodes: verdict.nodes });
        transportOwner["unparsedReAsks"] = 0;
        transportOwner["settleReviewerSession"](reviewerSessionId, true);
        transportOwner["finish"]('completed');
        return;
    }
    if (verdict.result === 'unparsed') {
        transportOwner["log"]({ kind: 'verdict', result: 'unparsed', reason: verdict.reason, nodes: verdict.nodes });
        if (transportOwner["unparsedReAsks"] < MAX_UNPARSED_REASKS) {
            transportOwner["unparsedReAsks"] += 1;
            void transportOwner["reAskVerdict"](reviewerSessionId, verdict.reason, text).catch((error) => {
                transportOwner["failForUnexpectedAsyncError"]('reviewer verdict re-ask', error);
            });
            return;
        }
        transportOwner["settleReviewerSession"](reviewerSessionId, false);
        transportOwner["finish"]('failed');
        return;
    }
    transportOwner["settleReviewerSession"](reviewerSessionId, true);
    // FAIL — repair the frontier if there is budget for it.
    const reflection = transportOwner["recordRepairReflection"](verdict.reason ?? 'The result did not meet the acceptance criteria.', verdict.nodes);
    transportOwner["log"]({
        kind: 'verdict',
        result: 'fail',
        reason: verdict.reason,
        nodes: verdict.nodes,
        outputFingerprint: reflection.outputFingerprint,
        frontier: reflection.frontier,
        stagnantRepeats: transportOwner["stagnantRepeats"],
    });
    const stagnationLimit = transportOwner["spec"].autonomy?.stagnation_limit ?? DEFAULT_STAGNATION_LIMIT;
    if (transportOwner["stagnantRepeats"] >= stagnationLimit) {
        transportOwner["log"]({
            kind: 'stagnation-detected',
            fingerprint: reflection.outputFingerprint,
            repetitions: transportOwner["stagnantRepeats"],
            limit: stagnationLimit,
            nodes: reflection.frontier,
            reason: 'Verifier-driven repair revisited a previously rejected observable result.',
        });
        transportOwner["finish"]('failed');
        return;
    }
    if (transportOwner["repairsUsed"] >= transportOwner["maxRepairs"]) {
        transportOwner["log"]({ kind: 'budget-breach', metric: 'iterations', value: transportOwner["repairsUsed"], limit: transportOwner["maxRepairs"] });
        transportOwner["finish"]('failed');
        return;
    }
    const budget = transportOwner["schedulingBudgetBreach"]();
    if (budget) {
        transportOwner["failForBudget"](budget.metric, budget.value, budget.limit);
        return;
    }
    transportOwner["repairsUsed"] += 1;
    transportOwner["repairForVerdict"](verdict.reason, verdict.nodes);
}

/** Record one bounded, durable feedback episode and evaluate whether the run made progress. */
export function recordRepairReflection(transportOwner: ActiveRun, reason: string, named?: string[]): RepairReflection {
    const frontier = [...transportOwner["computeFrontier"](named)].sort();
    const outputFingerprint = repairOutputFingerprint(frontier, transportOwner["outputs"]);
    if (transportOwner["rejectedFingerprints"].has(outputFingerprint))
        transportOwner["stagnantRepeats"] += 1;
    else
        transportOwner["stagnantRepeats"] = 0;
    transportOwner["rejectedFingerprints"].add(outputFingerprint);
    const reflection: RepairReflection = {
        iteration: transportOwner["repairsUsed"] + 1,
        reason,
        frontier,
        outputFingerprint,
    };
    transportOwner["reflectionHistory"].push(reflection);
    return reflection;
}

/** Re-ask the same reviewer for strict JSON without consuming repair budget. */
export async function reAskVerdict(transportOwner: ActiveRun, reviewerSessionId: string, previousResponse: string, parseFailure?: string): Promise<void> {
    // A completion emitter may iterate a live Set. Never attach the next
    // generation's listener from inside the current listener's call stack, or
    // the same completion event could be consumed twice. In production also
    // wait for SessionManager's current send transaction to finish unwinding.
    const completingSend = transportOwner["reviewerSend"];
    await Promise.resolve();
    if (completingSend) {
        try {
            await completingSend;
        }
        catch { /* the owning dispatch records the error */ }
    }
    if (transportOwner["runStatus"] !== 'verifying' || transportOwner["reviewerSessionId"] !== reviewerSessionId)
        return;
    const generation = ++transportOwner["verificationGeneration"];
    transportOwner["reviewerPending"] = true;
    const contract = transportOwner["reviewerContract"] ?? transportOwner["createReviewerContract"](reviewerSessionId);
    // Keep the exact target file stable across format-only retries. The prior
    // response is still hashed and the parse failure is persisted in params,
    // but replacing the evidence text would invalidate the reviewer's already
    // registered Read check and make the host binding impossible to satisfy.
    transportOwner["persistReviewerOutput"](reviewerSessionId, 'pending', previousResponse, parseFailure, contract.evidenceText);
    transportOwner["attachVerdictListener"](reviewerSessionId, generation);
    const message = [
        `Your previous result was rejected by the parser${parseFailure ? `: ${parseFailure}` : '.'}`,
        'Reply with exactly one host-review-v2 JSON object, no Markdown fence or surrounding prose.',
        `Preserve this exact binding: ${JSON.stringify({
            objectiveId: contract.objectiveId,
            acceptanceSha256: contract.acceptanceSha256,
        })}.`,
        `Report every criterion exactly once: ${JSON.stringify(contract.criteria)}.`,
        '',
        // Repeat the exact authenticated objective and envelope. SessionManager
        // keeps the active objective root because this continuation has the same
        // spawned-session origin, while routing and crash recovery retain the
        // original host-review-v2 binding on the re-ask turn itself.
        transportOwner["buildReviewerPrompt"](contract),
    ].join('\n');
    const timeoutMs = resolveIsolationPolicy(transportOwner["spec"], transportOwner["deps"].host.getSessionWorkingDirectory(transportOwner["opts"].orchestratorSessionId!)
        ?? transportOwner["spec"].cwd
        ?? transportOwner["deps"].workspaceRoot).timeoutMs;
    await transportOwner["sendToReviewer"](reviewerSessionId, message, generation, timeoutMs, transportOwner["buildReviewerPrompt"](contract));
}

/**
     * On a FAIL verdict, re-run the repair frontier with the rejection reason as failure context.
     * The frontier is the orchestrator-named nodes ∪ their transitive dependents (so a re-run upstream
     * node forces everything that consumes its output to re-run too). With no usable names it is the
     * whole DAG. Only `done` nodes are reset; scheduleReady re-dispatches from the satisfied sources.
     */
export function repairForVerdict(transportOwner: ActiveRun, reason: string | undefined, named?: string[]): void {
    const detail = reason ?? 'the result did not meet the acceptance criteria';
    let reset = 0;
    for (const id of transportOwner["computeFrontier"](named)) {
        const st = transportOwner["state"].get(id);
        if (!st || st.state !== 'done')
            continue;
        st.state = 'pending';
        // An approval authorizes one concrete attempt, never a later verifier-driven replay.
        transportOwner["approvedNodes"].delete(id);
        st.lastFailure = `The previous result was rejected on verification: ${detail}. Revise your output to meet the acceptance criteria.`;
        transportOwner["log"]({ kind: 'node-retry', nodeId: id, attempt: st.attempt, reason: `verdict-fail: ${detail}` });
        reset += 1;
    }
    if (reset === 0) {
        // No `done` node in the frontier to re-run → don't hang the run.
        transportOwner["finish"]('failed');
        return;
    }
    transportOwner["runStatus"] = 'running';
    transportOwner["scheduleReady"]();
}
