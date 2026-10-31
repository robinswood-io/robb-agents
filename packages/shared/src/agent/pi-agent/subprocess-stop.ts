/**
 * Pi Backend (Subprocess RPC Client)
 *
 * Thin subprocess client for the Pi coding agent. Spawns a pi-agent-server
 * subprocess and communicates via JSONL over stdin/stdout.
 *
 * The subprocess runs the Pi SDK (@earendil-works/pi-coding-agent) in-process,
 * handles tool wrapping, permission enforcement, and LLM queries.
 * This file manages subprocess lifecycle, JSONL protocol, event forwarding,
 * and proxy tool routing for MCP/API sources.
 *
 * Auth is API key based. Keys are retrieved from the credential manager
 * and passed to the subprocess during initialization.
 */
import { type ChildProcess } from "node:child_process";
import type { PiAgent } from '../pi-agent.ts';
import { RUNTIME_DIAGNOSTIC_MAX_CHARS, PiRuntimeInterruptedError } from './shared.ts';
import type { PiSubprocessRuntimeContext, PiRuntimeInterruptionCode } from './shared.ts';

export function handleSubprocessError(transportOwner: PiAgent, error: Error, child: ChildProcess, _runtimeContext?: PiSubprocessRuntimeContext): void {
    if (transportOwner["subprocess"] !== child) {
        transportOwner["debug"](`Ignoring error from stale Pi subprocess: ${error.message}`);
        return;
    }
    // A process-level error is not proof that the child exited. Retain both the
    // child and its runtime identity until exit/close confirms termination, so
    // exact-once authority is neither released early nor orphaned forever.
    transportOwner.subprocessErrorsAwaitingExit.set(child, error);
    transportOwner["debug"](`Pi subprocess error while awaiting confirmed termination: ${error.message}`);
    transportOwner.rejectSubprocessReady(new PiRuntimeInterruptedError(`Pi subprocess error (${error.message})`, 'process_error'));
}

