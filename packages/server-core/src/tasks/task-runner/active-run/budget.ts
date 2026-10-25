import type { SessionCompletionEvent } from "../../../sessions/SessionManager";
import type { UsageIssue } from "../shared.ts";
import type { ActiveRun } from '../active-run.ts';
import type { ActiveRunSchedulingBudgetBreachResult } from './protocol.ts';

// --- completion ---
    /** Account cumulative provider usage once per session and expose hard-budget breaches. */
export function accountSessionUsage(transportOwner: ActiveRun, evt: SessionCompletionEvent): UsageIssue | null {
    if (!evt.tokenUsage)
        return null;
    const inputTokens = evt.tokenUsage.inputTokens ?? 0;
    const outputTokens = evt.tokenUsage.outputTokens ?? 0;
    const costUsd = evt.tokenUsage.costUsd ?? 0;
    const cumulativeTokens = inputTokens + outputTokens;
    if (![inputTokens, outputTokens, costUsd, cumulativeTokens].every(Number.isFinite)) {
        if (transportOwner["invalidUsageSessions"].has(evt.sessionId))
            return null;
        transportOwner["invalidUsageSessions"].add(evt.sessionId);
        return {
            metric: 'invalid',
            reason: `session ${evt.sessionId} returned non-finite token or cost usage`,
        };
    }
    const cumulative = Math.max(0, cumulativeTokens);
    const previousTokens = transportOwner["sessionTokens"].get(evt.sessionId) ?? 0;
    const tokenHighWater = Math.max(previousTokens, cumulative);
    const cumulativeCost = Math.max(0, costUsd);
    const previousCost = transportOwner["sessionCosts"].get(evt.sessionId) ?? 0;
    const costHighWater = Math.max(previousCost, cumulativeCost);
    const nextTokensUsed = transportOwner["tokensUsed"] + (tokenHighWater - previousTokens);
    const nextCostUsed = transportOwner["costUsed"] + (costHighWater - previousCost);
    if (!Number.isFinite(nextTokensUsed) || !Number.isFinite(nextCostUsed)) {
        if (transportOwner["invalidUsageSessions"].has(evt.sessionId))
            return null;
        transportOwner["invalidUsageSessions"].add(evt.sessionId);
        return {
            metric: 'invalid',
            reason: `session ${evt.sessionId} overflowed cumulative token or cost usage`,
        };
    }
    transportOwner["tokensUsed"] = nextTokensUsed;
    transportOwner["sessionTokens"].set(evt.sessionId, tokenHighWater);
    transportOwner["costUsed"] = nextCostUsed;
    transportOwner["sessionCosts"].set(evt.sessionId, costHighWater);
    transportOwner["log"]({
        kind: 'usage-updated',
        tokensUsed: transportOwner["tokensUsed"],
        costUsed: transportOwner["costUsed"],
        currency: 'USD',
        sourceSessionId: evt.sessionId,
        cumulativeTokens: tokenHighWater,
        cumulativeCostUsd: costHighWater,
    });
    return transportOwner["measuredBudgetBreach"]();
}

export function failForUsageIssue(transportOwner: ActiveRun, issue: UsageIssue): void {
    if (issue.metric !== 'invalid') {
        transportOwner["failForBudget"](issue.metric, issue.value, issue.limit);
        return;
    }
    if (transportOwner["isTerminal"]() || transportOwner["terminalIntent"])
        return;
    transportOwner["setTerminalIntent"]({ target: 'failed', cause: 'recovery', reason: issue.reason });
    transportOwner["markRunningNodesCancelled"](issue.reason);
    transportOwner["beginTerminalDrain"]();
}

// --- hard limits ---
export function tokenBudgetLimit(transportOwner: ActiveRun): number | undefined {
    const candidates = [
        transportOwner["spec"].token_budget,
        transportOwner["spec"].mission?.budget?.max_tokens,
    ].filter((value): value is number => value !== undefined);
    return candidates.length > 0 ? Math.min(...candidates) : undefined;
}

