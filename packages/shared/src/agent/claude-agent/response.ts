import { type Options } from "@anthropic-ai/claude-agent-sdk";
// Plan types are used by UI components; not needed in craft-agent.ts since Safe Mode is user-controlled
// Plan types are used by UI components; not needed in craft-agent.ts since Safe Mode is user-controlled
import { parseError } from "../errors.ts";
import type { FileAttachment } from "../../utils/files.ts";
import { debug } from "../../utils/debug.ts";
import { guardLargeResult } from "../../utils/large-response.ts";
import { SourceActivationDrainController } from "../source-activation-drain.ts";
import { getSessionPath } from "../../sessions/storage.ts";
// Centralized PreToolUse pipeline
// Centralized PreToolUse pipeline
import { recordContextualGmailToolResult } from "../core/pre-tool-use.ts";
import { parseCompactCommand } from "../compact-command.ts";
import type { ChatOptions } from "../backend/types.ts";
// Documentation is served via local files at ~/.craft-agent/docs/
// Import and re-export AgentEvent from core (single source of truth)
// Documentation is served via local files at ~/.craft-agent/docs/
// Import and re-export AgentEvent from core (single source of truth)
import type { AgentEvent } from "@craft-agent/core/types";
// Import and re-export AbortReason and RecoveryMessage from core module (single source of truth)
// Re-exported for backwards compatibility with existing imports from claude-agent.ts
// Import and re-export AbortReason and RecoveryMessage from core module (single source of truth)
// Re-exported for backwards compatibility with existing imports from claude-agent.ts
import { AbortReason } from "../core/index.ts";
import type { ClaudeAgent } from '../claude-agent.ts';
import { CONVERTIBLE_FILE_HINTS } from './shared.ts';