export function handleSubprocessExit(transportOwner: PiAgent, code: number | null, signal: string | null, child?: ChildProcess, processError?: Error, runtimeContext?: PiSubprocessRuntimeContext): void {
    if (child) {
        const forceKillTimer = transportOwner.subprocessForceKillTimers.get(child);
        if (forceKillTimer)
            clearTimeout(forceKillTimer);
        transportOwner.subprocessForceKillTimers.delete(child);
    }
    const exitingRuntime = runtimeContext
        ?? (child ? transportOwner.subprocessRuntimeContexts.get(child) : undefined);
    const confirmedProcessError = processError
        ?? (child ? transportOwner.subprocessErrorsAwaitingExit.get(child) : undefined);
    if (child)
        transportOwner.subprocessErrorsAwaitingExit.delete(child);
    // A terminated generation may emit its exit after its replacement is
    // already live. Never let that late event tear down the new generation.
    if (child && transportOwner["subprocess"] !== child) {
        transportOwner.expectedSubprocessExits.delete(child);
        if (exitingRuntime) {
            transportOwner.confirmContextualGmailRuntimeTeardown(exitingRuntime);
        }
        transportOwner["debug"]('Ignoring termination from stale Pi subprocess generation');
        return;
    }
    transportOwner["revokeAdmittedToolExecutions"]();
    transportOwner["debug"](confirmedProcessError
        ? `Pi subprocess error followed by confirmed exit: ${confirmedProcessError.message}`
        : `Pi subprocess exited: code=${code}, signal=${signal}`);
    const expectedExit = child ? transportOwner.expectedSubprocessExits.delete(child) : false;
    const hadPendingWork = transportOwner.hasPendingSubprocessWork();
    const interruptionCode: PiRuntimeInterruptionCode = confirmedProcessError
        ? 'process_error'
        : 'process_exit';
    const exitReason = confirmedProcessError?.message
        ?? (signal ? `signal ${signal}` : `code ${code}`);
    const interruptionError = new PiRuntimeInterruptedError(`Pi subprocess exited unexpectedly (${exitReason})`, interruptionCode);
    transportOwner.rejectSubprocessReady(interruptionError);
    // A signal-only idle exit can come from the long-running-process idle
    // supervisor. Treat it as a failure only when work was active; explicit
    // non-zero exit codes remain failures even while idle.
    if (!expectedExit && (hadPendingWork || (code !== null && code !== 0))) {
        // The normal debug callback is intentionally low-volume in production.
        // Prefix unexpected exits with a structured marker so SessionManager can
        // persist one bounded, redacted diagnostic at error level instead of
        // losing the only useful stderr evidence with this in-memory ring buffer.
        const stderrTail = transportOwner["getRecentStderr"]().trim().slice(-RUNTIME_DIAGNOSTIC_MAX_CHARS);
        transportOwner["debug"](`__RUNTIME_ERROR__${JSON.stringify({
            kind: 'pi_subprocess_exit',
            code,
            signal,
            ...(stderrTail ? { stderrTail } : {}),
        })}`);
    }
    transportOwner["subprocess"] = null;
    if (!runtimeContext
        || transportOwner["subprocessRuntimeContext"]?.runtimeId === runtimeContext.runtimeId) {
        transportOwner["subprocessRuntimeContext"] = null;
    }
    transportOwner.subprocessSupervisorHandle = null;
    transportOwner.readline = null;
    transportOwner.resetSubprocessErrorDedup();
    transportOwner.subprocessReady = null;
    transportOwner.subprocessReadyResolve = null;
    transportOwner.subprocessReadyReject = null;
    // Runtime loss is progress interruption, not a terminal provider error.
    // SessionManager owns the durable retry budget and process recreation.
    if (transportOwner["_isProcessing"] && !expectedExit) {
        transportOwner["eventQueue"].enqueue({
            type: 'runtime_interrupted',
            message: interruptionError.message,
            code: interruptionCode,
            exitCode: code,
            signal,
        });
        transportOwner["eventQueue"].complete();
    }
    // Reject pending mini completions with error (not null) so callers
    // get a meaningful error instead of silently returning "no response"
    for (const [, pending] of transportOwner.pendingMiniCompletions) {
        pending.reject(new Error(`Pi subprocess exited unexpectedly (${exitReason})`));
    }
    transportOwner.pendingMiniCompletions.clear();
    // Reject pending llm_query calls (call_llm in-flight during subprocess crash)
    for (const [, pending] of transportOwner.pendingLlmQueries) {
        pending.reject(new Error(`Pi subprocess exited unexpectedly (${exitReason})`));
    }
    transportOwner.pendingLlmQueries.clear();
    // A dead runtime can never acknowledge any prompt that it owned.
    transportOwner.pendingProviderHandoffs.clear();
    transportOwner.pendingProviderDispatchRejections.clear();
    // Reject pending ensure_session_ready requests
    for (const [, pending] of transportOwner.pendingEnsureSessionReady) {
        pending.reject(new Error(`Pi subprocess exited unexpectedly (${exitReason})`));
    }
    transportOwner.pendingEnsureSessionReady.clear();
    // Reject pending compact/toggle requests
    for (const [, pending] of transportOwner.pendingCompactions) {
        pending.reject(new Error(`Pi subprocess exited unexpectedly (${exitReason})`));
    }
    transportOwner.pendingCompactions.clear();
    for (const [, pending] of transportOwner.pendingAutoCompactionToggles) {
        pending.reject(new Error(`Pi subprocess exited unexpectedly (${exitReason})`));
    }
    transportOwner.pendingAutoCompactionToggles.clear();
    for (const [, pending] of transportOwner.pendingRuntimeConfigUpdates) {
        pending.reject(new Error(`Pi subprocess exited unexpectedly (${exitReason})`));
    }
    transportOwner.pendingRuntimeConfigUpdates.clear();
    // Reject all pending tool executions
    for (const [, pending] of transportOwner.pendingToolExecutions) {
        pending.reject(new Error('Pi subprocess exited'));
    }
    transportOwner.pendingToolExecutions.clear();
    // A permission prompt suspends handlePreToolUsePrompt. Runtime loss must
    // settle it fail-closed or the request and any sensitive-action reservation
    // remain live forever.
    transportOwner.denyAllPendingPermissions();
    // Drop any cached pre-tool metadata for the dead subprocess.
    transportOwner["preToolMetadataByCallId"].clear();
    transportOwner["adapter"].resetRuntimeState();
    if (exitingRuntime) {
        transportOwner.confirmContextualGmailRuntimeTeardown(exitingRuntime);
    }
}

/**
   * Gracefully stop the subprocess and wait briefly for the child to exit.
   * Used before an idle runtime restart so we don't leave transient children behind.
   */
