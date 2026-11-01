import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { TextContent as PiTextContent } from "@earendil-works/pi-ai";
import { handleLargeResponse, estimateTokens, estimateTokensDensityAware, isAlreadyGuardedLargeResponse, tokenLimitFor } from "../../../shared/src/utils/large-response.ts";
import { getSessionPath } from "../../../shared/src/sessions/storage.ts";
import { PI_TOOL_NAME_MAP } from "../../../shared/src/agent/backend/pi/constants.ts";
import { allowCraftMetadataProperties, normalizeForPiTool, stripCraftMetadata } from "../craft-metadata-schema.ts";
import { finishToolLoopResult } from "../tool-loop-feedback.ts";
import { createToolExecutionCheckpointResult } from "../tool-execution-checkpoint.ts";
import { normalizeSessionPathTokens } from "../session-path-normalization.ts";
import { ReadToolTimeoutError, resolveReadToolTimeoutMs, withReadToolTimeout } from "../read-tool-timeout.ts";
import { waitForProxyToolResponse } from "../proxy-tool-response-watchdog.ts";
import type { RuntimeToolDefinition } from "./contracts.ts";
import type { PiRuntimeState } from "./runtime-state.ts";
import { handleSessionEvent } from "./events.ts";
import { queryLlm } from "./queries.ts";
import { debugLog, send } from "./stdio.ts";

// ============================================================
// Tool Wrapping (Permission Enforcement + Large Response Summarization)
// ============================================================
/**
 * Shared permission enforcement for both coding tools and proxy tools.
 * Checks mode-manager rules and, in Ask mode, prompts the user via the
 * pending-permissions handshake. Throws on deny or block.
 */
/**
 * Send pre_tool_use_request to main process and wait for response.
 * Returns the (potentially modified) input if approved, throws if blocked.
 * All permission checking, transforms, and source activation happen in the main process.
 */
