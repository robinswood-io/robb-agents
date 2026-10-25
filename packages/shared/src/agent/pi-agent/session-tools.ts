import { SpawnSessionInputError } from "@craft-agent/session-tools-core";
// Session-scoped tool callbacks (for SubmitPlan, source auth, etc.)
import { setLastPlanFilePath, getSessionScopedToolCallbacks } from "../session-scoped-tools.ts";
import { attachSessionSelfManagementBindings } from "../session-self-management-bindings.ts";
// Session tool proxy definitions (for registering with subprocess)
import { SESSION_TOOL_NAMES } from "../backend/pi/session-tool-defs.ts";
// Session tool registry (for executing proxy tool calls)
import { SESSION_TOOL_REGISTRY, type ToolResult as SessionToolResult } from "@craft-agent/session-tools-core";
import { createClaudeContext, type SessionToolContext } from "../claude-context.ts";
// call_llm pre-execution pipeline
// McpClientPool for source tool proxying (centralized pool from main process)
import type { McpToolResult } from "../../mcp/mcp-pool.ts";
// Session storage (plans folder path)
import { getSessionPath } from "../../sessions/storage.ts";
import { executeBrowserToolCommand } from "../browser-tool-runtime.ts";
import { saveBinaryResponse } from "../../utils/binary-detection.ts";
import type { PiAgent } from '../pi-agent.ts';
import { mapBrowserToolErrorCode } from './shared.ts';
import type { PiSubprocessRuntimeContext } from './shared.ts';
import type { PiToolExecuteRequest, PiSessionToolResult } from './protocol.ts';

/**
   * Handle a tool_execute_request from the subprocess.
   * Routes proxy tool calls (MCP, API, session) to the appropriate handler.
   *
   * The subprocess expects responses in the format:
   *   { content: string; isError: boolean }
   */
export async function handleToolExecuteRequest(transportOwner: PiAgent, request: PiToolExecuteRequest, runtimeContext?: PiSubprocessRuntimeContext): Promise<void> {
    if (!transportOwner["isRuntimeCurrent"](runtimeContext))
        return;
    const respond = (message: Record<string, unknown>) => {
        transportOwner["sendForRuntime"](message, runtimeContext);
    };
    const sessionId = runtimeContext?.sessionId
        ?? transportOwner["config"].session?.id
        ?? transportOwner["_sessionId"];
    const runtimeId = runtimeContext?.runtimeId
        ?? transportOwner["subprocessRuntimeContext"]?.runtimeId
        ?? '';
    if (!transportOwner["beginAdmittedToolExecution"]({
        toolUseId: request.toolCallId,
        toolName: request.toolName,
        toolInput: request.args,
        sessionId,
        runtimeId,
        authorizationEpoch: transportOwner["promptPreparationRevision"],
    })) {
        respond({
            type: 'tool_execute_response',
            requestId: request.requestId,
            result: {
                content: 'The host did not find one exact current PreToolUse admission for this execution. The tool was not executed.',
                isError: true,
            },
        });
        return;
    }
    // Claim a bound Gmail invocation before any local routing branch. Even if
    // prerequisites changed or the proxy disappeared after PreToolUse, the
    // exact reservation must reach a terminal state instead of remaining
    // locked forever.
    const hostGuard = transportOwner["beginContextualGmailHostExecution"]({
        sessionId,
        runtimeId,
        toolUseId: request.toolCallId,
        toolName: request.toolName,
        toolInput: request.args,
    });
    if (hostGuard.applies && !hostGuard.allowed) {
        transportOwner["settleAdmittedToolExecution"](request.toolCallId);
        respond({
            type: 'tool_execute_response',
            requestId: request.requestId,
            result: { content: hostGuard.reason, isError: true },
        });
        return;
    }
    const ticket = hostGuard.applies && hostGuard.allowed
        ? hostGuard.ticket
        : undefined;
    try {
        // Prerequisite check: block source tools until guide.md is read
        const prereqResult = transportOwner["prerequisiteManager"].checkPrerequisites(request.toolName);
        if (!prereqResult.allowed) {
            respond({
                type: 'tool_execute_response',
                requestId: request.requestId,
                result: { content: prereqResult.blockReason!, isError: true },
            });
            return;
        }
        const result = await transportOwner["routeToolCall"](request.toolName, request.args, request.toolCallId, runtimeContext, hostGuard.applies);
        respond({
            type: 'tool_execute_response',
            requestId: request.requestId,
            result,
        });
    }
    catch (error) {
        respond({
            type: 'tool_execute_response',
            requestId: request.requestId,
            result: {
                content: error instanceof Error ? error.message : String(error),
                isError: true,
            },
        });
    }
    finally {
        transportOwner["settleAdmittedToolExecution"](request.toolCallId);
        if (ticket && !transportOwner["settleContextualGmailHostExecution"](ticket)) {
            transportOwner["debug"](`Gmail host execution ticket was already settled or invalid for ${request.toolName}`);
        }
    }
}

