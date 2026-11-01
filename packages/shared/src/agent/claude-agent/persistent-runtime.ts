import { randomUUID } from "node:crypto";
import { protectedClaudeQuery as query } from "../claude-process.ts";
import { type SDKMessage, type SDKUserMessage, type Options } from "@anthropic-ai/claude-agent-sdk";
import type { FileAttachment } from "../../utils/files.ts";
import { debug } from "../../utils/debug.ts";
import { createPushableInputStream } from "../backend/claude/persistent-input.ts";
import { clearPlanFileState, unregisterSessionScopedToolCallbacks, cleanupSessionScopedTools } from "../session-scoped-tools.ts";
import { cleanupModeState } from "../mode-manager.ts";
// Centralized PreToolUse pipeline
// Centralized PreToolUse pipeline
import { confirmContextualGmailRuntimeTeardown, invalidateContextualGmailSessionState } from "../core/pre-tool-use.ts";
// Documentation is served via local files at ~/.craft-agent/docs/
// Import and re-export AgentEvent from core (single source of truth)
// Documentation is served via local files at ~/.craft-agent/docs/
// Import and re-export AgentEvent from core (single source of truth)
import type { AgentEvent } from "@craft-agent/core/types";
import type { ClaudeAgent } from '../claude-agent.ts';
import type { SourceProxyGmailLifecycleContext } from './shared.ts';

/**
   * Tear down the persistent query. Idempotent, and the single funnel for ALL
   * teardown paths (dispose/destroy, auth-fail, recreate-on-change, clearHistory,
   * consumer exit). Guarantees no subprocess leak: ends the input, returns the
   * iterator, and — as a hard backstop — aborts the controller (SIGTERM/SIGKILL)
   * so the subprocess dies even if the graceful close is ignored.
   */
export function teardownPersistentQuery(transportOwner: ClaudeAgent, reason: string, runtimeTerminationAlreadyConfirmed: boolean): void {
    // A PreToolUse hook can be suspended while the host is showing a permission
    // prompt. Tearing down the SDK query without settling that promise leaves
    // the hook (and any reserved sensitive action) alive forever.
    transportOwner["denyAllPendingPermissions"]();
    transportOwner["revokeAdmittedToolExecutions"]();
    if (!transportOwner["persistentInput"] && !transportOwner["persistentIterator"] && !transportOwner["persistentAbortController"]) {
        return; // already torn down
    }
    const gmailRuntimeId = transportOwner["persistentGmailRuntimeId"];
    const gmailSessionId = transportOwner["persistentGmailSessionId"];
    const persistentIterator = transportOwner["persistentIterator"];
    const retiringGeneration = transportOwner["persistentQueryGeneration"];
    if (runtimeTerminationAlreadyConfirmed && gmailRuntimeId && gmailSessionId) {
        transportOwner["confirmContextualGmailRuntimeTeardown"]({
            sessionId: gmailSessionId,
            runtimeId: gmailRuntimeId,
        });
    }
    // Revoke the retiring consumer before requesting asynchronous iterator
    // closure. A replacement may start while return()/abort propagates, but the
    // old consumer can no longer observe the replacement's shared turn channel.
    transportOwner["persistentQueryGeneration"]++;
    if (transportOwner["persistentConsumerGeneration"] === retiringGeneration) {
        transportOwner["persistentConsumerGeneration"] = null;
    }
    debug(`[bg-lifecycle] teardownPersistentQuery (${reason})`, { sessionId: transportOwner["config"].session?.id });
    try {
        transportOwner["persistentInput"]?.end();
    }
    catch { /* already ended */ }
    try {
        // Request closure, but never treat return() itself as proof that the
        // consumer or subprocess actually stopped. Its exact finally below is
        // the sole asynchronous teardown authority.
        const iteratorClose = persistentIterator?.return?.(undefined);
        if (iteratorClose)
            void Promise.resolve(iteratorClose).catch(() => undefined);
    }
    catch {
        // The AbortController below remains the hard backstop. The consumer's
        // own finally confirms teardown only once its iterator really exits.
    }
    try {
        transportOwner["persistentAbortController"]?.abort();
    }
    catch { /* best-effort hard backstop */ }
    try {
        transportOwner["activeTurnChannel"]?.end();
    }
    catch { /* best-effort */ }
    transportOwner["persistentInput"] = null;
    transportOwner["persistentIterator"] = null;
    transportOwner["persistentAbortController"] = null;
    transportOwner["persistentGmailRuntimeId"] = null;
    transportOwner["persistentGmailSessionId"] = null;
    transportOwner["activeTurnChannel"] = null;
}

