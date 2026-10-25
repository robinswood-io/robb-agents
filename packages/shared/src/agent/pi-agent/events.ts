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
// Error typing
import { parseError } from "../errors.ts";
// Centralized PreToolUse pipeline
import { recordContextualGmailToolResult } from "../core/pre-tool-use.ts";
// LLM tool types
import { type LLMQueryResult } from "../llm-tool.ts";
import type { PiAgent } from '../pi-agent.ts';
import type { PiSubprocessRuntimeContext } from './shared.ts';

/**
   * Parse a JSONL line from subprocess stdout and dispatch by type.
   */
export function handleLine(transportOwner: PiAgent, agentClass: typeof PiAgent, line: string, child?: ChildProcess, runtimeContext?: PiSubprocessRuntimeContext): void {
    if (!line.trim())
        return;
    if (child && (transportOwner["subprocess"] !== child || !transportOwner["isRuntimeCurrent"](runtimeContext))) {
        transportOwner["debug"]('Ignoring output from stale Pi subprocess generation');
        return;
    }
    let msg: Record<string, unknown>;
    try {
        msg = JSON.parse(line);
    }
    catch {
        transportOwner["debug"](`Invalid JSONL from subprocess: ${line.slice(0, 200)}`);
        return;
    }
    const type = msg.type as string;
    if (type !== 'error') {
        transportOwner["resetSubprocessErrorDedup"]();
    }
    switch (type) {
        case 'ready':
            // Subprocess initialized, callback server listening
            transportOwner["callbackPort"] = (msg.callbackPort as number) || 0;
            if (msg.sessionId) {
                transportOwner["piSessionId"] = msg.sessionId as string;
                transportOwner["config"].onSdkSessionIdUpdate?.(transportOwner["piSessionId"]!);
            }
            transportOwner["resolveSubprocessReady"]();
            break;
        case 'provider_handoff': {
            const id = typeof msg.id === 'string' ? msg.id : undefined;
            const acknowledge = id ? transportOwner["pendingProviderHandoffs"].get(id) : undefined;
            if (id && acknowledge) {
                transportOwner["pendingProviderHandoffs"].delete(id);
                transportOwner["pendingProviderDispatchRejections"].delete(id);
                acknowledge();
            }
            else {
                transportOwner["debug"](`Ignoring unmatched provider handoff acknowledgement: ${id ?? 'missing id'}`);
            }
            break;
        }
        case 'event':
            // Pi SDK event -- forward through PiEventAdapter
            transportOwner["handleSubprocessEvent"](msg.event as Record<string, unknown>);
            break;
        case 'pre_tool_use_request':
            // Subprocess needs permission check + transforms before tool execution
            void transportOwner["handlePreToolUseRequest"](msg as {
                requestId: string;
                toolName: string;
                toolCallId?: string;
                input: Record<string, unknown>;
            }, runtimeContext ?? transportOwner["subprocessRuntimeContext"] ?? undefined);
            break;
        case 'tool_execute_request':
            // Subprocess wants main process to execute a proxy tool (MCP/API/session)
            void transportOwner["handleToolExecuteRequest"](msg as {
                requestId: string;
                toolName: string;
                toolCallId?: string;
                args: Record<string, unknown>;
            }, runtimeContext ?? transportOwner["subprocessRuntimeContext"] ?? undefined);
            break;
        case 'session_tool_completed':
            // Session MCP tool completed -- fire callbacks (SubmitPlan, auth, etc.)
            transportOwner["handleSessionToolCompleted"](msg);
            break;
        case 'mini_completion_result':
            // Response to a mini_completion request
            transportOwner["handleMiniCompletionResult"](msg);
            break;
        case 'llm_query_result': {
            // Response to an llm_query request
            const id = msg.id as string;
            const pending = transportOwner["pendingLlmQueries"].get(id);
            if (pending) {
                transportOwner["pendingLlmQueries"].delete(id);
                const result = msg.result as LLMQueryResult | null;
                if (result) {
                    pending.resolve(result);
                }
                else {
                    const errorMessage = typeof msg.errorMessage === 'string' ? msg.errorMessage : 'llm_query failed';
                    pending.reject(new Error(errorMessage));
                }
            }
            break;
        }
        case 'ensure_session_ready_result':
            // Response to an ensure_session_ready request
            transportOwner["handleEnsureSessionReadyResult"](msg);
            break;
        case 'compact_result':
            // Response to a compact request
            transportOwner["handleCompactResult"](msg);
            break;
        case 'set_auto_compaction_result':
            // Response to an auto-compaction toggle request
            transportOwner["handleSetAutoCompactionResult"](msg);
            break;
        case 'update_runtime_config_result':
            // Response to a runtime config refresh request
            transportOwner["handleRuntimeConfigUpdateResult"](msg);
            break;
        case 'session_id_update':
            // Pi session ID changed
            if (msg.sessionId) {
                transportOwner["piSessionId"] = msg.sessionId as string;
                transportOwner["config"].onSdkSessionIdUpdate?.(transportOwner["piSessionId"]!);
            }
            break;
        case 'error': {
            const errorCode = typeof msg.code === 'string' ? msg.code : undefined;
            const rawMessage = String(msg.message || 'Unknown subprocess error');
            if (errorCode === 'prompt_error' && typeof msg.id === 'string') {
                transportOwner["pendingProviderHandoffs"].delete(msg.id);
                const reject = transportOwner["pendingProviderDispatchRejections"].get(msg.id);
                transportOwner["pendingProviderDispatchRejections"].delete(msg.id);
                reject?.();
            }
            transportOwner["debug"](`Subprocess error${errorCode ? ` (${errorCode})` : ''}: ${rawMessage}`);
            const errorMsg = rawMessage.toLowerCase();
            // Detect auth errors and attempt token refresh for OAuth connections
            if (transportOwner["config"].authType === 'oauth' && (errorMsg.includes('401') ||
                errorMsg.includes('421') ||
                errorMsg.includes('unauthorized') ||
                errorMsg.includes('misdirected') ||
                (errorMsg.includes('token') && errorMsg.includes('expired')) ||
                errorMsg.includes('authentication'))) {
                transportOwner["debug"]('Auth error detected from subprocess, attempting token refresh');
                transportOwner["refreshAndPushTokens"]().catch(err => {
                    transportOwner["debug"](`Token refresh after auth error failed: ${err}`);
                });
            }
            // Reject any pending mini completions so errors propagate immediately.
            // mini_completion_error is an internal utility-path failure (title/summarization)
            // and should not surface as a user-visible chat error.
            for (const [id, pending] of transportOwner["pendingMiniCompletions"]) {
                pending.reject(new Error(rawMessage));
                transportOwner["pendingMiniCompletions"].delete(id);
            }
            // Same treatment for pending llm_query calls. llm_query_error is also an
            // internal utility-path code (call_llm): the dual-emit from the subprocess
            // means a targeted `llm_query_result` is sent alongside this generic `error`
            // to reject the specific pending promise — this loop is the defensive cleanup
            // for queries that never got a targeted result (subprocess crash, etc.).
            for (const [id, pending] of transportOwner["pendingLlmQueries"]) {
                pending.reject(new Error(rawMessage));
                transportOwner["pendingLlmQueries"].delete(id);
            }
            if (errorCode === 'mini_completion_error' || errorCode === 'llm_query_error') {
                transportOwner["debug"](`Ignoring ${errorCode} subprocess error in chat stream`);
                break;
            }
            transportOwner["adapter"].clearPendingError();
            // Reject pending ensure_session_ready requests (used by branch preflight)
            for (const [id, pending] of transportOwner["pendingEnsureSessionReady"]) {
                pending.reject(new Error(rawMessage));
                transportOwner["pendingEnsureSessionReady"].delete(id);
            }
            // Reject pending compact/toggle requests
            for (const [id, pending] of transportOwner["pendingCompactions"]) {
                pending.reject(new Error(rawMessage));
                transportOwner["pendingCompactions"].delete(id);
            }
            for (const [id, pending] of transportOwner["pendingAutoCompactionToggles"]) {
                pending.reject(new Error(rawMessage));
                transportOwner["pendingAutoCompactionToggles"].delete(id);
            }
            for (const [id, pending] of transportOwner["pendingRuntimeConfigUpdates"]) {
                pending.reject(new Error(rawMessage));
                transportOwner["pendingRuntimeConfigUpdates"].delete(id);
            }
            // Suppress repeated identical errors to prevent a broken subprocess
            // from flooding the user's session (e.g. EFAULT loop).
            if (rawMessage === transportOwner["lastSubprocessError"]) {
                transportOwner["subprocessErrorRepeatCount"]++;
                if (transportOwner["subprocessErrorRepeatCount"] > agentClass["MAX_IDENTICAL_SUBPROCESS_ERRORS"]) {
                    transportOwner["debug"](`Suppressing repeated subprocess error (${transportOwner["subprocessErrorRepeatCount"]}x): ${rawMessage}`);
                    break;
                }
            }
            else {
                transportOwner["lastSubprocessError"] = rawMessage;
                transportOwner["subprocessErrorRepeatCount"] = 1;
            }
            const parsed = parseError(new Error(rawMessage));
            if (parsed.code !== 'unknown_error') {
                transportOwner["eventQueue"].enqueue({ type: 'typed_error', error: parsed });
            }
            else {
                transportOwner["eventQueue"].enqueue({
                    type: 'error',
                    message: `Pi subprocess error: ${rawMessage}`,
                });
            }
            // The worker follows this with agent_settled after all prompt calls finish.
            // A subprocess exit also completes the queue through handleSubprocessExit().
            break;
        }
        default:
            transportOwner["debug"](`Unknown subprocess message type: ${type}`);
    }
}

