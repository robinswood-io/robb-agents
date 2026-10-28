import { join } from "node:path";
import { createAgentSession, getAgentDir, SessionManager as PiSessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentSession, AgentSessionEvent, CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import { requireExplicitPiModel } from "../model-resolution.ts";
import { activateEphemeralQueryModel, resolveEphemeralQueryThinkingLevel, resolveQueryModel } from "../query-model.ts";
import { getSessionPath } from "../../../shared/src/sessions/storage.ts";
import { buildCallLlmRequest, withTimeout, LLM_QUERY_TIMEOUT_MS } from "../../../shared/src/agent/llm-tool.ts";
import type { LLMQueryRequest, LLMQueryResult } from "../../../shared/src/agent/llm-tool.ts";
import { THINKING_TO_PI } from "../../../shared/src/agent/backend/pi/constants.ts";
import { createSystemPromptController } from "../system-prompt-override.ts";
import { assertPiAuthProviderContractEnabled } from "../provider-contract-guard.ts";
import type { InboundMessage } from "./contracts.ts";
import type { PiRuntimeState } from "./runtime-state.ts";
import { createAuthenticatedRegistry, resolvedCwd, shouldPreferCustomEndpoint } from "./endpoints.ts";
import { debugLog, send } from "./stdio.ts";

// ============================================================
// LLM Query (ephemeral session for call_llm + mini completions)
// ============================================================
export async function queryLlm(runtimeState: PiRuntimeState, request: LLMQueryRequest, systemOptions: {
    thinkingLevel?: AgentSession['thinkingLevel'];
} = {}): Promise<LLMQueryResult> {
    if (!runtimeState.initConfig)
        throw new Error('Cannot run queryLlm: init not received');
    assertPiAuthProviderContractEnabled(runtimeState.initConfig.piAuth?.provider, process.env);
    debugLog('[queryLlm] Starting');
    // `queryLlm` is the generic backend primitive used by call_llm. Its hard
    // contract is inheritance: without an explicit override, keep the session's
    // model/provider/reasoning route exactly. Utility routing belongs only in
    // explicitly identified system paths such as mini_completion and compact.
    const model = resolveQueryModel(request.model, runtimeState.initConfig.model);
    const { modelRuntime, modelRegistry } = await createAuthenticatedRegistry(runtimeState);
    const runQueryWithModel = async (modelId: string): Promise<string> => {
        debugLog(`[queryLlm] Using model: ${modelId}`);
        // Resolve model — fail fast if unresolvable so we don't let the Pi SDK
        // fall back to its own internal default (which may require a provider
        // the user hasn't authenticated with, surfacing as a misleading
        // "No API key found for <provider>" error).
        const piModel = requireExplicitPiModel(modelRegistry, modelId, runtimeState.initConfig!.piAuth?.provider, shouldPreferCustomEndpoint(runtimeState));
        // Create minimal ephemeral session
        const ephemeralOptions: CreateAgentSessionOptions = {
            cwd: resolvedCwd(runtimeState),
            modelRuntime,
            tools: [],
            sessionManager: PiSessionManager.inMemory(),
            model: piModel,
        };
        const agentDir = runtimeState.initConfig!.agentDir ?? (runtimeState.initConfig!.sessionPath
            ? join(runtimeState.initConfig!.sessionPath, '.pi-agent') : getAgentDir());
        const promptController = await createSystemPromptController({
            cwd: ephemeralOptions.cwd!, agentDir,
        });
        ephemeralOptions.agentDir = agentDir;
        ephemeralOptions.resourceLoader = promptController.resourceLoader;
        const { session: ephemeralSession } = await createAgentSession(ephemeralOptions);
        // Pi SDK ignores options.model for ephemeral sessions (same issue as options.tools).
        // Explicitly set the model after creation to ensure the selected model is used.
        await activateEphemeralQueryModel(ephemeralSession, piModel, modelId);
        const thinkingLevel = resolveEphemeralQueryThinkingLevel(systemOptions.thinkingLevel, runtimeState.piSession?.thinkingLevel, THINKING_TO_PI[runtimeState.initConfig!.thinkingLevel as keyof typeof THINKING_TO_PI]);
        if (thinkingLevel)
            ephemeralSession.setThinkingLevel(thinkingLevel);
        debugLog(`[queryLlm] Created ephemeral session: ${ephemeralSession.sessionId}`);
        // The public before_agent_start hook reapplies instructions on each turn.
        const promptForSession = request.systemPrompt ?? 'Reply with ONLY the requested text. No explanation.';
        promptController.setPrompt(promptForSession);
        // Collect response text and errors from events
        let result = '';
        let lastError = '';
        let completionResolve: () => void;
        const completionPromise = new Promise<void>((resolve) => {
            completionResolve = resolve;
        });
        const unsub = ephemeralSession.subscribe((event: AgentSessionEvent) => {
            if (event.type === 'message_end') {
                // Only capture assistant messages — Pi SDK emits message_end for user messages too
                const msg = event.message as {
                    role?: string;
                    content?: string | Array<{
                        type: string;
                        text?: string;
                    }>;
                    stopReason?: string;
                    errorMessage?: string;
                };
                if (msg.role !== 'assistant')
                    return;
                // Capture API errors from message_end (e.g. auth failures, model errors)
                if (msg.stopReason === 'error' && msg.errorMessage) {
                    lastError = msg.errorMessage;
                    debugLog(`[queryLlm] API error in message_end: ${msg.errorMessage}`);
                }
                if (typeof msg.content === 'string') {
                    result = msg.content;
                }
                else if (Array.isArray(msg.content)) {
                    result = msg.content
                        .filter((c) => c.type === 'text' && c.text)
                        .map((c) => c.text!)
                        .join('');
                }
            }
            if (event.type === 'agent_end') {
                completionResolve();
            }
        });
        try {
            await ephemeralSession.prompt(request.prompt);
            await withTimeout(completionPromise, LLM_QUERY_TIMEOUT_MS, `queryLlm timed out after ${LLM_QUERY_TIMEOUT_MS / 1000}s`);
            debugLog(`[queryLlm] Result length: ${result.trim().length}`);
            // If we got no text but captured an error, throw so callers see the real issue
            if (!result.trim() && lastError) {
                throw new Error(lastError);
            }
            return result.trim();
        }
        finally {
            unsub();
            ephemeralSession.dispose();
        }
    };
    const text = await runQueryWithModel(model);
    return { text, model };
}

export async function preExecuteCallLlm(runtimeState: PiRuntimeState, input: Record<string, unknown>): Promise<LLMQueryResult> {
    const sessionPath = runtimeState.initConfig ? getSessionPath(runtimeState.initConfig.workspaceRootPath, runtimeState.initConfig.sessionId)
        : undefined;
    const { model: _ignoredModelOverride, ...requestInput } = input;
    const request = await buildCallLlmRequest(requestInput, { backendName: 'Pi', ...(sessionPath !== undefined ? { sessionPath: sessionPath } : {}) });
    // Re-read the explicit selection after asynchronous attachment reads.
    if (runtimeState.initConfig?.model) {
        request.model = runtimeState.initConfig.model;
    }
    return queryLlm(runtimeState, request);
}

export async function handleMiniCompletion(runtimeState: PiRuntimeState, msg: Extract<InboundMessage, {
    type: 'mini_completion';
}>): Promise<void> {
    // Call queryLlm directly (not runMiniCompletion) so auth errors propagate
    // as 'error' messages instead of being swallowed and returned as null.
    try {
        if (!runtimeState.initConfig)
            throw new Error('Cannot run mini completion: init not received');
        const { modelRegistry } = await createAuthenticatedRegistry(runtimeState);
        const activeModel = requireExplicitPiModel(modelRegistry, runtimeState.initConfig.model, runtimeState.initConfig.piAuth?.provider, shouldPreferCustomEndpoint(runtimeState));
        const result = await queryLlm(runtimeState, { prompt: msg.prompt, model: activeModel.id }, { thinkingLevel: 'minimal' });
        send({ type: 'mini_completion_result', id: msg.id, text: result.text || null });
    }
    catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        debugLog(`[handleMiniCompletion] Error: ${errorMsg}`);
        send({ type: 'error', message: errorMsg, code: 'mini_completion_error' });
    }
}

// INVARIANT: the full LLMQueryRequest shape must pass through this RPC unchanged.
// Adding a field to LLMQueryRequest? Nothing to do here — we pass `msg.request`
// to queryLlm() verbatim. But verify queryLlm() actually honors the new field;
// request-propagation + request-honoring are independent (see #596).
export async function handleLlmQuery(runtimeState: PiRuntimeState, msg: Extract<InboundMessage, {
    type: 'llm_query';
}>): Promise<void> {
    try {
        const request = runtimeState.initConfig?.model
            ? { ...msg.request, model: runtimeState.initConfig.model }
            : msg.request;
        const result = await queryLlm(runtimeState, request);
        send({ type: 'llm_query_result', id: msg.id, result });
    }
    catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        debugLog(`[handleLlmQuery] Error: ${errorMsg}`);
        // Dual-emit: the generic `error` channel drives main-process OAuth
        // auth-refresh detection (centralized in PiAgent), while the targeted
        // `llm_query_result` rejects the pending promise for this specific call.
        send({ type: 'error', message: errorMsg, code: 'llm_query_error' });
        send({ type: 'llm_query_result', id: msg.id, result: null, errorMessage: errorMsg, errorCode: 'llm_query_error' });
    }
}