/**
   * Route a proxy tool call to the appropriate handler based on tool name.
   *
   * - Session tools (SubmitPlan, config_validate, etc.) -> session-tools-core handlers
   * - call_llm -> preExecuteCallLlm (BaseAgent)
   * - mcp__* tools -> MCP server proxy (TODO)
   * - api_* tools -> API source proxy (TODO)
   *
   * Returns { content: string; isError: boolean } matching subprocess protocol.
   */
export async function routeToolCall(transportOwner: PiAgent, toolName: string, args: Record<string, unknown>, hostExecutionClaimed: boolean, toolUseId?: string, runtimeContext?: PiSubprocessRuntimeContext): Promise<McpToolResult> {
    // Session-scoped tools — strip mcp__session__ prefix added by the Pi SDK
    // registration (tools are registered as mcp__session__SubmitPlan, etc.)
    const strippedName = toolName.startsWith('mcp__session__')
        ? toolName.slice('mcp__session__'.length)
        : toolName;
    if (SESSION_TOOL_NAMES.has(strippedName)) {
        return transportOwner["executeSessionTool"](strippedName, args);
    }
    // MCP source tools — route through centralized pool
    if (transportOwner["mcpPool"]?.isProxyTool(toolName)) {
        if (hostExecutionClaimed) {
            return transportOwner["mcpPool"].callTool(toolName, args);
        }
        const sessionId = runtimeContext?.sessionId
            ?? transportOwner["config"].session?.id
            ?? transportOwner["_sessionId"];
        const runtimeId = runtimeContext?.runtimeId
            ?? transportOwner["subprocessRuntimeContext"]?.runtimeId
            ?? '';
        const hostGuard = transportOwner["beginContextualGmailHostExecution"]({
            sessionId,
            runtimeId,
            toolUseId,
            toolName,
            toolInput: args,
        });
        if (hostGuard.applies && !hostGuard.allowed) {
            return {
                content: hostGuard.reason,
                isError: true,
            };
        }
        const ticket = hostGuard.applies && hostGuard.allowed
            ? hostGuard.ticket
            : undefined;
        try {
            return await transportOwner["mcpPool"].callTool(toolName, args);
        }
        finally {
            if (ticket && !transportOwner["settleContextualGmailHostExecution"](ticket)) {
                transportOwner["debug"](`Gmail host execution ticket was already settled or invalid for ${toolName}`);
            }
        }
    }
    // Unknown tool
    return {
        content: `Unknown proxy tool: ${toolName}`,
        isError: true,
    };
}

/**
   * Get or create a SessionToolContext for executing session-scoped tools.
   * Cached per agent instance since the workspace/session don't change.
   */
export function getSessionToolContext(transportOwner: PiAgent): SessionToolContext {
    if (transportOwner["_sessionToolContext"])
        return transportOwner["_sessionToolContext"];
    const sessionId = transportOwner["config"].session?.id || '';
    const workspacePath = transportOwner["config"].workspace.rootPath;
    const workspaceId = transportOwner["config"].workspace.id;
    transportOwner["_sessionToolContext"] = createClaudeContext({
        sessionId,
        workspacePath,
        workspaceId,
        onPlanSubmitted: (planPath: string) => {
            setLastPlanFilePath(sessionId, planPath);
            transportOwner["onPlanSubmitted"]?.(planPath);
        },
        onAuthRequest: (request) => {
            transportOwner["onAuthRequest"]?.(request);
        },
    });
    // Attach session self-management bindings (lazy getters from callback registry)
    attachSessionSelfManagementBindings(transportOwner["_sessionToolContext"], sessionId);
    return transportOwner["_sessionToolContext"];
}

/**
   * Execute a session-scoped tool by name.
   * Uses the canonical registry from @craft-agent/session-tools-core.
   */