/**
   * Forward a Pi SDK event from the subprocess through the event adapter.
   */
export function handleSubprocessEvent(transportOwner: PiAgent, event: Record<string, unknown>): void {
    // The subprocess sends Pi SDK AgentSessionEvent objects serialized as JSON.
    // Feed them through PiEventAdapter to convert to Craft AgentEvents.
    // Detect session MCP tool completions (same pattern as in-process version)
    const eventType = event.type as string;
    let adaptedEvent = event;
    if (eventType === 'tool_execution_start') {
        const toolName = event.toolName as string;
        if (toolName?.startsWith('session__') || toolName?.startsWith('mcp__session__')) {
            // Session tool tracking is handled by the subprocess; it sends
            // session_tool_completed events when appropriate.
        }
        // Deterministic metadata bridge: if subprocess event lacks toolMetadata,
        // inject metadata captured from pre_tool_use_request before stripping.
        const toolCallId = event.toolCallId as string | undefined;
        const existingMeta = event.toolMetadata as {
            intent?: string;
            displayName?: string;
        } | undefined;
        if (toolCallId && !existingMeta) {
            const cached = transportOwner["preToolMetadataByCallId"].get(toolCallId);
            if (cached && (cached.intent || cached.displayName)) {
                adaptedEvent = {
                    ...event,
                    toolMetadata: {
                        intent: cached.intent,
                        displayName: cached.displayName,
                        source: 'interceptor',
                    },
                };
                transportOwner["debug"](`Injected pre-tool metadata for ${toolName} (${toolCallId}) from bridge cache`);
            }
        }
    }
    if (eventType === 'compaction_start' && transportOwner["pendingProviderHandoffs"].size > 0) {
        for (const [id, acknowledge] of transportOwner["pendingProviderHandoffs"]) {
            transportOwner["pendingProviderHandoffs"].delete(id);
            transportOwner["pendingProviderDispatchRejections"].delete(id);
            acknowledge();
        }
    }
    if (eventType === 'tool_execution_end') {
        const toolCallId = event.toolCallId as string | undefined;
        if (toolCallId) {
            transportOwner["settleAdmittedToolExecution"](toolCallId);
            transportOwner["preToolMetadataByCallId"].delete(toolCallId);
        }
    }
    // Adapt event to CraftAgentEvents
    // The owned subprocess serializes the Pi SDK event union on this IPC boundary.
    for (const agentEvent of transportOwner["adapter"].adaptEvent(adaptedEvent as Parameters<PiAgent['adapter']['adaptEvent']>[0])) {
        if (agentEvent.type === 'typed_error' &&
            transportOwner["config"].authType === 'oauth' &&
            (agentEvent.error.code === 'expired_oauth_token' || agentEvent.error.code === 'invalid_api_key')) {
            // Provider message_end failures do not necessarily arrive through the
            // generic subprocess `error` envelope. Start refresh here as well so
            // SessionManager's replacement runtime can join the same global mutex.
            void transportOwner["refreshAndPushTokens"]().catch(error => {
                transportOwner["debug"](`Token refresh from typed auth error failed: ${error}`);
            });
        }
        // Correlate the successful result with its acquisition input; start alone earns no credit.
        if (agentEvent.type === 'tool_start') {
            transportOwner["prerequisiteManager"].trackToolStart(agentEvent.toolUseId, agentEvent.toolName, agentEvent.input);
        }
        if (agentEvent.type === 'tool_result') {
            transportOwner["prerequisiteManager"].trackToolCompletion(agentEvent.toolUseId, agentEvent.result, agentEvent.isError, agentEvent.executed !== false);
            const currentRequest = transportOwner["getCurrentTurnUserMessage"]() ?? undefined;
            const currentAuthority = transportOwner["config"].getObjectiveMutationAuthority?.(currentRequest);
            recordContextualGmailToolResult({
                sessionId: transportOwner["config"].session?.id || transportOwner["_sessionId"],
                toolUseId: agentEvent.toolUseId,
                toolName: agentEvent.toolName,
                toolInput: agentEvent.input,
                result: agentEvent.result,
                isError: agentEvent.isError,
                executed: agentEvent.executed,
                objectiveAuthorizationSegments: typeof currentAuthority === 'object'
                    ? currentAuthority.authorizationSegments
                    : currentRequest ? [currentRequest] : [],
            });
        }
        // Reset prerequisite state on compaction (LLM loses guide content)
        if (agentEvent.type === 'info' && typeof agentEvent.message === 'string' && agentEvent.message.startsWith('Compacted')) {
            transportOwner["resetPrerequisiteState"]();
        }
        // Fire PostToolUse / PostToolUseFailure hook events (fire-and-forget)
        if (agentEvent.type === 'tool_result') {
            const hookEvent = agentEvent.isError ? 'PostToolUseFailure' : 'PostToolUse';
            transportOwner["emitAutomationEvent"](hookEvent, {
                hook_event_name: hookEvent,
                tool_name: agentEvent.toolName ?? (event.toolName as string) ?? 'unknown',
                tool_input: agentEvent.input,
                ...(agentEvent.isError
                    ? { error: typeof agentEvent.result === 'string' ? agentEvent.result : undefined }
                    : { tool_response: typeof agentEvent.result === 'string' ? agentEvent.result : undefined }),
            });
        }
        transportOwner["eventQueue"].enqueue(agentEvent);
    }
    // The worker settles only after the SDK and deferred continuations finish.
    if (eventType === 'agent_settled') {
        transportOwner["eventQueue"].complete();
    }
}