/**
   * Begin a turn in persistent streaming-input mode. First call builds the one
   * long-lived query (with this turn's resume/fork options) + starts the single
   * consumer; later calls reuse it. Always sets up a fresh per-turn channel and
   * pushes the user message. Returns the channel stream for chatImpl to drain —
   * ending that channel at `result` completes the turn WITHOUT closing the real
   * query (the subprocess, and its background sub-agents, stay alive).
   */
export function beginPersistentTurn(transportOwner: ClaudeAgent, prompt: SDKUserMessage, options: Options, gmailLifecycle: SourceProxyGmailLifecycleContext): AsyncIterable<SDKMessage> {
    if (!transportOwner["persistentInput"] || !transportOwner["currentQuery"]) {
        // First turn: create the persistent query + consumer.
        transportOwner["persistentQueryGeneration"]++;
        transportOwner["persistentGmailRuntimeId"] = gmailLifecycle.runtimeId;
        transportOwner["persistentGmailSessionId"] = gmailLifecycle.sessionId;
        transportOwner["persistentInput"] = createPushableInputStream<SDKUserMessage>();
        transportOwner["persistentAbortController"] = transportOwner["currentQueryAbortController"];
        transportOwner["currentQuery"] = query({ prompt: transportOwner["persistentInput"].stream, options });
        transportOwner["persistentIterator"] = transportOwner["currentQuery"][Symbol.asyncIterator]();
        transportOwner["startPersistentConsumer"]();
    }
    else {
        // Subsequent turn: keep redirect()/forceAbort() targeting the LIVE query by
        // restoring its controller (the per-turn setup created a fresh, unused one).
        if (transportOwner["persistentAbortController"]) {
            transportOwner["currentQueryAbortController"] = transportOwner["persistentAbortController"];
        }
    }
    const channel = createPushableInputStream<SDKMessage>();
    transportOwner["activeTurnChannel"] = channel;
    transportOwner["persistentInput"].push(prompt, transportOwner["captureProviderHandoffAcknowledgement"]());
    return channel.stream;
}

/** Synchronous provider-dispatch constructor. A throw cannot have crossed an
   * async transport write, so it is the narrow correlated rejection boundary
   * paired with the host WAL. Iteration failures deliberately occur outside. */
export function createProviderTurnMessageSource(transportOwner: ClaudeAgent, effectiveUserMessage: string, attachments: FileAttachment[] | undefined, options: Options, gmailRuntimeContext: SourceProxyGmailLifecycleContext): AsyncIterable<SDKMessage> {
    const rejectExactPreProviderDispatch = transportOwner["captureProviderDispatchRejection"]();
    try {
        if (transportOwner["keepBackgroundTasksAlive"]) {
            const sdkMessage = transportOwner["buildSDKUserMessage"](effectiveUserMessage, attachments);
            return transportOwner["beginPersistentTurn"](sdkMessage, options, gmailRuntimeContext);
        }
        const sdkMessage = transportOwner["buildSDKUserMessage"](effectiveUserMessage, attachments);
        transportOwner["currentQuery"] = query({
            prompt: transportOwner["createOneShotProviderInput"](sdkMessage),
            options,
        });
        return transportOwner["currentQuery"];
    }
    catch (error) {
        rejectExactPreProviderDispatch();
        throw error;
    }
}

/**
   * Build a one-message SDK input whose acknowledgement fires only after the
   * SDK asks for the next item. Its streaming-input loop awaits
   * `transport.write(message)` before doing that, so a rejected first write
   * closes the iterator without falsely reporting handoff. This means accepted
   * by the Claude CLI runtime, not proven remote HTTP delivery; waiting for a
   * response frame instead could replay a request already sent without reply.
   */
export function createOneShotProviderInput(transportOwner: ClaudeAgent, prompt: SDKUserMessage): AsyncIterable<SDKUserMessage> {
    const input = createPushableInputStream<SDKUserMessage>();
    input.push(prompt, transportOwner["captureProviderHandoffAcknowledgement"]());
    input.end();
    return input.stream;
}