export async function killSubprocessGracefully(transportOwner: PiAgent, timeoutMs: number): Promise<void> {
    transportOwner.denyAllPendingPermissions();
    transportOwner.invalidateContextualGmailStateForCurrentSession();
    const child = transportOwner["subprocess"];
    if (!child) {
        transportOwner["killSubprocess"]();
        return;
    }
    const runtimeContext = transportOwner["subprocessRuntimeContext"] ?? transportOwner.subprocessRuntimeContexts.get(child);
    transportOwner.expectedSubprocessExits.add(child);
    const pid = child.pid;
    const waitForExit = new Promise<{
        code: number | null;
        signal: string | null;
    }>((resolve) => {
        if (child.exitCode !== null || child.signalCode) {
            resolve({ code: child.exitCode, signal: child.signalCode });
            return;
        }
        child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    try {
        transportOwner["send"]({ type: 'shutdown' });
    }
    catch {
        // stdin may already be closed
    }
    if (transportOwner.subprocessSupervisorHandle) {
        transportOwner.subprocessSupervisorHandle.terminate('Pi agent graceful shutdown');
    }
    else {
        child.kill('SIGTERM');
    }
    let result = await Promise.race([
        waitForExit,
        new Promise<null>(resolve => setTimeout(() => resolve(null), timeoutMs)),
    ]);
    if (!result && transportOwner["subprocess"] === child) {
        transportOwner["debug"](`Pi subprocess ${pid ?? '(unknown pid)'} did not exit after ${timeoutMs}ms; sending SIGKILL`);
        child.kill('SIGKILL');
        result = await Promise.race([
            waitForExit,
            new Promise<null>(resolve => setTimeout(() => resolve(null), 1000)),
        ]);
    }
    if (transportOwner.readline) {
        transportOwner.readline.close();
        transportOwner.readline = null;
    }
    if (transportOwner["subprocess"] === child) {
        transportOwner["subprocess"] = null;
        if (!runtimeContext
            || transportOwner["subprocessRuntimeContext"]?.runtimeId === runtimeContext.runtimeId) {
            transportOwner["subprocessRuntimeContext"] = null;
        }
    }
    transportOwner.subprocessSupervisorHandle = null;
    transportOwner.subprocessReady = null;
    transportOwner.subprocessReadyResolve = null;
    transportOwner.subprocessReadyReject = null;
    transportOwner.clearSubprocessReadyTimer();
    transportOwner["preToolMetadataByCallId"].clear();
    transportOwner["adapter"].resetRuntimeState();
    if (result && runtimeContext) {
        transportOwner.confirmContextualGmailRuntimeTeardown(runtimeContext);
    }
    if (result) {
        transportOwner["debug"](`Pi subprocess ${pid ?? '(unknown pid)'} stopped for restart: code=${result.code}, signal=${result.signal}`);
    }
    else {
        transportOwner["debug"](`Pi subprocess ${pid ?? '(unknown pid)'} stop timed out after SIGKILL`);
    }
}

/**
   * Escalate an owner-requested stop without ever targeting a replacement
   * generation. Exact-once Gmail state remains locked until exit/close invokes
   * handleSubprocessExit and confirms teardown for this same runtime.
   */
export function scheduleSubprocessForceKill(transportOwner: PiAgent, child: ChildProcess, delayMs: number, runtimeContext?: PiSubprocessRuntimeContext): void {
    if (transportOwner.subprocessForceKillTimers.has(child))
        return;
    const expectedRuntimeId = runtimeContext?.runtimeId
        ?? transportOwner.subprocessRuntimeContexts.get(child)?.runtimeId;
    const timer = setTimeout(() => {
        transportOwner.subprocessForceKillTimers.delete(child);
        if (!transportOwner.expectedSubprocessExits.has(child)
            || child.exitCode !== null
            || child.signalCode !== null)
            return;
        const registeredRuntimeId = transportOwner.subprocessRuntimeContexts.get(child)?.runtimeId;
        if (expectedRuntimeId && registeredRuntimeId !== expectedRuntimeId) {
            transportOwner["debug"](`Skipping SIGKILL for Pi subprocess ${child.pid ?? '(unknown pid)'} after runtime correlation changed`);
            return;
        }
        transportOwner["debug"](`Pi subprocess ${child.pid ?? '(unknown pid)'} ignored SIGTERM; sending SIGKILL`);
        try {
            child.kill('SIGKILL');
        }
        catch { /* exit/close remains the teardown authority */ }
    }, Math.max(0, delayMs));
    timer.unref?.();
    transportOwner.subprocessForceKillTimers.set(child, timer);
}

/**
   * Kill the subprocess and clean up resources.
   */
export function killSubprocess(transportOwner: PiAgent): void {
    transportOwner["revokeAdmittedToolExecutions"]();
    transportOwner.denyAllPendingPermissions();
    transportOwner.invalidateContextualGmailStateForCurrentSession();
    if (transportOwner.readline) {
        transportOwner.readline.close();
        transportOwner.readline = null;
    }
    if (transportOwner["subprocess"]) {
        const child = transportOwner["subprocess"];
        transportOwner.expectedSubprocessExits.add(child);
        // Try graceful shutdown first
        try {
            transportOwner["send"]({ type: 'shutdown' });
        }
        catch {
            // stdin may already be closed
        }
        if (transportOwner.subprocessSupervisorHandle) {
            transportOwner.subprocessSupervisorHandle.terminate('Pi agent reset');
        }
        else {
            child.kill('SIGTERM');
        }
        transportOwner.scheduleSubprocessForceKill(child, transportOwner["subprocessRuntimeContext"] ?? transportOwner.subprocessRuntimeContexts.get(child));
        transportOwner["subprocess"] = null;
        if (transportOwner["subprocessRuntimeContext"]?.runtimeId
            === transportOwner.subprocessRuntimeContexts.get(child)?.runtimeId) {
            transportOwner["subprocessRuntimeContext"] = null;
        }
    }
    else {
        transportOwner["subprocessRuntimeContext"] = null;
    }
    transportOwner.subprocessSupervisorHandle = null;
    transportOwner.subprocessReady = null;
    transportOwner.subprocessReadyResolve = null;
    transportOwner.subprocessReadyReject = null;
    transportOwner.clearSubprocessReadyTimer();
    transportOwner["preToolMetadataByCallId"].clear();
    // Clear any in-flight overflow-recovery state so a stale fallback timer
    // doesn't fire on a torn-down adapter.
    transportOwner["adapter"].resetRuntimeState();
}
