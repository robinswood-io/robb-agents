import type { BackendRuntimeUpdate } from "../backend/types.ts";
import { getBackendRuntime } from "../backend/internal/driver-types.ts";
import type { PiAgent } from '../pi-agent.ts';
import type { PiCompactionResult } from './protocol.ts';

/**
   * Handle ensure_session_ready_result from subprocess.
   */
export function handleEnsureSessionReadyResult(transportOwner: PiAgent, msg: Record<string, unknown>): void {
    const id = msg.id as string;
    const sessionId = (msg.sessionId as string | null) ?? null;
    const pending = transportOwner["pendingEnsureSessionReady"].get(id);
    if (!pending)
        return;
    transportOwner["pendingEnsureSessionReady"].delete(id);
    if (sessionId && transportOwner["piSessionId"] !== sessionId) {
        transportOwner["piSessionId"] = sessionId;
        transportOwner["config"].onSdkSessionIdUpdate?.(sessionId);
    }
    pending.resolve(sessionId);
}

/**
   * Handle compact_result from subprocess.
   */
export function handleCompactResult(transportOwner: PiAgent, msg: Record<string, unknown>): void {
    const id = msg.id as string;
    const success = Boolean(msg.success);
    const pending = transportOwner["pendingCompactions"].get(id);
    if (!pending)
        return;
    transportOwner["pendingCompactions"].delete(id);
    if (!success) {
        pending.reject(new Error(String(msg.errorMessage || 'Compaction failed')));
        return;
    }
    const raw = msg.result as Record<string, unknown> | undefined;
    if (!raw) {
        pending.resolve(null);
        return;
    }
    pending.resolve({
        summary: String(raw.summary || ''),
        firstKeptEntryId: String(raw.firstKeptEntryId || ''),
        tokensBefore: Number(raw.tokensBefore || 0),
        estimatedTokensAfter: typeof raw.estimatedTokensAfter === 'number'
            ? raw.estimatedTokensAfter
            : undefined,
        compactionModel: typeof raw.compactionModel === 'string'
            ? raw.compactionModel
            : undefined,
    });
}

/**
   * Handle set_auto_compaction_result from subprocess.
   */
export function handleSetAutoCompactionResult(transportOwner: PiAgent, msg: Record<string, unknown>): void {
    const id = msg.id as string;
    const success = Boolean(msg.success);
    const pending = transportOwner["pendingAutoCompactionToggles"].get(id);
    if (!pending)
        return;
    transportOwner["pendingAutoCompactionToggles"].delete(id);
    if (!success) {
        pending.reject(new Error(String(msg.errorMessage || 'Failed to set auto-compaction')));
        return;
    }
    pending.resolve(Boolean(msg.enabled));
}

/**
   * Handle update_runtime_config_result from subprocess.
   */
export function handleRuntimeConfigUpdateResult(transportOwner: PiAgent, msg: Record<string, unknown>): void {
    const id = msg.id as string;
    const success = Boolean(msg.success);
    const pending = transportOwner["pendingRuntimeConfigUpdates"].get(id);
    if (!pending)
        return;
    transportOwner["pendingRuntimeConfigUpdates"].delete(id);
    if (!success) {
        pending.reject(new Error(String(msg.errorMessage || 'Runtime config update failed')));
        return;
    }
    pending.resolve(Boolean(msg.updated ?? true));
}

/**
   * Ask subprocess to create/verify the primary session (without sending a prompt)
   * and return the active Pi session ID.
   */
export async function requestEnsureSessionReady(transportOwner: PiAgent): Promise<string | null> {
    await transportOwner["ensureSubprocess"]();
    const id = `ensure-ready-${++transportOwner["rpcIdCounter"]}`;
    const timeoutMs = 15000;
    return new Promise<string | null>((resolve, reject) => {
        const timer = setTimeout(() => {
            transportOwner["pendingEnsureSessionReady"].delete(id);
            reject(new Error(`ensure_session_ready timed out after ${Math.floor(timeoutMs / 1000)}s`));
        }, timeoutMs);
        transportOwner["pendingEnsureSessionReady"].set(id, {
            resolve: (sessionId) => {
                clearTimeout(timer);
                resolve(sessionId);
            },
            reject: (error) => {
                clearTimeout(timer);
                reject(error);
            },
        });
        transportOwner["send"]({ type: 'ensure_session_ready', id });
    });
}

/**
   * Ask subprocess to compact the active session context.
   */
