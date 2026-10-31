import { ProviderDispatchRejectedError } from "../backend/types.ts";
// LLM tool types
import { LLM_QUERY_TIMEOUT_MS, type LLMQueryRequest, type LLMQueryResult } from "../llm-tool.ts";
import type { PiAgent } from '../pi-agent.ts';

export async function runMiniCompletion(transportOwner: PiAgent, prompt: string): Promise<string | null> {
    await transportOwner["config"].beforeProviderExecution?.();
    if (transportOwner["config"].missionCapabilityLock) {
        throw new ProviderDispatchRejectedError('Auxiliary mini-model completion is disabled for a specialized Mission');
    }
    // If subprocess isn't running, spawn it
    await transportOwner.ensureSubprocess();
    const id = `mini-${++transportOwner.rpcIdCounter}`;
    const resultPromise = new Promise<string | null>((resolve, reject) => {
        transportOwner.pendingMiniCompletions.set(id, { resolve, reject });
    });
    transportOwner["send"]({
        type: 'mini_completion',
        id,
        prompt,
        allowModelSubstitution: false,
    });
    // Keep this aligned with the subprocess-side queryLlm timeout.
    const timeout = new Promise<string | null>((resolve) => {
        setTimeout(() => {
            if (transportOwner.pendingMiniCompletions.has(id)) {
                transportOwner.pendingMiniCompletions.delete(id);
                transportOwner["debug"](`[runMiniCompletion] Timed out after ${LLM_QUERY_TIMEOUT_MS / 1000}s`);
                resolve(null);
            }
        }, LLM_QUERY_TIMEOUT_MS);
    });
    const text = await Promise.race([resultPromise, timeout]);
    transportOwner["debug"](`[runMiniCompletion] Result: ${text ? `"${text.slice(0, 200)}"` : 'null'}`);
    return text;
}

export async function queryLlm(transportOwner: PiAgent, request: LLMQueryRequest): Promise<LLMQueryResult> {
    transportOwner["debug"]('[PiAgent.queryLlm] Starting');
    await transportOwner["config"].beforeProviderExecution?.();
    await transportOwner.ensureSubprocess();
    const id = `llm-${++transportOwner.rpcIdCounter}`;
    const resultPromise = new Promise<LLMQueryResult>((resolve, reject) => {
        transportOwner.pendingLlmQueries.set(id, { resolve, reject });
    });
    const model = transportOwner["getModel"]();
    transportOwner["send"]({
        type: 'llm_query',
        id,
        request: { ...request, model },
        allowModelSubstitution: false,
    });
    // Keep this aligned with the subprocess-side queryLlm timeout.
    const timeout = new Promise<LLMQueryResult>((_, reject) => {
        setTimeout(() => {
            if (transportOwner.pendingLlmQueries.has(id)) {
                transportOwner.pendingLlmQueries.delete(id);
                reject(new Error(`queryLlm timed out after ${LLM_QUERY_TIMEOUT_MS / 1000}s`));
            }
        }, LLM_QUERY_TIMEOUT_MS);
    });
    return Promise.race([resultPromise, timeout]);
}
