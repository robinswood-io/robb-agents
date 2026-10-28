import { omitUndefined } from '@craft-agent/shared/utils/json';
import { resolvePiModelWithCustomFallback } from "../model-resolution.ts";
import { normalizeCustomEndpointModelEntry } from "../custom-endpoint-models.ts";
import type { CustomEndpointModelEntry } from "../custom-endpoint-models.ts";
import { compactSelectedModel } from "../compact-selected-model.ts";
import { applySelectedThinkingLevel } from "../selected-thinking-level.ts";
import type { RuntimeConfigUpdateMessage, InboundMessage } from "./contracts.ts";
import type { PiRuntimeState } from "./runtime-state.ts";
import { registerCustomEndpointModels, setInterceptorApiHints, shouldPreferCustomEndpoint, syncStrictLocalEndpointNetworkGuard } from "./endpoints.ts";
import { waitForCompaction } from "./prompts.ts";
import { ensureSession } from "./session.ts";
import { debugLog, send } from "./stdio.ts";

export async function handleEnsureSessionReady(runtimeState: PiRuntimeState, msg: Extract<InboundMessage, {
    type: 'ensure_session_ready';
}>): Promise<void> {
    const session = await ensureSession(runtimeState);
    send({
        type: 'ensure_session_ready_result',
        id: msg.id,
        sessionId: session.sessionId || null,
    });
}

export async function handleCompact(runtimeState: PiRuntimeState, msg: Extract<InboundMessage, {
    type: 'compact';
}>): Promise<void> {
    try {
        const session = await ensureSession(runtimeState);
        // Serialize manual /compact behind any in-flight auto-compaction. Public
        // session.compact() calls agent.abort() and uses its own controller; if
        // it runs while _runAutoCompaction is suspended, agent state churns and
        // the SDK's race surface widens. Wait for the auto-compaction to drain
        // before starting a manual one. waitForCompaction has its own timeout
        // fallback so we don't deadlock on a stuck subprocess.
        const settled = await waitForCompaction(session, 30000);
        if (!settled) {
            throw new Error('Previous compaction did not settle before the safety deadline');
        }
        const result = await compactSelectedModel(session, msg.customInstructions);
        send({
            type: 'compact_result',
            id: msg.id,
            success: true,
            result: {
                summary: result.summary,
                firstKeptEntryId: result.firstKeptEntryId,
                tokensBefore: result.tokensBefore,
                ...(result.estimatedTokensAfter !== undefined ? { estimatedTokensAfter: result.estimatedTokensAfter } : {}),
                compactionModel: result.compactionModel,
            },
        });
    }
    catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        debugLog(`[compact] Failed: ${errorMsg}`);
        send({
            type: 'compact_result',
            id: msg.id,
            success: false,
            errorMessage: errorMsg,
        });
    }
}

export function handleAbortCompaction(runtimeState: PiRuntimeState, msg: Extract<InboundMessage, {
    type: 'abort_compaction';
}>): void {
    debugLog(`[${msg.id}] Aborting compaction after host timeout`);
    runtimeState.piSession?.abortCompaction();
}

export async function handleSetAutoCompaction(runtimeState: PiRuntimeState, msg: Extract<InboundMessage, {
    type: 'set_auto_compaction';
}>): Promise<void> {
    try {
        const session = await ensureSession(runtimeState);
        session.setAutoCompactionEnabled(msg.enabled);
        send({
            type: 'set_auto_compaction_result',
            id: msg.id,
            success: true,
            enabled: session.autoCompactionEnabled,
        });
    }
    catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        debugLog(`[set_auto_compaction] Failed: ${errorMsg}`);
        send({
            type: 'set_auto_compaction_result',
            id: msg.id,
            success: false,
            enabled: msg.enabled,
            errorMessage: errorMsg,
        });
    }
}