export async function requestPreToolUseApproval(runtimeState: PiRuntimeState, sdkToolName: string, input: Record<string, unknown>, toolCallId?: string): Promise<Record<string, unknown>> {
    const requestId = `pi-ptu-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    send({
        type: 'pre_tool_use_request',
        requestId,
        toolName: sdkToolName,
        ...(toolCallId ? { toolCallId } : {}),
        input,
    });
    const response = await new Promise<{
        action: string;
        input?: Record<string, unknown>;
        reason?: string;
    }>((resolve) => {
        runtimeState.pendingPreToolUse.set(requestId, { resolve });
    });
    if (response.action === 'block') {
        throw new Error(response.reason || `Tool "${sdkToolName}" is not allowed`);
    }
    return response.action === 'modify' && response.input ? response.input : input;
}

export function wrapToolsWithHooks(runtimeState: PiRuntimeState, tools: RuntimeToolDefinition[]): RuntimeToolDefinition[] {
    return tools.map(tool => wrapSingleTool(runtimeState, tool));
}

export function makeErrorResult(message: string): AgentToolResult<unknown> {
    return {
        content: [{ type: 'text', text: message }],
        details: { isError: true },
    };
}

export function wrapSingleTool(runtimeState: PiRuntimeState, tool: RuntimeToolDefinition): RuntimeToolDefinition {
    const originalExecute = tool.execute;
    const sdkToolName = PI_TOOL_NAME_MAP[tool.name] || tool.name;
    const parameters = allowCraftMetadataProperties(tool.parameters, sdkToolName);
    const wrappedExecute: RuntimeToolDefinition['execute'] = async (toolCallId, params, signal, onUpdate, ctx) => {
        const feedbackSession = runtimeState.piSession;
        let inputObj: Record<string, unknown> = { ...(params as Record<string, unknown>) };
        if (runtimeState.initConfig) {
            const sessionPath = getSessionPath(runtimeState.initConfig.workspaceRootPath, runtimeState.initConfig.sessionId);
            inputObj = normalizeSessionPathTokens(inputObj, sessionPath) as Record<string, unknown>;
        }
        // Extract intent before main process strips metadata (used for summarization)
        const intent = typeof inputObj["_intent"] === 'string' ? inputObj["_intent"] : undefined;
        // Normalize Pi SDK parameter names: path → file_path
        if ((sdkToolName === 'Write' || sdkToolName === 'Edit' || sdkToolName === 'MultiEdit' || sdkToolName === 'NotebookEdit')
            && typeof inputObj["path"] === 'string' && !inputObj["file_path"]) {
            inputObj = { ...inputObj, file_path: inputObj["path"] };
        }
        if (sdkToolName === 'Edit' && Array.isArray(inputObj["edits"])) {
            const firstEdit = inputObj["edits"][0] as {
                oldText?: unknown;
                newText?: unknown;
            } | undefined;
            if (firstEdit && typeof firstEdit.oldText === 'string' && typeof firstEdit.newText === 'string') {
                inputObj["old_string"] ??= firstEdit.oldText;
                inputObj["new_string"] ??= firstEdit.newText;
            }
        }
        // Send to main process for permission checking + transforms
        inputObj = await requestPreToolUseApproval(runtimeState, sdkToolName, inputObj, toolCallId);
        // Metadata is for Craft UI only. Keep a final defensive strip here so the
        // upstream Pi tool implementation always receives clean executable args,
        // even if a future pre-tool-use path returns `allow` without modification.
        inputObj = normalizeForPiTool(sdkToolName, stripCraftMetadata(inputObj));
        const loopDecision = runtimeState.toolLoopBudget.observe(sdkToolName, inputObj);
        if (loopDecision.action === 'block') {
            const reason = loopDecision.message ?? 'Repeated unchanged tool call blocked.';
            return process.env["ROBB_LEGACY_HOST_OBJECTIVE_CONTRACT"] === '1'
                ? createToolExecutionCheckpointResult(reason)
                : makeErrorResult(reason);
        }
        const finishResult = (result: AgentToolResult<unknown>) => finishToolLoopResult(result, loopDecision, {
            session: feedbackSession, isCurrentSession: () => runtimeState.piSession === feedbackSession, toolCallId, ...(signal !== undefined ? { signal: signal } : {}),
            onHint: message => { if (feedbackSession)
                handleSessionEvent(runtimeState, { type: 'message_end', message }, feedbackSession); },
            onError: error => debugLog(`Tool-loop guidance unavailable: ${error instanceof Error ? error.message : String(error)}`),
        });
        // Execute original tool with (potentially modified) input
        let result: AgentToolResult<unknown>;
        try {
            result = await withReadToolTimeout(sdkToolName, originalExecute(toolCallId, inputObj, signal, onUpdate, ctx), resolveReadToolTimeoutMs(process.env["CRAFT_READ_TOOL_TIMEOUT_MS"]));
        }
        catch (error) {
            if (error instanceof ReadToolTimeoutError) {
                return makeErrorResult(error.message);
            }
            throw error;
        }
        // --- Post-execute: large response summarization ---
        const resultText = result.content
            .filter((c): c is PiTextContent => c.type === 'text')
            .map(c => c.text)
            .join('');
        // Source the active model's contextWindow each call so the threshold
        // tracks set_model mid-session, not the model that was active at session
        // creation. Falls back to the fixed default when the model isn't set yet.
        const modelContextWindow = runtimeState.piSession?.agent.state.model?.contextWindow;
        const baseTokenLimit = tokenLimitFor(modelContextWindow);
        const plainEstimatedTokens = estimateTokens(resultText);
        const estimatedResultTokens = estimateTokensDensityAware(resultText);
        const isDensePayload = estimatedResultTokens > plainEstimatedTokens;
        // Built-in Read already caps files at 2,000 lines / 50KB (~12,500 tokens).
        // Allow normal code/text Read results up to 12.5k tokens on standard-window
        // models so reading source files does not replace exact lines with a summary,
        // while base64-dense Read payloads still spill at baseTokenLimit.
        const effectiveTokenLimit = sdkToolName === 'Read'
            && !isDensePayload
            && (modelContextWindow === undefined || modelContextWindow >= 100000)
            ? Math.max(baseTokenLimit, 12500)
            : baseTokenLimit;
        const isLocalCodingTool = sdkToolName === 'Bash'
            || sdkToolName === 'Grep'
            || sdkToolName === 'Find'
            || sdkToolName === 'Ls'
            || sdkToolName === 'Read';
        if (runtimeState.initConfig && !isAlreadyGuardedLargeResponse(resultText)
            && estimatedResultTokens > effectiveTokenLimit) {
            try {
                const sessionPath = getSessionPath(runtimeState.initConfig.workspaceRootPath, runtimeState.initConfig.sessionId);
                const largeResult = await handleLargeResponse({
                    text: resultText,
                    sessionPath,
                    context: {
                        toolName: sdkToolName,
                        input: inputObj,
                        ...(intent !== undefined ? { intent: intent } : {}),
                        userRequest: runtimeState.currentUserMessage,
                    },
                    // Local deterministic coding tools use zero-LLM-cost head+tail preview +
                    // saved file reference; external tools use minimal thinking budget.
                    summarize: isLocalCodingTool
                        ? undefined
                        : async (prompt) => (await queryLlm(runtimeState, { prompt }, { thinkingLevel: 'minimal' })).text,
                    ...(modelContextWindow !== undefined ? { contextWindow: modelContextWindow } : {}),
                });
                if (largeResult) {
                    return finishResult({
                        content: [{ type: 'text', text: largeResult.message }],
                        details: result.details,
                    });
                }
            }
            catch (error) {
                debugLog(`Large response handling failed: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        return finishResult(result);
    };
    return {
        ...tool,
        parameters,
        execute: wrappedExecute,
    };
}

