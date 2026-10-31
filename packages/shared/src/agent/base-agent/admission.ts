import { SESSION_TOOL_REGISTRY } from "@craft-agent/session-tools-core";
import { canonicalTerminalReconciliationToolInput, stripToolMetadata } from "../core/pre-tool-use.ts";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canonicalAdmittedToolInput(toolName: string, toolInput: Record<string, unknown>): string | undefined {
    const sessionMatch = /^(?:mcp__session__|session__)(.+)$/u.exec(toolName);
    const baseToolName = sessionMatch?.[1];
    if (baseToolName) {
        const def = SESSION_TOOL_REGISTRY.get(baseToolName);
        if (def?.inputSchema) {
            const stripped = stripToolMetadata(toolName, toolInput).input;
            const parsed = def.inputSchema.safeParse(stripped);
            if (parsed.success && isPlainRecord(parsed.data)) {
                return canonicalTerminalReconciliationToolInput(parsed.data);
            }
        }
    }
    return canonicalTerminalReconciliationToolInput(toolInput);
}
import type { BaseAgent } from '../base-agent.ts';
import type { BaseAgentPendingSourceActivationRestart, BaseAgentAdmitToolExecutionInputPayload, BaseAgentBeginAdmittedToolExecutionBySignatureInputPayload } from './protocol.ts';

export function setPendingSourceActivationRestart(transportOwner: BaseAgent, pending: BaseAgentPendingSourceActivationRestart): void {
    // First-writer-wins under parallel `mcp__session__source_test` calls. The
    // overwrite race itself is harmless (each activation runs independently and
    // succeeds), but the surviving slug is what the renderer displays in the
    // "[{slug} activated]" suffix on the auto-resend. Keeping the first writer
    // gives a stable user-facing label without forcing all source_tests to
    // serialize. See #790.
    if (transportOwner["_pendingSourceActivationRestart"]) {
        transportOwner["debug"](`source-activation restart already pending (${transportOwner["_pendingSourceActivationRestart"].sourceSlug}); ignoring overlapping activation of "${pending.sourceSlug}"`);
        return;
    }
    transportOwner["_pendingSourceActivationRestart"] = pending;
}

export function consumePendingSourceActivationRestart(transportOwner: BaseAgent): BaseAgentPendingSourceActivationRestart | null {
    const pending = transportOwner["_pendingSourceActivationRestart"];
    transportOwner["_pendingSourceActivationRestart"] = null;
    return pending;
}

export function getCurrentTurnUserMessage(transportOwner: BaseAgent): string | null {
    return transportOwner["_currentTurnUserMessage"];
}

export function setCurrentTurnUserMessage(transportOwner: BaseAgent, message: string | null): void {
    transportOwner["_currentTurnUserMessage"] = message;
}

/** Reserve an exact, non-serializable host admission before returning allow. */
export function admitToolExecution(transportOwner: BaseAgent, input: BaseAgentAdmitToolExecutionInputPayload): boolean {
    transportOwner["admittedToolExecutions"] ??= new Map();
    if (!input.toolUseId || transportOwner["admittedToolExecutions"].has(input.toolUseId))
        return false;
    const inputJson = canonicalAdmittedToolInput(input.toolName, input.toolInput);
    if (inputJson === undefined)
        return false;
    transportOwner["admittedToolExecutions"].set(input.toolUseId, {
        toolName: input.toolName,
        inputJson,
        sessionId: input.sessionId,
        runtimeId: input.runtimeId,
        authorizationEpoch: input.authorizationEpoch,
        state: 'admitted',
    });
    return true;
}

/** Atomically claim an exact Pi proxy admission at the execution boundary. */
export function beginAdmittedToolExecution(transportOwner: BaseAgent, input: BaseAgentAdmitToolExecutionInputPayload): boolean {
    transportOwner["admittedToolExecutions"] ??= new Map();
    if (!input.toolUseId)
        return false;
    const admission = transportOwner["admittedToolExecutions"].get(input.toolUseId);
    const inputJson = canonicalAdmittedToolInput(input.toolName, input.toolInput);
    if (!admission || admission.state !== 'admitted' || inputJson === undefined
        || admission.toolName !== input.toolName || admission.inputJson !== inputJson
        || admission.sessionId !== input.sessionId || admission.runtimeId !== input.runtimeId
        || admission.authorizationEpoch !== input.authorizationEpoch) {
        transportOwner["admittedToolExecutions"].delete(input.toolUseId);
        return false;
    }
    admission.state = 'executing';
    return true;
}