export async function executeSessionTool(transportOwner: PiAgent, toolName: string, args: Record<string, unknown>): Promise<PiSessionToolResult> {
    try {
        // call_llm uses the shared pre-execution pipeline from BaseAgent
        if (toolName === 'call_llm') {
            try {
                const result = await transportOwner["preExecuteCallLlm"](args);
                return { content: result.text || '(Model returned empty response)', isError: false };
            }
            catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                return { content: `call_llm failed: ${msg}`, isError: true };
            }
        }
        // spawn_session uses the shared pre-execution pipeline from BaseAgent
        if (toolName === 'spawn_session') {
            try {
                const result = await transportOwner["preExecuteSpawnSession"](args);
                return { content: JSON.stringify(result, null, 2), isError: false };
            }
            catch (error) {
                if (error instanceof SpawnSessionInputError) {
                    return { content: JSON.stringify(error), isError: true };
                }
                const msg = error instanceof Error ? error.message : String(error);
                return { content: `spawn_session failed: ${msg}`, isError: true };
            }
        }
        // browser_tool — single CLI-like tool for all browser actions
        if (toolName === 'browser_tool') {
            const callbacks = getSessionScopedToolCallbacks(transportOwner["_sessionId"]);
            const browserFns = callbacks?.browserPaneFns;
            if (!browserFns) {
                return { content: 'Browser window controls are not available. This tool requires the desktop app.', isError: true };
            }
            try {
                const result = await executeBrowserToolCommand({
                    command: (args.command as string | string[]) ?? '',
                    fns: browserFns,
                    sessionId: transportOwner["_sessionId"],
                });
                let content = result.output;
                if (result.image) {
                    const sessionPath = getSessionPath(transportOwner["config"].workspace.rootPath, transportOwner["_sessionId"]);
                    const imageBuffer = Buffer.from(result.image.data, 'base64');
                    const ext = result.image.mimeType === 'image/jpeg' ? 'jpg' : 'png';
                    const saved = saveBinaryResponse(sessionPath, `browser-screenshot.${ext}`, imageBuffer, result.image.mimeType);
                    if (saved.type === 'file_download') {
                        content += [
                            '',
                            `Saved screenshot: ${saved.path}`,
                            '',
                            '```image-preview',
                            JSON.stringify({
                                src: saved.path,
                                title: 'Browser Screenshot',
                            }, null, 2),
                            '```',
                        ].join('\n');
                    }
                    else {
                        content += `\n\n[Screenshot captured (${Math.round(result.image.sizeBytes / 1024)}KB ${result.image.mimeType}) but failed to save: ${saved.error}]`;
                    }
                }
                return { content, isError: false };
            }
            catch (error) {
                // Branch on `err.code` (string), not `instanceof CodedError` — the
                // transport reconstructs a plain Error on the receiving side, so
                // class identity is lost across the wire.
                const rawCode = (error as {
                    code?: unknown;
                } | null)?.code;
                const code = typeof rawCode === 'string' ? rawCode : '';
                const msg = error instanceof Error ? error.message : String(error);
                const friendly = mapBrowserToolErrorCode(code) ?? msg;
                return { content: friendly, isError: true };
            }
        }
        const def = SESSION_TOOL_REGISTRY.get(toolName);
        if (!def) {
            return { content: `Unknown session tool: ${toolName}`, isError: true };
        }
        if (!def.handler) {
            return {
                content: `Session tool '${toolName}' is backend-executed (${def.executionMode}) but has no PiAgent adapter implementation.`,
                isError: true,
            };
        }
        const ctx = transportOwner["getSessionToolContext"]();
        const result: SessionToolResult = await def.handler(ctx, args);
        // Convert ToolResult to subprocess response format
        const text = result.content.map(c => c.text).join('\n');
        return { content: text, isError: !!result.isError };
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        transportOwner["debug"](`Session tool ${toolName} failed: ${msg}`);
        return { content: `Session tool error: ${msg}`, isError: true };
    }
}

/**
   * Handle session_tool_completed from subprocess.
   *
   * NOTE: For proxy-executed session tools, callbacks (onPlanSubmitted, etc.)
   * are already fired by executeSessionTool() via the SessionToolContext.
   * The subprocess sends this event because handleSessionEvent() detects the
   * mcp__session__ prefix, but we intentionally skip handleSessionMcpToolCompletion()
   * here to avoid double-firing callbacks.
   */
export function handleSessionToolCompleted(transportOwner: PiAgent, msg: Record<string, unknown>): void {
    const toolName = msg.toolName as string;
    const isError = msg.isError as boolean;
    transportOwner["debug"](`Session tool completed: ${toolName} (isError=${isError})`);
    // Callbacks already handled by executeSessionTool() — no-op.
}

/**
   * Handle mini_completion_result from subprocess.
   */
export function handleMiniCompletionResult(transportOwner: PiAgent, msg: Record<string, unknown>): void {
    const id = msg.id as string;
    const text = msg.text as string | null;
    const pending = transportOwner["pendingMiniCompletions"].get(id);
    if (pending) {
        transportOwner["pendingMiniCompletions"].delete(id);
        pending.resolve(text);
    }
}