export async function handleUpdateRuntimeConfig(runtimeState: PiRuntimeState, msg: RuntimeConfigUpdateMessage): Promise<void> {
    try {
        if (!runtimeState.initConfig) {
            throw new Error('Runtime config update received before init');
        }
        runtimeState.initConfig = omitUndefined<NonNullable<PiRuntimeState['initConfig']>>({
            ...runtimeState.initConfig,
            model: msg.model,
            providerType: msg.providerType ?? runtimeState.initConfig.providerType,
            authType: msg.authType ?? runtimeState.initConfig.authType,
            baseUrl: msg.baseUrl,
            customEndpoint: msg.customEndpoint,
            customModels: msg.customModels,
        });
        syncStrictLocalEndpointNetworkGuard(runtimeState);
        if (runtimeState.piModelRegistry && runtimeState.initConfig.baseUrl?.trim() && runtimeState.initConfig.customEndpoint) {
            const modelEntries: CustomEndpointModelEntry[] = (runtimeState.initConfig.customModels?.length
                ? runtimeState.initConfig.customModels
                : [runtimeState.initConfig.model || 'default']).map(normalizeCustomEndpointModelEntry);
            runtimeState.customEndpointModelIds = new Set();
            runtimeState.customModelOverrides.clear();
            registerCustomEndpointModels(runtimeState, runtimeState.piModelRegistry, runtimeState.initConfig.customEndpoint.api, runtimeState.initConfig.baseUrl.trim(), modelEntries);
        }
        if (runtimeState.piSession && runtimeState.piModelRegistry) {
            const registry = runtimeState.piModelRegistry;
            const endpoint = runtimeState.initConfig.customEndpoint;
            const baseUrl = runtimeState.initConfig.baseUrl?.trim();
            const piModel = resolvePiModelWithCustomFallback(registry, msg.model, runtimeState.initConfig.piAuth?.provider, shouldPreferCustomEndpoint(runtimeState), endpoint && baseUrl ? (bareId) => {
                registerCustomEndpointModels(runtimeState, registry, endpoint.api, baseUrl, [{ id: bareId }]);
                debugLog(`[runtime_config] Dynamically registered custom endpoint model: ${bareId}`);
            } : undefined);
            if (!piModel) {
                throw new Error(`Could not resolve model after runtime update: ${msg.model}`);
            }
            await runtimeState.piSession.setModel(piModel);
            setInterceptorApiHints(piModel as {
                api?: string;
                provider?: string;
                baseUrl?: string;
            });
            debugLog(`[runtime_config] Updated runtime config and active model: ${piModel.provider}/${piModel.id}`);
        }
        else {
            debugLog('[runtime_config] Stored update; no active session/model registry yet');
        }
        send({ type: 'update_runtime_config_result', id: msg.id, success: true, updated: true });
    }
    catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        debugLog(`[runtime_config] Failed: ${errorMsg}`);
        send({ type: 'update_runtime_config_result', id: msg.id, success: false, updated: false, errorMessage: errorMsg });
    }
}

export async function handleSetModel(runtimeState: PiRuntimeState, msg: Extract<InboundMessage, {
    type: 'set_model';
}>): Promise<void> {
    debugLog(`[set_model] Received: ${msg.model}`);
    if (!runtimeState.initConfig) {
        send({ type: 'error', code: 'model_error', message: 'Model selection received before init' });
        return;
    }
    // Persist the requested selection even when activation fails. The next turn
    // must validate it again instead of continuing with the previous model.
    runtimeState.initConfig.model = msg.model;
    if (!runtimeState.piSession || !runtimeState.piModelRegistry) {
        debugLog('[set_model] Stored selection for the next session');
        return;
    }
    try {
        // For custom endpoints, dynamically register unknown models so mid-session
        // switching works while keeping the selected provider as a strict boundary.
        const endpoint = runtimeState.initConfig.customEndpoint;
        const baseUrl = runtimeState.initConfig.baseUrl?.trim();
        const piModel = resolvePiModelWithCustomFallback(runtimeState.piModelRegistry, msg.model, runtimeState.initConfig.piAuth?.provider, shouldPreferCustomEndpoint(runtimeState), endpoint && baseUrl ? (bareId) => {
            registerCustomEndpointModels(runtimeState, runtimeState.piModelRegistry!, endpoint.api, baseUrl, [{ id: bareId }]);
            debugLog(`[set_model] Dynamically registered custom endpoint model: ${bareId}`);
        } : undefined);
        if (!piModel) {
            throw new Error(`Could not resolve selected model: ${msg.model}`);
        }
        await runtimeState.piSession.setModel(piModel);
        setInterceptorApiHints(piModel as {
            api?: string;
            provider?: string;
            baseUrl?: string;
        });
        debugLog(`[set_model] Model changed to: ${msg.model} (resolved: ${piModel.provider}/${piModel.id})`);
    }
    catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        debugLog(`[set_model] Failed to set model: ${errorMsg}`);
        runtimeState.unsubscribeEvents?.();
        runtimeState.unsubscribeEvents = null;
        runtimeState.piSession.dispose();
        runtimeState.piSession = null;
        setInterceptorApiHints(undefined);
        send({ type: 'error', code: 'model_error', message: errorMsg });
    }
}

export async function handleSetThinkingLevel(runtimeState: PiRuntimeState, msg: Extract<InboundMessage, {
    type: 'set_thinking_level';
}>): Promise<void> {
    debugLog(`[set_thinking_level] Received: ${msg.level}`);
    try {
        applySelectedThinkingLevel(runtimeState.initConfig, runtimeState.piSession, msg.level);
        debugLog(`[set_thinking_level] Stored selected reasoning: ${msg.level}${runtimeState.piSession ? ' and applied to active session' : ' for next session'}`);
    }
    catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        debugLog(`[set_thinking_level] Failed to set thinking level: ${errorMsg}`);
        send({ type: 'error', code: 'thinking_level_error', message: errorMsg });
    }
}