export async function* chatImpl(transportOwner: ClaudeAgent, userMessage: string, attachments?: FileAttachment[], options?: ChatOptions): AsyncGenerator<AgentEvent> {
    // Extract options (ChatOptions interface from AgentBackend)
    const _isRetry = options?.isRetry ?? false;
    const preparationRevision = transportOwner["promptPreparationRevision"];
    transportOwner["revokeAdmittedToolExecutions"]();
    const sessionId = transportOwner["config"].session?.id || `temp-${Date.now()}`;
    const slashCommandRunsOutsidePersistentRuntime = parseCompactCommand(userMessage.trim()) !== null
        && !attachments?.length;
    const usesPersistentGmailRuntime = transportOwner["keepBackgroundTasksAlive"] && !slashCommandRunsOutsidePersistentRuntime;
    const gmailRuntimeId = usesPersistentGmailRuntime && transportOwner["persistentGmailRuntimeId"]
        ? transportOwner["persistentGmailRuntimeId"] : transportOwner["createGmailRuntimeId"](sessionId);
    const gmailRuntimeContext = { sessionId, runtimeId: gmailRuntimeId };
    transportOwner["activeTurnGmailRuntime"] = gmailRuntimeContext;
    try {
        const prepared = yield* transportOwner["prepareClaudeQueryRuntime"](userMessage, attachments, sessionId, _isRetry, gmailRuntimeId, gmailRuntimeContext);
        if (!prepared)
            return;
        const { resolvedCwd } = prepared;
        const options: Options = await transportOwner["buildClaudeQueryOptions"](sessionId, gmailRuntimeId, _isRetry, prepared);
        // Capture the binary path the SDK will actually use (Electron-bundled custom
        // path, CLI/dev-runtime path from getDefaultOptions, or undefined for SDK
        // auto-discovery via node_modules). Used by the ENOENT classifier to tell
        // "binary missing" apart from "cwd missing" — both surface as ENOENT from spawn().
        const resolvedBinaryPath = options.pathToClaudeCodeExecutable;
        // Track whether we're trying to resume a session (for error handling)
        // Also covers branch fork attempts where sessionId is null but branchFromSdkSessionId is set
        const wasResuming = !_isRetry && (!!transportOwner["sessionId"] || !!transportOwner["branchFromSdkSessionId"]);
        // Track whether this turn attempted branch-point cutoff via resumeSessionAt.
        // Needed for targeted fallback when the parent message UUID no longer exists server-side.
        const attemptedBranchCutoff = !_isRetry && !!transportOwner["branchFromSdkSessionId"] && !!transportOwner["branchFromSdkTurnId"];
        // Log resume attempt for debugging session failures
        if (wasResuming) {
            debug(`[ClaudeAgent] Attempting to resume SDK session: ${transportOwner["sessionId"]}`);
            if (transportOwner["branchFromSdkSessionId"]) {
                debug(`[ClaudeAgent] Branch fork: parentSdkSessionId=${transportOwner["branchFromSdkSessionId"]}, branchFromSdkCwd=${transportOwner["branchFromSdkCwd"]}, resumeSessionAt=${transportOwner["branchFromSdkTurnId"]}, childSdkCwd=${transportOwner["config"].session?.sdkCwd}`);
            }
        }
        else {
            debug(`[ClaudeAgent] Starting fresh SDK session (no resume)`);
        }
        // Stop can be handled while asynchronous filesystem discovery is pending.
        if (preparationRevision !== transportOwner["promptPreparationRevision"])
            return;
        const turnMessageSource = await transportOwner["createClaudeTurnMessageSource"](userMessage, attachments, options, slashCommandRunsOutsidePersistentRuntime, _isRetry, gmailRuntimeContext);
        // Initialize event adapter for this turn
        // Session directory prevents race condition when concurrent sessions clobber toolMetadataStore.
        const metadataSessionDir = getSessionPath(transportOwner["workspaceRootPath"], sessionId);
        transportOwner["eventAdapter"].updateSessionDir(metadataSessionDir);
        transportOwner["eventAdapter"].startTurn();
        // Process SDK messages and convert to AgentEvents
        const summarizeCallback = transportOwner["getSummarizeCallback"]();
        let receivedComplete = false;
        // Track whether we received any assistant content (for empty response detection)
        // When SDK returns empty response (e.g., failed resume), we need to detect and recover
        let receivedAssistantContent = false;
        let suppressedSessionExpiredError = false;
        let suppressedBranchCutoffError = false;
        // Source-activation auto-restart drain controller (#790). Captures the
        // pending restart on the first triggering tool_result and drains sibling
        // tool_results from the same parallel-tool batch before firing
        // `source_activated` + `forceAbort` — otherwise the session journal
        // ends up with orphan `tool_use` IDs that block subsequent sends.
        const sourceActivationDrain = new SourceActivationDrainController('batch-boundary');
        try {
            // Flag-OFF: `turnMessageSource === this.currentQuery` (unchanged). Flag-ON:
            // it's the per-turn channel, so breaking/ending here never closes the query.
            for await (const message of turnMessageSource) {
                // Track if we got any text content from assistant
                if ('type' in message && message.type === 'assistant' && 'message' in message) {
                    const assistantMsg = message.message as {
                        content?: unknown[];
                    };
                    if (assistantMsg.content && Array.isArray(assistantMsg.content) && assistantMsg.content.length > 0) {
                        receivedAssistantContent = true;
                    }
                }
                // Also track text_delta events as assistant content (nested in stream_event)
                if ('type' in message && message.type === 'stream_event' && 'event' in message) {
                    const event = (message as {
                        event: {
                            type: string;
                        };
                    }).event;
                    if (event.type === 'content_block_delta' || event.type === 'message_start') {
                        receivedAssistantContent = true;
                    }
                }
                // Capture session ID for conversation continuity (only when it changes)
                if ('session_id' in message && message.session_id && message.session_id !== transportOwner["sessionId"]) {
                    transportOwner["sessionId"] = message.session_id;
                    // Notify caller of new SDK session ID (for immediate persistence)
                    transportOwner["config"].onSdkSessionIdUpdate?.(message.session_id);
                    // Retire in-memory branch fork metadata (persistence handled by callback)
                    if (transportOwner["branchFromSdkSessionId"]) {
                        debug(`[ClaudeAgent] Branch fork established, retiring in-memory fork metadata`);
                        transportOwner["branchFromSdkSessionId"] = null;
                        transportOwner["branchFromSdkCwd"] = null;
                        transportOwner["branchFromSdkTurnId"] = null;
                    }
                }
                const events = await transportOwner["eventAdapter"].adapt(message);
                for (const event of events) {
                    if (event.type === 'tool_result') {
                        const currentRequest = transportOwner["getCurrentTurnUserMessage"]() ?? undefined;
                        const currentAuthority = transportOwner["config"].getObjectiveMutationAuthority?.(currentRequest);
                        recordContextualGmailToolResult({
                            sessionId,
                            toolUseId: event.toolUseId,
                            toolName: event.toolName,
                            toolInput: event.input,
                            result: event.result,
                            isError: event.isError,
                            executed: event.executed,
                            objectiveAuthorizationSegments: typeof currentAuthority === 'object'
                                ? currentAuthority.authorizationSegments
                                : currentRequest ? [currentRequest] : [],
                        });
                    }
                    // After source_test (or any session-scoped tool) successfully activates a
                    // new source, activateSourceInSessionFn stashes a restart descriptor on the
                    // agent. The drain controller captures the descriptor on the first
                    // triggering tool_result and short-circuits per-event handling for any
                    // sibling tool_results / synthetic background events in the same
                    // adapted batch. The fire (yield source_activated + forceAbort) happens
                    // at end-of-batch below, NOT here — see #790 for the symptoms when
                    // siblings were dropped.
                    if (sourceActivationDrain.observe(event, () => transportOwner["consumePendingSourceActivationRestart"]())) {
                        yield event;
                        continue;
                    }
                    // Check for tool-not-found errors on inactive sources and attempt auto-activation
                    const inactiveSourceError = transportOwner["detectInactiveSourceToolError"](event, transportOwner["eventAdapter"].getToolIndex());
                    if (inactiveSourceError && transportOwner["onSourceActivationRequest"]) {
                        const { sourceSlug, toolName } = inactiveSourceError;
                        transportOwner["onDebug"]?.(`Detected tool call to inactive source "${sourceSlug}", attempting activation...`);
                        try {
                            const activated = await transportOwner["onSourceActivationRequest"](sourceSlug);
                            if (activated) {
                                transportOwner["onDebug"]?.(`Source "${sourceSlug}" activated successfully, interrupting turn for auto-retry`);
                                // Yield source_activated event immediately for auto-retry
                                yield {
                                    type: 'source_activated' as const,
                                    sourceSlug,
                                    originalMessage: userMessage,
                                };
                                // Interrupt the turn - no point letting the model continue without the tools
                                // The abort will cause the loop to exit and emit 'complete'
                                transportOwner["forceAbort"](AbortReason.SourceActivated);
                                return; // Exit the generator
                            }
                            else {
                                transportOwner["onDebug"]?.(`Source "${sourceSlug}" activation failed (may need auth)`);
                                // Let the original error through, but with more context
                                const toolResultEvent = event as Extract<AgentEvent, {
                                    type: 'tool_result';
                                }>;
                                yield {
                                    type: 'tool_result' as const,
                                    toolUseId: toolResultEvent.toolUseId,
                                    toolName: toolResultEvent.toolName,
                                    result: `Source "${sourceSlug}" could not be activated. It may require authentication. Please check the source status in the sources panel.`,
                                    isError: true,
                                    input: toolResultEvent.input,
                                    turnId: toolResultEvent.turnId,
                                    parentToolUseId: toolResultEvent.parentToolUseId,
                                };
                                continue;
                            }
                        }
                        catch (error) {
                            transportOwner["onDebug"]?.(`Source "${sourceSlug}" activation error: ${error}`);
                            // Let original error through
                        }
                    }
                    // Reset prerequisite state on compaction (LLM loses guide content)
                    if (event.type === 'info' && event.message === 'Compacted Conversation') {
                        transportOwner["resetPrerequisiteState"]();
                    }
                    // Intercept large/binary/media-rich tool results — save assets to disk,
                    // preserve original JSON when needed, and/or summarize oversized text.
                    if (event.type === 'tool_result' && !event.isError && event.result) {
                        const guarded = await guardLargeResult(event.result, {
                            sessionPath: metadataSessionDir,
                            toolName: event.toolName || 'unknown',
                            input: event.input,
                            summarize: summarizeCallback,
                            contextWindow: transportOwner["usageTracker"].getContextWindow(),
                        });
                        if (guarded) {
                            yield { ...event, result: guarded };
                            continue;
                        }
                    }
                    // Suggest CLI tools when Read fails on convertible file types
                    if (event.type === 'tool_result' && event.toolName === 'Read' && event.isError && event.result) {
                        const filePath = typeof event.input?.file_path === 'string' ? event.input.file_path : undefined;
                        if (filePath) {
                            const ext = filePath.split('.').pop()?.toLowerCase();
                            const hint = ext ? CONVERTIBLE_FILE_HINTS[ext] : undefined;
                            if (hint) {
                                // Split "or" alternatives into separate backtick-wrapped commands
                                const commands = hint.split(' or ').map(cmd => `\`${cmd} "${filePath}"\``).join(' or ');
                                yield { ...event, result: `${event.result}\n\nTip: Use ${commands} to convert this file to readable text.` };
                                continue;
                            }
                        }
                    }
                    // Suppress session-expired errors during resume/fork — don't yield
                    // them to the caller. The post-loop recovery (wasResuming check)
                    // will handle the retry. Without this, the error event reaches the
                    // SessionManager which shows it as a toast before recovery runs.
                    if (wasResuming && !_isRetry &&
                        event.type === 'error' &&
                        'message' in event && typeof event.message === 'string' &&
                        event.message.includes('No conversation found with session ID')) {
                        debug('[SESSION_DEBUG] Suppressing session-expired error event for recovery:', event.message);
                        suppressedSessionExpiredError = true;
                        continue;
                    }
                    // Suppress resumeSessionAt branch-cutoff failures when the requested
                    // parent message UUID no longer exists server-side (e.g., compaction/TTL).
                    // We'll retry once without resumeSessionAt.
                    if (attemptedBranchCutoff && wasResuming && !_isRetry &&
                        event.type === 'error' &&
                        'message' in event && typeof event.message === 'string' &&
                        event.message.includes('No message found with message.uuid')) {
                        debug('[SESSION_DEBUG] Suppressing missing-UUID branch cutoff error for fallback:', event.message);
                        suppressedBranchCutoffError = true;
                        continue;
                    }
                    // Also suppress the complete event that follows a suppressed error —
                    // recovery will produce its own completion flow.
                    if ((suppressedSessionExpiredError || suppressedBranchCutoffError) && event.type === 'complete') {
                        debug('[SESSION_DEBUG] Suppressing complete event after suppressed resume/fork error');
                        receivedComplete = true; // prevent duplicate complete emission
                        continue;
                    }
                    if (event.type === 'complete') {
                        receivedComplete = true;
                    }
                    yield event;
                }
                // End-of-batch fire (#790): if the drain controller captured a
                // pending source-activation restart while iterating this adapted
                // SDK message, all sibling tool_results / interleaved synthetic
                // events have now been yielded. Emit `source_activated` and abort.
                const sourceActivationFire = sourceActivationDrain.shouldFireAtBoundary();
                if (sourceActivationFire) {
                    transportOwner["onDebug"]?.(`source_test activated "${sourceActivationFire.sourceSlug}", drained sibling tool_results, restarting turn`);
                    yield sourceActivationFire;
                    transportOwner["forceAbort"](AbortReason.SourceActivated);
                    return;
                }
            }
            // Stream-end fallback (#790): the SDK stream ended without any batch
            // boundary firing — defensive against the SDK closing in the same
            // adapted batch the capture happened in. `return` is critical here —
            // without it we fall through to flushPending + the defensive
            // `complete` emission below, which would corrupt the auto-restart
            // contract (renderer expects `source_activated` to be the final event).
            const sourceActivationFireAtEnd = sourceActivationDrain.shouldFireAtBoundary();
            if (sourceActivationFireAtEnd) {
                transportOwner["onDebug"]?.(`source_test activated "${sourceActivationFireAtEnd.sourceSlug}", stream ended mid-batch, restarting turn`);
                yield sourceActivationFireAtEnd;
                transportOwner["forceAbort"](AbortReason.SourceActivated);
                return;
            }
            // Missing-UUID fallback: branch cutoff failed because resumeSessionAt target
            // no longer exists server-side. Retry once by resuming the child session
            // that was already established (without re-applying resumeSessionAt).
            if (suppressedBranchCutoffError && !_isRetry && transportOwner["sessionId"]) {
                debug('[SESSION_DEBUG] >>> DETECTED MISSING-UUID BRANCH CUTOFF ERROR - retrying on child session without cutoff');
                yield { type: 'info', message: 'Branch point was compacted on server, retrying with nearest available context...' };
                yield* transportOwner["chat"](userMessage, attachments);
                return;
            }
            // Detect empty response when resuming - SDK silently fails resume if session is invalid
            // In this case, we got a new session ID but no assistant content
            debug('[SESSION_DEBUG] Post-loop check: wasResuming=', wasResuming, 'receivedAssistantContent=', receivedAssistantContent, '_isRetry=', _isRetry);
            if (wasResuming && !receivedAssistantContent && !_isRetry) {
                debug('[SESSION_DEBUG] >>> DETECTED EMPTY RESPONSE - triggering recovery');
                const wasBranchFork = !!transportOwner["branchFromSdkSessionId"];
                if (wasBranchFork) {
                    // Branch-fork failure: route through the shared helper so all four
                    // fork fields are persisted atomically (sdkSessionId + branchFromSdk*),
                    // and the parent conversation summary is injected into the retry.
                    yield* transportOwner["recoverFromStaleBranchFork"](userMessage, attachments, /* isPreSpawn */ false);
                    return;
                }
                // Regular resume failure (no branch fork): clear the session and retry
                // with raw recovery context. onSdkSessionIdCleared persists the
                // cleared sdkSessionId; there are no branch fields to clear here.
                transportOwner["sessionId"] = null;
                transportOwner["config"].onSdkSessionIdCleared?.();
                transportOwner["pinnedPreferencesPrompt"] = null;
                transportOwner["pinnedIncludeCoAuthoredBy"] = null;
                transportOwner["pinnedProjectContext"] = null;
                transportOwner["preferencesDriftNotified"] = false;
                let retryMessage = userMessage;
                const recoveryContext = transportOwner["buildRecoveryContext"]();
                if (recoveryContext)
                    retryMessage = recoveryContext + userMessage;
                yield { type: 'info', message: 'Restoring conversation context...' };
                yield* transportOwner["chat"](retryMessage, attachments, { isRetry: true });
                return;
            }
            // Defensive: flush any pending text that wasn't emitted
            // This can happen if the SDK sends an assistant message with text but skips the
            // message_delta event that normally triggers text_complete (rare edge scenarios)
            const flushedEvent = transportOwner["eventAdapter"].flushPending();
            if (flushedEvent) {
                yield flushedEvent;
            }
            // Defensive: emit complete if SDK didn't send result message
            if (!receivedComplete) {
                yield { type: 'complete' };
            }
        }
        catch (sdkError) {
            return yield* transportOwner["recoverClaudeQueryError"](sdkError, {
                receivedAssistantContent, wasResuming, _isRetry, userMessage, attachments, suppressedSessionExpiredError, suppressedBranchCutoffError, resolvedBinaryPath, resolvedCwd,
            });
        }
    }
    catch (error) {
        // Debug: log outer catch trigger (stderr to avoid SDK JSON pollution)
        console.error(`[ClaudeAgent] OUTER CATCH triggered: ${error instanceof Error ? error.message : String(error)}`);
        console.error(`[ClaudeAgent] Error stack: ${error instanceof Error ? error.stack : 'no stack'}`);
        const errorMessage = error instanceof Error ? error.message : String(error);
        // Check if this is a recognizable error type
        const typedError = parseError(error);
        if (typedError.code !== 'unknown_error') {
            // Known error type - show user-friendly message with recovery actions
            yield { type: 'typed_error', error: typedError };
        }
        else {
            // Unknown error - show raw message
            yield { type: 'error', message: errorMessage };
        }
        // emit complete even on error so application knows we're done
        yield { type: 'complete' };
    }
    finally {
        // A per-turn SDK iterator ending is a confirmed runtime boundary. The
        // persistent query is confirmed separately by its sole consumer when it
        // actually exits; a normal turn boundary must not invalidate that live
        // process or its background work.
        if (!usesPersistentGmailRuntime || transportOwner["persistentGmailRuntimeId"] !== gmailRuntimeId) {
            transportOwner["confirmContextualGmailRuntimeTeardown"]({
                sessionId,
                runtimeId: gmailRuntimeId,
            });
        }
        if (transportOwner["activeTurnGmailRuntime"]?.runtimeId === gmailRuntimeId) {
            transportOwner["activeTurnGmailRuntime"] = null;
        }
        // [bg-lifecycle] Nulling currentQuery closes the SDK query iterator, which
        // tears down the per-turn subprocess and any background sub-agents it
        // launched. This is the teardown point referenced by WS2-step0: background
        // agents die HERE at turn end, not when a second user message arrives.
        // WS2: in keep-alive mode the persistent query is kept open across turns —
        // the per-turn channel already ended at `result`, and teardown happens only
        // via teardownPersistentQuery() (dispose/auth-fail/recreate/clearHistory).
        // Flag-OFF path is unchanged: null currentQuery → subprocess teardown.
        if (transportOwner["keepBackgroundTasksAlive"] && transportOwner["persistentInput"]) {
            debug(`[bg-lifecycle] chat() turn finished — persistent query kept alive`, { sessionId: transportOwner["config"].session?.id, sdkSessionId: transportOwner["sessionId"] });
        }
        else {
            debug(`[bg-lifecycle] chat() finally — currentQuery nulled, subprocess torn down`, { sessionId: transportOwner["config"].session?.id, sdkSessionId: transportOwner["sessionId"], keepAlive: transportOwner["keepBackgroundTasksAlive"] });
            transportOwner["currentQuery"] = null;
        }
    }
}
