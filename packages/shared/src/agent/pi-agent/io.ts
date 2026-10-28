import type { PiAgent } from '../pi-agent.ts';
import { redactRuntimeDiagnosticText } from './shared.ts';
import type { PiSubprocessRuntimeContext } from './shared.ts';

export function resetSubprocessErrorDedup(transportOwner: PiAgent): void {
    transportOwner.lastSubprocessError = null;
    transportOwner.subprocessErrorRepeatCount = 0;
}

export function recordStderr(transportOwner: PiAgent, agentClass: typeof PiAgent, chunk: string): void {
    if (!chunk)
        return;
    // If a single chunk is larger than the cap, keep only its tail so the
    // buffer always holds the most-recent output even in pathological cases.
    const effective = chunk.length > agentClass.STDERR_BUFFER_MAX_BYTES
        ? chunk.slice(chunk.length - agentClass.STDERR_BUFFER_MAX_BYTES)
        : chunk;
    transportOwner.stderrBuffer.push(effective);
    transportOwner.stderrBufferBytes += effective.length;
    // Drop oldest chunks until we're back under the cap, but always keep at
    // least one entry so a single-chunk tail survives.
    while (transportOwner.stderrBufferBytes > agentClass.STDERR_BUFFER_MAX_BYTES && transportOwner.stderrBuffer.length > 1) {
        const dropped = transportOwner.stderrBuffer.shift()!;
        transportOwner.stderrBufferBytes -= dropped.length;
    }
}

export function getRecentStderr(transportOwner: PiAgent): string {
    return redactRuntimeDiagnosticText(transportOwner.stderrBuffer.join(''));
}

/**
   * Send a JSONL command to the subprocess stdin.
   */
export function send(transportOwner: PiAgent, cmd: Record<string, unknown>): boolean {
    if (!transportOwner["subprocess"]?.stdin?.writable) {
        transportOwner["debug"]('Cannot send to subprocess: stdin not writable');
        return false;
    }
    const line = JSON.stringify(cmd);
    transportOwner.subprocessSupervisorHandle?.touch();
    try {
        transportOwner["subprocess"].stdin.write(line + '\n');
        return true;
    }
    catch (error) {
        transportOwner["debug"](`Cannot send to subprocess: ${error instanceof Error ? error.message : String(error)}`);
        return false;
    }
}

/** Never deliver an older generation's delayed response to a replacement subprocess. */
export function sendForRuntime(transportOwner: PiAgent, cmd: Record<string, unknown>, runtimeContext?: PiSubprocessRuntimeContext): boolean {
    if (runtimeContext
        && transportOwner["subprocessRuntimeContext"]?.runtimeId !== runtimeContext.runtimeId) {
        transportOwner["debug"](`Dropping delayed Pi response for stale runtime ${runtimeContext.runtimeId}`);
        return false;
    }
    transportOwner["send"](cmd);
    return true;
}

export function isRuntimeCurrent(transportOwner: PiAgent, runtimeContext?: PiSubprocessRuntimeContext): boolean {
    return !runtimeContext
        || transportOwner["subprocessRuntimeContext"]?.runtimeId === runtimeContext.runtimeId;
}

/**
   * Handle subprocess exit.
   */
export function hasPendingSubprocessWork(transportOwner: PiAgent): boolean {
    return transportOwner["_isProcessing"] || transportOwner.pendingPermissions.size > 0
        || transportOwner.pendingMiniCompletions.size > 0
        || transportOwner.pendingLlmQueries.size > 0
        || transportOwner.pendingEnsureSessionReady.size > 0
        || transportOwner.pendingCompactions.size > 0
        || transportOwner.pendingAutoCompactionToggles.size > 0
        || transportOwner.pendingRuntimeConfigUpdates.size > 0
        || transportOwner.pendingToolExecutions.size > 0;
}

export function clearSubprocessReadyTimer(transportOwner: PiAgent): void {
    if (transportOwner.subprocessReadyTimer)
        clearTimeout(transportOwner.subprocessReadyTimer);
    transportOwner.subprocessReadyTimer = null;
}

export function resolveSubprocessReady(transportOwner: PiAgent): void {
    const resolve = transportOwner.subprocessReadyResolve;
    transportOwner.clearSubprocessReadyTimer();
    transportOwner.subprocessReadyResolve = null;
    transportOwner.subprocessReadyReject = null;
    resolve?.();
}

export function rejectSubprocessReady(transportOwner: PiAgent, error: Error): void {
    const reject = transportOwner.subprocessReadyReject;
    transportOwner.clearSubprocessReadyTimer();
    transportOwner.subprocessReadyResolve = null;
    transportOwner.subprocessReadyReject = null;
    reject?.(error);
}
