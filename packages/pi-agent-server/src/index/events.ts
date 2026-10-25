import { findSdkTurnAnchor } from "../turn-history.ts";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { getSessionPath } from "../../../shared/src/sessions/storage.ts";
import { PI_TOOL_NAME_MAP } from "../../../shared/src/agent/backend/pi/constants.ts";
import { normalizeForPiTool, stripCraftMetadata } from "../craft-metadata-schema.ts";
import { normalizeSessionPathTokens } from "../session-path-normalization.ts";
import type { ToolExecutionMetadata, OutboundAgentEvent } from "./contracts.ts";
import type { PiRuntimeState } from "./runtime-state.ts";
import { debugLog, send } from "./stdio.ts";

// ============================================================
// Event Handling
// ============================================================
export function extractToolExecutionMetadata(args: Record<string, unknown> | undefined): ToolExecutionMetadata | undefined {
    if (!args)
        return undefined;
    const intent = typeof args._intent === 'string' ? args._intent : undefined;
    const displayName = typeof args._displayName === 'string' ? args._displayName : undefined;
    if (!intent && !displayName)
        return undefined;
    return {
        intent,
        displayName,
        source: 'interceptor',
    };
}

export function handleSessionEvent(runtimeState: PiRuntimeState, event: AgentSessionEvent, sourceSession: AgentSession): void {
    if (runtimeState.piSession !== sourceSession)
        return;
    if (event.type === 'agent_settled') {
        runtimeState.lastNativeSettlement = event;
        return;
    }
    if (event.type === 'agent_end')
        return;
    if (event.type === 'agent_start')
        runtimeState.lastNativeSettlement = { type: 'agent_settled', aborted: false };
    if (event.type === 'turn_end' && event.message.role === 'assistant') {
        const sdkTurnAnchor = findSdkTurnAnchor(sourceSession.sessionManager, event.message);
        const sdkMessageId = runtimeState.sdkMessageCorrelations.get(event.message);
        if (sdkTurnAnchor && sdkMessageId) {
            send({ type: 'event', event: { type: 'pi_turn_anchor', sdkMessageId, sdkTurnAnchor } });
        }
    }
    let forwardedEvent: OutboundAgentEvent = event;
    // Log API errors for debugging and attach provider-native turn anchor for branch cutoffs.
    if (event.type === 'message_end') {
        const msg = event.message as {
            role?: string;
            stopReason?: string;
            errorMessage?: string;
        } | undefined;
        if (msg?.stopReason === 'error') {
            debugLog(`API error in message_end: ${msg.errorMessage || 'unknown'}`);
        }
        if (msg?.role === 'assistant' && runtimeState.piSession) {
            // Correlate the event with its later persisted turn, including providers
            // that do not supply message IDs. The SDK message itself stays untouched.
            const sdkMessageId = runtimeState.sdkMessageCorrelations.get(event.message) ?? crypto.randomUUID();
            runtimeState.sdkMessageCorrelations.set(event.message, sdkMessageId);
            forwardedEvent = { ...event, sdkMessageId };
            // Register the planned batch for loop-budget diagnostics only. Proxy
            // execution remains sequential behind each invocation's PreToolUse gate.
            const content = (msg as {
                content?: Array<{
                    type: string;
                    id?: string;
                    name?: string;
                    arguments?: unknown;
                }>;
            }).content;
            if (Array.isArray(content)) {
                const plannedToolCalls = content.flatMap((item) => {
                    if (item.type !== 'toolCall' || !item.name)
                        return [];
                    const sdkToolName = PI_TOOL_NAME_MAP[item.name] || item.name;
                    let batchInput = stripCraftMetadata((item.arguments ?? {}) as Record<string, unknown>);
                    if (runtimeState.initConfig) {
                        const sessionPath = getSessionPath(runtimeState.initConfig.workspaceRootPath, runtimeState.initConfig.sessionId);
                        batchInput = normalizeSessionPathTokens(batchInput, sessionPath) as Record<string, unknown>;
                    }
                    batchInput = normalizeForPiTool(sdkToolName, batchInput);
                    return [{ toolName: sdkToolName, input: batchInput }];
                });
                runtimeState.toolLoopBudget.registerPlannedBatch(plannedToolCalls);
            }
        }
    }
    // Detect session MCP tool completions + enrich tool starts with canonical metadata
    if (event.type === 'tool_execution_start') {
        const toolName = event.toolName;
        if (toolName.startsWith('session__') || toolName.startsWith('mcp__session__')) {
            const mcpToolName = toolName.replace(/^(mcp__session__|session__)/, '');
            runtimeState.pendingSessionToolCalls.set(event.toolCallId, {
                toolName: mcpToolName,
                arguments: (event.args ?? {}) as Record<string, unknown>,
            });
        }
        const toolMetadata = extractToolExecutionMetadata((event.args ?? {}) as Record<string, unknown>);
        if (toolMetadata) {
            forwardedEvent = {
                ...event,
                toolMetadata,
            };
        }
    }
    if (event.type === 'tool_execution_end') {
        const pending = runtimeState.pendingSessionToolCalls.get(event.toolCallId);
        if (pending) {
            runtimeState.pendingSessionToolCalls.delete(event.toolCallId);
            send({
                type: 'session_tool_completed',
                toolName: pending.toolName,
                args: pending.arguments,
                isError: !!event.isError,
            });
        }
    }
    // Forward all events to main process
    send({ type: 'event', event: forwardedEvent });
}