/**
   * The single always-on consumer — the SOLE caller of the persistent iterator's
   * `.next()` (so there is never a concurrent `.next()`). Routes each SDK message
   * to the active turn's channel; on that turn's `result` it ends the channel
   * (completing chatImpl's for-await without closing the query). Between turns it
   * forwards background task-completion events via `onBackgroundEvent`, and keeps
   * draining so the subprocess never stalls on pipe backpressure.
   */
export function startPersistentConsumer(transportOwner: ClaudeAgent): void {
    const iterator = transportOwner["persistentIterator"];
    const consumerGeneration = transportOwner["persistentQueryGeneration"];
    const gmailRuntimeId = transportOwner["persistentGmailRuntimeId"];
    const gmailSessionId = transportOwner["persistentGmailSessionId"];
    if (!iterator || transportOwner["persistentConsumerGeneration"] === consumerGeneration)
        return;
    transportOwner["persistentConsumerGeneration"] = consumerGeneration;
    void (async () => {
        let reportedStaleConsumer = false;
        try {
            while (true) {
                const next: IteratorResult<SDKMessage, unknown> = await iterator.next();
                if (next.done)
                    break;
                const value = next.value;
                const isCurrentConsumer = transportOwner["persistentIterator"] === iterator
                    && transportOwner["persistentQueryGeneration"] === consumerGeneration
                    && transportOwner["persistentGmailRuntimeId"] === gmailRuntimeId
                    && transportOwner["persistentGmailSessionId"] === gmailSessionId;
                if (!isCurrentConsumer) {
                    // teardownPersistentQuery() may need time to close the SDK iterator.
                    // Keep draining it until a real terminal signal, but never let a
                    // buffered old-generation event reach or close the new turn channel.
                    if (!reportedStaleConsumer) {
                        reportedStaleConsumer = true;
                        transportOwner["debug"](`[bg-lifecycle] dropping events from retired persistent generation ${consumerGeneration}`);
                    }
                    continue;
                }
                const channel = transportOwner["activeTurnChannel"];
                if (channel) {
                    channel.push(value);
                    const type = (value as {
                        type?: string;
                    } | undefined)?.type;
                    if (type === 'result') {
                        // Turn boundary: detach + end the channel so chatImpl's for-await
                        // completes. Do NOT touch the real iterator — the query lives on.
                        transportOwner["activeTurnChannel"] = null;
                        channel.end();
                    }
                }
                else {
                    transportOwner["routeBackgroundMessage"](value);
                }
            }
        }
        catch (err) {
            transportOwner["debug"](`[bg-lifecycle] persistent consumer error: ${err instanceof Error ? err.message : String(err)}`);
        }
        finally {
            if (transportOwner["persistentConsumerGeneration"] === consumerGeneration) {
                transportOwner["persistentConsumerGeneration"] = null;
            }
            // An older consumer may finish after forceAbort already created a new
            // persistent generation. Never let that late exit tear down or clear
            // the replacement runtime.
            if (transportOwner["persistentIterator"] === iterator
                && transportOwner["persistentQueryGeneration"] === consumerGeneration) {
                // Reaching this consumer's finally is direct proof that its exact
                // iterator stopped. Confirm that captured runtime here rather than
                // relying on optional iterator.return(), which may be absent or throw.
                transportOwner["teardownPersistentQuery"]('consumer-exit', true);
            }
            else if (gmailRuntimeId && gmailSessionId) {
                transportOwner["confirmContextualGmailRuntimeTeardown"]({
                    sessionId: gmailSessionId,
                    runtimeId: gmailRuntimeId,
                });
            }
        }
    })();
}

/**
   * Convert a between-turns background SDK message to an AgentEvent and emit it
   * via `onBackgroundEvent`. Only terminal task notifications are forwarded (the
   * important signal — completion/failure); progress ticks between turns are
   * cosmetic (the UI derives elapsed from startTime). Standalone mapper so it
   * doesn't disturb the turn-scoped event adapter. Mirrors event-adapter.ts:544.
   */