export function costBudgetLimit(transportOwner: ActiveRun): number | undefined {
    return transportOwner["spec"].mission?.budget?.max_cost;
}

/** A limit reached before a new dispatch is fail-closed: no unbudgeted work starts. */
export function schedulingBudgetBreach(transportOwner: ActiveRun): ActiveRunSchedulingBudgetBreachResult | null {
    const tokenLimit = transportOwner["tokenBudgetLimit"]();
    if (tokenLimit !== undefined && transportOwner["tokensUsed"] >= tokenLimit) {
        return { metric: 'tokens', value: transportOwner["tokensUsed"], limit: tokenLimit };
    }
    const costLimit = transportOwner["costBudgetLimit"]();
    if (costLimit !== undefined && transportOwner["costUsed"] >= costLimit) {
        return { metric: 'cost', value: transportOwner["costUsed"], limit: costLimit };
    }
    return null;
}

/** Measured usage may overshoot between provider reports; overshoot immediately fails the run. */
export function measuredBudgetBreach(transportOwner: ActiveRun): ActiveRunSchedulingBudgetBreachResult | null {
    const tokenLimit = transportOwner["tokenBudgetLimit"]();
    if (tokenLimit !== undefined && transportOwner["tokensUsed"] > tokenLimit) {
        return { metric: 'tokens', value: transportOwner["tokensUsed"], limit: tokenLimit };
    }
    const costLimit = transportOwner["costBudgetLimit"]();
    if (costLimit !== undefined && transportOwner["costUsed"] > costLimit) {
        return { metric: 'cost', value: transportOwner["costUsed"], limit: costLimit };
    }
    return null;
}

export function failForBudget(transportOwner: ActiveRun, metric: 'tokens' | 'cost', value: number, limit: number): void {
    if (transportOwner["isTerminal"]() || transportOwner["terminalIntent"])
        return;
    transportOwner["log"]({ kind: 'budget-breach', metric, value, limit });
    const reason = `hard ${metric} budget breached`;
    transportOwner["setTerminalIntent"]({ target: 'failed', cause: 'budget', reason });
    transportOwner["markRunningNodesCancelled"](reason);
    transportOwner["beginTerminalDrain"]();
}

export function deadlineExpired(transportOwner: ActiveRun): boolean {
    const deadline = transportOwner["spec"].mission?.deadline;
    return deadline !== undefined && transportOwner["currentTimeMs"]() >= Date.parse(deadline);
}

export function armDeadline(transportOwner: ActiveRun): void {
    const deadline = transportOwner["spec"].mission?.deadline;
    if (!deadline || transportOwner["isTerminal"]())
        return;
    if (transportOwner["deadlineTimeout"])
        clearTimeout(transportOwner["deadlineTimeout"]);
    const remainingMs = Date.parse(deadline) - transportOwner["currentTimeMs"]();
    if (remainingMs <= 0) {
        transportOwner["failForDeadline"]();
        return;
    }
    // Node timers cap at a signed 32-bit delay. Re-arm long deadlines safely.
    transportOwner["deadlineTimeout"] = setTimeout(() => {
        transportOwner["deadlineTimeout"] = undefined;
        if (transportOwner["deadlineExpired"]())
            transportOwner["failForDeadline"]();
        else
            transportOwner["armDeadline"]();
    }, Math.min(remainingMs, 2147483647));
}

export function failForDeadline(transportOwner: ActiveRun): void {
    if (transportOwner["isTerminal"]() || transportOwner["terminalIntent"])
        return;
    const deadline = transportOwner["spec"].mission?.deadline;
    if (!deadline)
        return;
    transportOwner["log"]({ kind: 'deadline-breach', deadline });
    const reason = 'mission deadline breached';
    transportOwner["setTerminalIntent"]({ target: 'failed', cause: 'deadline', reason });
    transportOwner["markRunningNodesCancelled"](reason);
    transportOwner["beginTerminalDrain"]();
}