export async function requestCompact(transportOwner: PiAgent, customInstructions?: string): Promise<PiCompactionResult | null> {
    await transportOwner["ensureSubprocess"]();
    const id = `compact-${++transportOwner["rpcIdCounter"]}`;
    // GPT-backed Pi compactions on large conversations can legitimately take 60-120s.
    // Bound them at 210s and explicitly abort the SDK compaction on expiry so a
    // lost response cannot keep consuming tokens in the subprocess indefinitely.
    const timeoutMs = 210000;
    return new Promise<{
        summary: string;
        firstKeptEntryId: string;
        tokensBefore: number;
        estimatedTokensAfter?: number;
        compactionModel?: string;
    } | null>((resolve, reject) => {
        const timer = setTimeout(() => {
            transportOwner["pendingCompactions"].delete(id);
            transportOwner["send"]({ type: 'abort_compaction', id });
            reject(new Error(`compact timed out after ${Math.floor(timeoutMs / 1000)}s`));
        }, timeoutMs);
        transportOwner["pendingCompactions"].set(id, {
            resolve: (result) => {
                clearTimeout(timer);
                resolve(result);
            },
            reject: (error) => {
                clearTimeout(timer);
                reject(error);
            },
        });
        transportOwner["send"]({ type: 'compact', id, customInstructions });
    });
}

export async function compactContext(transportOwner: PiAgent, customInstructions?: string): Promise<PiCompactionResult | null> {
    return transportOwner["requestCompact"](customInstructions);
}

/**
   * Ask subprocess to enable/disable auto-compaction.
   */
export async function requestSetAutoCompaction(transportOwner: PiAgent, enabled: boolean): Promise<boolean> {
    await transportOwner["ensureSubprocess"]();
    const id = `set-auto-compaction-${++transportOwner["rpcIdCounter"]}`;
    const timeoutMs = 15000;
    return new Promise<boolean>((resolve, reject) => {
        const timer = setTimeout(() => {
            transportOwner["pendingAutoCompactionToggles"].delete(id);
            reject(new Error(`set_auto_compaction timed out after ${Math.floor(timeoutMs / 1000)}s`));
        }, timeoutMs);
        transportOwner["pendingAutoCompactionToggles"].set(id, {
            resolve: (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            reject: (error) => {
                clearTimeout(timer);
                reject(error);
            },
        });
        transportOwner["send"]({ type: 'set_auto_compaction', id, enabled });
    });
}

/**
   * Ask subprocess to refresh runtime-affecting custom endpoint config in-place.
   */
export async function requestRuntimeConfigUpdate(transportOwner: PiAgent, update: BackendRuntimeUpdate): Promise<boolean> {
    if (!transportOwner["subprocess"])
        return true;
    const id = `runtime-config-${++transportOwner["rpcIdCounter"]}`;
    const timeoutMs = 15000;
    const runtime = update.runtime ?? {};
    return new Promise<boolean>((resolve, reject) => {
        const timer = setTimeout(() => {
            transportOwner["pendingRuntimeConfigUpdates"].delete(id);
            reject(new Error(`update_runtime_config timed out after ${Math.floor(timeoutMs / 1000)}s`));
        }, timeoutMs);
        transportOwner["pendingRuntimeConfigUpdates"].set(id, {
            resolve: (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            reject: (error) => {
                clearTimeout(timer);
                reject(error);
            },
        });
        transportOwner["send"]({
            type: 'update_runtime_config',
            id,
            model: update.model,
            providerType: update.providerType,
            authType: update.authType,
            baseUrl: runtime.baseUrl,
            customEndpoint: runtime.customEndpoint,
            customModels: runtime.customModels,
        });
    });
}

export async function ensureBranchReady(transportOwner: PiAgent): Promise<void> {
    const isBranchedSession = !!transportOwner["config"].session?.branchFromMessageId;
    if (!isBranchedSession)
        return;
    // Branched sessions must include parent session path metadata for Pi forking.
    if (!transportOwner["config"].session?.branchFromSessionPath) {
        throw new Error('Pi branch preflight failed: missing branchFromSessionPath metadata');
    }
    const sessionId = await transportOwner["requestEnsureSessionReady"]();
    if (!sessionId) {
        throw new Error('Pi branch preflight failed: subprocess did not provide a session ID');
    }
    if (transportOwner["piSessionId"] !== sessionId) {
        transportOwner["piSessionId"] = sessionId;
        transportOwner["config"].onSdkSessionIdUpdate?.(sessionId);
    }
}

export async function updateRuntimeConfig(transportOwner: PiAgent, update: BackendRuntimeUpdate): Promise<boolean> {
    const previousModel = transportOwner["getModel"]();
    const previousRuntime = getBackendRuntime(transportOwner["config"]);
    transportOwner["config"] = {
        ...transportOwner["config"],
        providerType: update.providerType ?? transportOwner["config"].providerType,
        authType: update.authType ?? transportOwner["config"].authType,
        model: update.model,
        runtime: {
            ...previousRuntime,
            ...(update.runtime ?? {}),
        },
    };
    transportOwner["_model"] = update.model;
    transportOwner["adapter"].setCallLlmModel(update.model);
    if (!transportOwner["subprocess"]) {
        transportOwner["debug"](`Runtime config updated locally (no subprocess): ${previousModel} → ${update.model}`);
        return true;
    }
    const updated = await transportOwner["requestRuntimeConfigUpdate"]({
        ...update,
        providerType: transportOwner["config"].providerType,
        authType: transportOwner["config"].authType,
        runtime: getBackendRuntime(transportOwner["config"]),
    });
    transportOwner["debug"](`Runtime config refreshed in subprocess: ${previousModel} → ${update.model}`);
    return updated;
}