// ============================================================
// Proxy Tools (tools executed in main process)
// ============================================================
export function buildProxyTools(runtimeState: PiRuntimeState): RuntimeToolDefinition[] {
    debugLog(`Building proxy tools from ${runtimeState.proxyToolDefs.length} definitions: ${runtimeState.proxyToolDefs.map(t => t.name).join(', ')}`);
    return runtimeState.proxyToolDefs.map<RuntimeToolDefinition>(def => ({
        name: def.name,
        label: def.name
            .replace(/^mcp__.*?__/, '')
            .replace(/_/g, ' ')
            .replace(/([a-z])([A-Z])/g, '$1 $2'),
        description: def.description,
        // Pi SDK omits tools without promptSnippet from the system prompt's
        // "Available tools" section, making them invisible to the LLM.
        // Derive a compact snippet from the first paragraph of the description
        // (excluding appended budget/efficiency hints already in the tool schema).
        promptSnippet: (() => {
            const lead = def.description.split('\n\n')[0]?.trim() || def.description;
            return lead.length > 140 ? lead.slice(0, 137) + '...' : lead;
        })(),
        parameters: def.inputSchema,
        execute: async (toolCallId: string, params): Promise<AgentToolResult<unknown>> => {
            // Every proxy definition is installed through wrapToolsWithHooks(), whose
            // outer execute wrapper has already completed the host PreToolUse check
            // and passed the approved (possibly modified) input here. Rechecking in
            // this inner proxy executor used to emit two pre_tool_use_request messages
            // with the same canonical toolCallId. Besides wasting a round trip, that
            // makes exact-once lifecycle guards correctly treat the second request as
            // an ambiguous collision. Keep one host admission per SDK invocation.
            const approvedInput = params as Record<string, unknown>;
            // Execute via main process
            const requestId = `proxy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            const result = await waitForProxyToolResponse({
                pending: runtimeState.pendingToolExecutions,
                requestId,
                toolName: def.name,
                args: approvedInput,
                dispatch: () => send({
                    type: 'tool_execute_request',
                    requestId,
                    toolName: def.name,
                    toolCallId,
                    args: approvedInput,
                }),
            });
            return {
                content: [{ type: 'text', text: result.content }],
                details: result.isError || result.structuredContent
                    ? {
                        ...(result.isError ? { isError: true } : {}),
                        ...(result.structuredContent ? { structuredContent: result.structuredContent } : {}),
                    }
                    : undefined,
            };
        },
    }));
}
