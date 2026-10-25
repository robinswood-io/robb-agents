import { type AgentEvent, type SdkAutomationInput } from "../types.ts";
import { matcherMatchesSdk } from "../utils.ts";
import type { AutomationSystem } from '../automation-system.ts';
import { log } from './shared.ts';

export async function executeAgentEvent(transportOwner: AutomationSystem, event: AgentEvent, input: SdkAutomationInput, signal?: AbortSignal): Promise<number> {
    if (!transportOwner["config"])
        return 0;
    const matchers = transportOwner["config"].automations[event];
    if (!matchers?.length)
        return 0;
    let matchedCount = 0;
    for (const matcher of matchers) {
        if (!matcherMatchesSdk(matcher, event, input))
            continue;
        matchedCount++;
        // Note: Command execution has been removed. Prompt-based execution for
        // non-Claude backends is not yet implemented. This method currently only
        // validates matching (including condition gating) — actual execution is a no-op.
        log.debug(`[AutomationSystem] Matched ${event} automation (prompt-based execution pending)`);
    }
    return matchedCount;
}