export function routeBackgroundMessage(transportOwner: ClaudeAgent, message: SDKMessage): void {
    const msg = message as {
        type?: string;
        subtype?: string;
        task_id?: string;
        status?: string;
        output_file?: string;
        summary?: string;
    };
    if (msg?.type === 'system' && msg.subtype === 'task_notification' && msg.task_id) {
        const status: 'completed' | 'failed' | 'stopped' = msg.status === 'failed' || msg.status === 'stopped' ? msg.status : 'completed';
        transportOwner["onBackgroundEvent"]?.({
            type: 'task_completed',
            taskId: msg.task_id,
            status,
            ...(msg.output_file ? { outputFile: msg.output_file } : {}),
            ...(msg.summary ? { summary: msg.summary } : {}),
        });
    }
    else {
        transportOwner["debug"](`[bg-lifecycle] dropping unexpected between-turns message: ${msg?.type}/${msg?.subtype ?? ''}`);
    }
}

/** Globally unique across overlapping agent instances and SDK processes. */
export function createGmailRuntimeId(_transportOwner: ClaudeAgent, sessionId: string): string {
    return `${sessionId}:claude:${randomUUID()}`;
}

/** Narrow seam for exact runtime teardown tests and generation correlation. */
export function confirmContextualGmailRuntimeTeardownOperation(_transportOwner: ClaudeAgent, runtime: Parameters<typeof confirmContextualGmailRuntimeTeardown>[0]): boolean {
    return confirmContextualGmailRuntimeTeardown(runtime);
}

/** Wire the between-turns background-event sink (SessionManager forwards to registry/renderer). */
export function setBackgroundEventSink(transportOwner: ClaudeAgent, sink: ((event: AgentEvent) => void) | null): void {
    transportOwner["onBackgroundEvent"] = sink;
}

export function getSessionId(transportOwner: ClaudeAgent): string | null {
    return transportOwner["sessionId"];
}

export function setSessionId(transportOwner: ClaudeAgent, sessionId: string | null): void {
    transportOwner["sessionId"] = sessionId;
}

export function destroyClaudeRuntime(transportOwner: ClaudeAgent): void {
    const configSessionId = transportOwner["config"].session?.id;
    if (configSessionId) {
        // Invalidate before signalling the SDK process so a delayed source-proxy
        // callback cannot cross the host boundary during teardown.
        invalidateContextualGmailSessionState(configSessionId);
    }
    // Claude-specific cleanup first
    transportOwner["currentQueryAbortController"]?.abort();
    // WS2: tear down the persistent streaming-input query (if any) so no
    // subprocess/background sub-agents leak past the agent's lifetime.
    transportOwner["teardownPersistentQuery"]('destroy');
    transportOwner["denyAllPendingPermissions"]();
    // Clear pinned system prompt state
    transportOwner["pinnedPreferencesPrompt"] = null;
    transportOwner["pinnedIncludeCoAuthoredBy"] = null;
    transportOwner["pinnedProjectContext"] = null;
    transportOwner.preferencesDriftNotified = false;
    // Clear Claude-specific callbacks (not handled by BaseAgent)
    transportOwner["onSourcesListChange"] = null;
    transportOwner["onConfigValidationError"] = null;
    transportOwner["onUsageUpdate"] = null;
    // Clean up session-specific state
    if (configSessionId) {
        clearPlanFileState(configSessionId);
        unregisterSessionScopedToolCallbacks(configSessionId);
        cleanupSessionScopedTools(configSessionId);
        cleanupModeState(configSessionId);
    }
    // Clear session
    transportOwner["sessionId"] = null;
}

export function clearClaudeHistoryState(transportOwner: ClaudeAgent): void {
    transportOwner["revokeAdmittedToolExecutions"]();
    transportOwner["denyAllPendingPermissions"]();
    const configSessionId = transportOwner["config"].session?.id;
    if (configSessionId)
        invalidateContextualGmailSessionState(configSessionId);
    transportOwner["teardownPersistentQuery"]('clear-history');
    // Clear session to start fresh conversation
    transportOwner["sessionId"] = null;
    // Clear pinned state so next chat() will capture fresh values
    transportOwner["pinnedPreferencesPrompt"] = null;
    transportOwner["pinnedIncludeCoAuthoredBy"] = null;
    transportOwner["pinnedProjectContext"] = null;
    transportOwner.preferencesDriftNotified = false;
}
