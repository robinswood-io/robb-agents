import { AbortReason } from "../backend/types.ts";
import { getBackendRuntime } from "../backend/internal/driver-types.ts";
// Session-scoped tool callbacks (for SubmitPlan, source auth, etc.)
import { unregisterSessionScopedToolCallbacks } from "../session-scoped-tools.ts";
// Centralized PreToolUse pipeline
import { invalidateContextualGmailSessionState } from "../core/pre-tool-use.ts";
import type { PiAgent } from '../pi-agent.ts';

export async function abort(transportOwner: PiAgent, reason?: string): Promise<void> {
    const requiresRuntimeTeardown = transportOwner["hasContextualGmailInFlightForCurrentRuntime"]()
        || transportOwner["hasAdmittedToolExecutions"]();
    transportOwner["promptPreparationRevision"]++;
    transportOwner["revokeAdmittedToolExecutions"]();
    // Fire Stop hook event (fire-and-forget)
    transportOwner["emitAutomationEvent"]('Stop', { hook_event_name: 'Stop' });
    // Deny all pending permissions
    transportOwner["denyAllPendingPermissions"]();
    transportOwner["invalidateContextualGmailStateForCurrentSession"]();
    // A plain SDK abort leaves the subprocess able to emit a delayed proxy
    // request. An admitted Gmail mutation therefore requires confirmed process
    // teardown before its not-yet-started reservation can be released.
    if (requiresRuntimeTeardown) {
        await transportOwner["killSubprocessGracefully"]();
    }
    else {
        transportOwner["send"]({ type: 'abort' });
    }
    transportOwner["eventQueue"].complete();
    // Clear bridge cache for this interrupted turn.
    transportOwner["preToolMetadataByCallId"].clear();
}

export function forceAbort(transportOwner: PiAgent, reason: AbortReason): void {
    const requiresRuntimeTeardown = transportOwner["hasContextualGmailInFlightForCurrentRuntime"]()
        || transportOwner["hasAdmittedToolExecutions"]();
    transportOwner["promptPreparationRevision"]++;
    transportOwner["revokeAdmittedToolExecutions"]();
    // Fire Stop hook event (fire-and-forget)
    transportOwner["emitAutomationEvent"]('Stop', { hook_event_name: 'Stop' });
    transportOwner["abortReason"] = reason;
    transportOwner["_isProcessing"] = false;
    // Reject all pending permissions
    transportOwner["denyAllPendingPermissions"]();
    transportOwner["invalidateContextualGmailStateForCurrentSession"]();
    // Reject all pending tool executions
    for (const [, pending] of transportOwner["pendingToolExecutions"]) {
        pending.reject(new Error(`Force aborted: ${reason}`));
    }
    transportOwner["pendingToolExecutions"].clear();
    // Signal turn complete to wake up any waiting consumers
    transportOwner["eventQueue"].complete();
    // Clear bridge cache for aborted turn.
    transportOwner["preToolMetadataByCallId"].clear();
    if (requiresRuntimeTeardown) {
        transportOwner["killSubprocess"]();
        return;
    }
    // For PlanSubmitted and AuthRequest, just interrupt the turn
    if (reason === AbortReason.PlanSubmitted || reason === AbortReason.AuthRequest) {
        return;
    }
    // For other reasons, send abort to subprocess
    transportOwner["send"]({ type: 'abort' });
}

export function redirect(transportOwner: PiAgent, message: string): boolean {
    if ((transportOwner["pendingPermissions"]?.size ?? 0) > 0 || transportOwner["hasAdmittedToolExecutions"]()) {
        transportOwner["forceAbort"](AbortReason.Redirect);
        return false;
    }
    // Vibe and Antigravity cannot deliver an authenticated mid-stream steer.
    // Tear down the old turn before returning false so SessionManager can keep
    // the complete replacement instruction in its durable queue.
    if (['mistral-vibe', 'google-antigravity'].includes(getBackendRuntime(transportOwner["config"]).piAuthProvider ?? '')) {
        transportOwner["forceAbort"](AbortReason.Redirect);
        return false;
    }
    if (!transportOwner["_isProcessing"] || !transportOwner["subprocess"]) {
        // Not streaming or no subprocess — fall back to abort
        transportOwner["forceAbort"](AbortReason.Redirect);
        return false;
    }
    transportOwner["debug"](`Steering mid-stream: "${message.slice(0, 100)}"`);
    transportOwner["promptPreparationRevision"]++;
    if (!transportOwner["send"]({ type: 'steer', message })) {
        // A rejected stdin write is not a delivered steer. Stop the old runtime
        // before returning false so the host can durably replay this instruction.
        transportOwner["forceAbort"](AbortReason.Redirect);
        return false;
    }
    // Pi skips the model's remaining queued tools before continuing from this
    // steer. Bind subsequent PreToolUse authority to the accepted steer text.
    transportOwner["setCurrentTurnUserMessage"](message);
    return true;
}

export function destroy(transportOwner: PiAgent): void {
    transportOwner["stopConfigWatcher"]();
    // Unregister session-scoped tool callbacks
    if (transportOwner["config"].session?.id) {
        invalidateContextualGmailSessionState(transportOwner["config"].session.id);
        unregisterSessionScopedToolCallbacks(transportOwner["config"].session.id);
    }
    transportOwner["_sessionToolContext"] = null;
    // Pool clients are owned by the main process — don't close them here.
    transportOwner["killSubprocess"]();
    transportOwner["debug"]('PiAgent destroyed');
}

export async function disposeForRestart(transportOwner: PiAgent): Promise<void> {
    transportOwner["stopConfigWatcher"]();
    if (transportOwner["config"].session?.id) {
        invalidateContextualGmailSessionState(transportOwner["config"].session.id);
        unregisterSessionScopedToolCallbacks(transportOwner["config"].session.id);
    }
    transportOwner["_sessionToolContext"] = null;
    await transportOwner["killSubprocessGracefully"]();
    transportOwner["debug"]('PiAgent disposed for restart');
}

export async function reconnect(transportOwner: PiAgent): Promise<void> {
    transportOwner["killSubprocess"]();
    transportOwner["debug"]('PiAgent reconnected (subprocess will be respawned on next chat)');
}