/**
   * Claude's in-process MCP callbacks do not receive the SDK tool_use_id.
   * Claim only when the exact runtime/name/input tuple identifies one and only
   * one admission; identical parallel calls stay fail-closed as ambiguous.
   */
export function beginAdmittedToolExecutionBySignature(transportOwner: BaseAgent, input: BaseAgentBeginAdmittedToolExecutionBySignatureInputPayload): string | undefined {
    transportOwner["admittedToolExecutions"] ??= new Map();
    const inputJson = canonicalAdmittedToolInput(input.toolName, input.toolInput);
    if (inputJson === undefined)
        return undefined;
    const matches = [...transportOwner["admittedToolExecutions"].entries()].filter(([, admission]) => (admission.state === 'admitted'
        && admission.toolName === input.toolName
        && admission.inputJson === inputJson
        && admission.sessionId === input.sessionId
        && admission.runtimeId === input.runtimeId
        && admission.authorizationEpoch === input.authorizationEpoch));
    if (matches.length !== 1)
        return undefined;
    matches[0]![1].state = 'executing';
    return matches[0]![0];
}

export function settleAdmittedToolExecution(transportOwner: BaseAgent, toolUseId: string | undefined): void {
    if (toolUseId)
        transportOwner["admittedToolExecutions"]?.delete(toolUseId);
}

export function revokeAdmittedToolExecutions(transportOwner: BaseAgent): void {
    transportOwner["admittedToolExecutions"]?.clear();
}

export function hasAdmittedToolExecutions(transportOwner: BaseAgent): boolean {
    return (transportOwner["admittedToolExecutions"]?.size ?? 0) > 0;
}

/** Fsync the host's exact non-replay fence before a provider-visible write. */
export async function awaitProviderDispatchWriteAhead(transportOwner: BaseAgent): Promise<void> {
    await transportOwner["onBeforeProviderDispatch"]?.();
}

/** Await the durable fence, then invoke the provider-visible write inline. */
export async function performProviderDispatchWriteAhead<T>(transportOwner: BaseAgent, dispatch: () => T): Promise<T> {
    await transportOwner["awaitProviderDispatchWriteAhead"]();
    return dispatch();
}

/** Capture rejection proof for the exact prompt being prepared. */
export function captureProviderDispatchRejection(transportOwner: BaseAgent): () => void {
    const callback = transportOwner["onProviderDispatchRejected"];
    let rejected = false;
    return () => {
        if (rejected)
            return;
        rejected = true;
        transportOwner["invokeProviderHandoff"](callback);
    };
}

/**
   * Report the backend runtime's non-replay boundary to the session host.
   *
   * Backends call this only after their strongest available query/prompt
   * acknowledgement. Callback failures must not turn accepted work into an
   * apparent pre-provider setup failure (which could duplicate that work).
   */
export function invokeProviderHandoff(transportOwner: BaseAgent, callback: (() => void) | null): void {
    try {
        callback?.();
    }
    catch (error) {
        transportOwner["debug"](`Provider handoff callback failed: ${error instanceof Error ? error.message : String(error)}`);
    }
}

/** Capture the callback belonging to one exact prompt and acknowledge it once. */
export function captureProviderHandoffAcknowledgement(transportOwner: BaseAgent): () => void {
    const callback = transportOwner["onProviderHandoff"];
    let acknowledged = false;
    return () => {
        if (acknowledged)
            return;
        acknowledged = true;
        transportOwner["invokeProviderHandoff"](callback);
    };
}

/** Capture the conservative host-to-child dispatch fence for one prompt. */
export function captureProviderDispatchUncertainAcknowledgement(transportOwner: BaseAgent): () => void {
    const callback = transportOwner["onProviderDispatchUncertain"];
    let acknowledged = false;
    return () => {
        if (acknowledged)
            return;
        acknowledged = true;
        transportOwner["invokeProviderHandoff"](callback);
    };
}

/** Run a synchronous runtime dispatch and report it only after success. */
export function performProviderHandoff<T>(transportOwner: BaseAgent, dispatch: () => T): T {
    const acknowledge = transportOwner["captureProviderHandoffAcknowledgement"]();
    const result = dispatch();
    acknowledge();
    return result;
}
