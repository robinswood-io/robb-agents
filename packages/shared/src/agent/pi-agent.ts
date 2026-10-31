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
import { type Interface as ReadlineInterface } from "node:readline";
import type { AgentEvent } from "@craft-agent/core/types";
import type { FileAttachment } from "../utils/files.ts";
import { type LongRunningProcessHandle } from "../processes/index.ts";
import type { BackendConfig, BackendRuntimeUpdate, ChatOptions, SdkMcpServerConfig } from "./backend/types.ts";
import { AbortReason } from "./backend/types.ts";
import type { ThinkingLevel } from "./thinking-levels.ts";
// Import models from centralized registry
import { getModelById } from "../config/models.ts";
// BaseAgent provides common functionality
import { BaseAgent } from "./base-agent.ts";
import type { Workspace } from "../config/storage.ts";
// Event adapter
import { PiEventAdapter } from "./backend/pi/event-adapter.ts";
import { EventQueue } from "./backend/event-queue.ts";
import type { ProjectPromptContext } from "../projects/types.ts";
import { type SessionToolContext } from "./claude-context.ts";
// call_llm pre-execution pipeline
// McpClientPool for source tool proxying (centralized pool from main process)
import type { McpClientPool, McpToolResult } from "../mcp/mcp-pool.ts";
// Path utilities
import { join } from "path";
// Error typing
import { type AgentError } from "./errors.ts";
// Centralized PreToolUse pipeline
import { beginContextualGmailHostExecution, confirmContextualGmailRuntimeTeardown, settleContextualGmailHostExecution, type PreToolUseCheckResult } from "./core/pre-tool-use.ts";
// LLM tool types
import { type LLMQueryRequest, type LLMQueryResult } from "./llm-tool.ts";
import { PI_SUBPROCESS_FORCE_KILL_DELAY_MS } from './pi-agent/shared.ts';
import type { PiSubprocessRuntimeContext, PiAuthPayload, TokenRefreshOutcome } from './pi-agent/shared.ts';
import type { PiPendingPermissions, PiPendingToolExecutions, PiPendingMiniCompletions, PiPendingLlmQueries, PiPendingEnsureSessionReady, PiPendingCompactions, PiPendingAutoCompactionToggles, PiPendingRuntimeConfigUpdates, PiPreToolMetadataByCallId, PiBuildAwsEnvRuntimePayload, PiBuildProviderEnvRuntimePayload, PiPreToolUseRequest, PiPreToolUsePrompt, PiSendPreToolUseDecisionRequestPayload, PiToolExecuteRequest, PiSessionToolResult, PiCompactionResult } from './pi-agent/protocol.ts';
import * as piAgentContext from './pi-agent/context.ts';
import * as piAgentSubprocessStart from './pi-agent/subprocess-start.ts';
import * as piAgentAuth from './pi-agent/auth.ts';
import * as piAgentIo from './pi-agent/io.ts';
import * as piAgentEvents from './pi-agent/events.ts';
import * as piAgentSubprocessStop from './pi-agent/subprocess-stop.ts';
import * as piAgentPretool from './pi-agent/pretool.ts';
import * as piAgentPermissionPrompts from './pi-agent/permission-prompts.ts';
import * as piAgentSessionTools from './pi-agent/session-tools.ts';
import * as piAgentRuntime from './pi-agent/runtime.ts';
import * as piAgentChat from './pi-agent/chat.ts';
import * as piAgentLifecycle from './pi-agent/lifecycle.ts';
import * as piAgentMiniCompletion from './pi-agent/mini-completion.ts';
export type { PiSubprocessEnvironmentOptions } from './pi-agent/shared.ts';
export { PI_SUBPROCESS_FORCE_KILL_DELAY_MS, resolvePiSubprocessStartupTimeoutMs, buildPiSubprocessEnvironment, buildPiProviderEnvironment, shouldRefreshPiOAuthBeforeSpawn, PI_BACKEND_SESSION_TOOL_NAMES } from './pi-agent/shared.ts';

/**
 * Backend implementation using the Pi coding agent SDK via subprocess.
 *
 * Spawns a pi-agent-server subprocess and communicates via JSONL protocol.
 * Extends BaseAgent for common functionality (permission mode, source management,
 * planning heuristics, config watching, usage tracking).
 */
export class PiAgent extends BaseAgent {
    protected backendName = 'Robb Agents Backend';
    // ============================================================
    // Subprocess State
    // ============================================================
    // Subprocess process handle
    private subprocess: ChildProcess | null = null;
    /** Exact host runtime generation owning the current subprocess. */
    private subprocessRuntimeContext: PiSubprocessRuntimeContext | null = null;
    /** Retains the generation identity until a late, confirmed child exit arrives. */
    /** @internal */ public subprocessRuntimeContexts = new WeakMap<ChildProcess, PiSubprocessRuntimeContext>();
    /** Diagnostic retained until exit/close proves that the matching child stopped. */
    /** @internal */ public subprocessErrorsAwaitingExit = new WeakMap<ChildProcess, Error>();
    /** @internal */ public subprocessSupervisorHandle: LongRunningProcessHandle | null = null;
    /** Deduplicates concurrent cold-start callers into one process generation. */
    /** @internal */ public subprocessSpawnInFlight: Promise<void> | null = null;
    /** Child processes whose next exit is owner-requested, not a runtime failure. */
    /** @internal */ public expectedSubprocessExits = new WeakSet<ChildProcess>();
    /** One bounded SIGKILL escalation per retiring subprocess generation. */
    /** @internal */ public subprocessForceKillTimers = new WeakMap<ChildProcess, ReturnType<typeof setTimeout>>();
    /** @internal */ public readline: ReadlineInterface | null = null;
    /** @internal */ public subprocessReady: Promise<void> | null = null;
    /** @internal */ public subprocessReadyResolve: (() => void) | null = null;
    /** @internal */ public subprocessReadyReject: ((error: Error) => void) | null = null;
    /** @internal */ public subprocessReadyTimer: ReturnType<typeof setTimeout> | null = null;
    // Pi session ID (managed by subprocess, reported back)
    private piSessionId: string | null = null;
    // State
    private _isProcessing: boolean = false;
    /** @internal */ public abortReason?: AbortReason;
    private promptPreparationRevision = 0;
    // Event adapter
    private adapter: PiEventAdapter;
    // Event queue for streaming (AsyncGenerator pattern over subprocess JSONL)
    private eventQueue = new EventQueue();
    /** Provider-start acknowledgements keyed by the exact child prompt id. */
    /** @internal */ public pendingProviderHandoffs = new Map<string, () => void>();
    /** @internal */ public pendingProviderDispatchRejections = new Map<string, () => void>();
    // Error deduplication — suppress identical consecutive errors after a threshold
    // to prevent a broken subprocess from flooding the user's session.
    /** @internal */ public lastSubprocessError: string | null = null;
    /** @internal */ public subprocessErrorRepeatCount = 0;
    /** @internal */ public static readonly MAX_IDENTICAL_SUBPROCESS_ERRORS = 3;
    /** @internal */ public resolveProjectContext(): ProjectPromptContext | null {
        return piAgentContext.resolveProjectContext(this);
    }
    /** @internal */ public resetSubprocessErrorDedup(): void {
        return piAgentIo.resetSubprocessErrorDedup(this);
    }
    // Ring buffer of recent subprocess stderr. Always on (independent of CRAFT_DEBUG)
    // so that connection-test and other failures can surface what the subprocess
    // actually said, instead of a bare "timed out" with no context.
    /** @internal */ public stderrBuffer: string[] = [];
    /** @internal */ public stderrBufferBytes = 0;
    /** @internal */ public static readonly STDERR_BUFFER_MAX_BYTES = 8 * 1024;
    /** @internal */ public recordStderr(chunk: string): void {
        return piAgentIo.recordStderr(this, PiAgent, chunk);
    }
    /** Returns redacted recent subprocess stderr (up to ~8KB). Empty string if nothing captured. */
    getRecentStderr(): string {
        return piAgentIo.getRecentStderr(this);
    }
    // Pending permission requests (used by handlePreToolUseRequest for ask-mode prompting)
    /** @internal */ public pendingPermissions: Map<string, PiPendingPermissions> = new Map();
    // Pending tool executions (correlation map for subprocess tool_execute_request -> main process -> tool_execute_response)
    /** @internal */ public pendingToolExecutions: Map<string, PiPendingToolExecutions> = new Map();
    // Pending mini completions (correlation map for subprocess mini_completion_result)
    /** @internal */ public pendingMiniCompletions: Map<string, PiPendingMiniCompletions> = new Map();
    // Pending llm_query calls (correlation map for subprocess llm_query_result).
    // Separate from pendingMiniCompletions because the payload shape differs:
    // queryLlm returns a full LLMQueryResult, not just text.
    /** @internal */ public pendingLlmQueries: Map<string, PiPendingLlmQueries> = new Map();
    // Pending ensure_session_ready requests (branch preflight handshake)
    /** @internal */ public pendingEnsureSessionReady: Map<string, PiPendingEnsureSessionReady> = new Map();
    // Pending compact requests (manual compaction RPC)
    /** @internal */ public pendingCompactions: Map<string, PiPendingCompactions> = new Map();
    // Pending auto-compaction toggle requests
    /** @internal */ public pendingAutoCompactionToggles: Map<string, PiPendingAutoCompactionToggles> = new Map();
    // Pending runtime config updates (custom endpoint model capability refresh)
    /** @internal */ public pendingRuntimeConfigUpdates: Map<string, PiPendingRuntimeConfigUpdates> = new Map();
    // Metadata captured before PreToolUse stripping, keyed by toolCallId.
    // This provides a deterministic bridge when side-channel metadata store misses.
    private preToolMetadataByCallId: Map<string, PiPreToolMetadataByCallId> = new Map();
    // Pool reference for convenience (from this.config.mcpPool)
    /** @internal */ public get mcpPool(): McpClientPool | undefined { return this.config.mcpPool; }
    // Cached session tool context (lazy-created on first session tool call)
    /** @internal */ public _sessionToolContext: SessionToolContext | null = null;
    // RPC request counter for unique IDs
    /** @internal */ public rpcIdCounter: number = 0;
    // OAuth token refresh (ChatGPT Plus)
    /**
     * @deprecated Use onBackendAuthRequired (inherited from BaseAgent) instead.
     * Kept as a getter/setter alias for backward compatibility.
     */
    get onChatGptAuthRequired(): ((reason: string) => void) | null {
        return this.onBackendAuthRequired;
    }
    set onChatGptAuthRequired(cb: ((reason: string) => void) | null) {
        this.onBackendAuthRequired = cb;
    }
    // Global mutex: keyed by connectionSlug so multiple PiAgent instances
    // sharing the same connection don't race concurrent token refreshes.
    /** @internal */ public static globalRefreshMutex: Map<string, Promise<TokenRefreshOutcome>> = new Map();
    // ============================================================
    // Constructor
    // ============================================================
    constructor(config: BackendConfig) {
        const resolvedModel = config.model || '';
        const modelDef = getModelById(resolvedModel);
        super(config, resolvedModel, modelDef?.contextWindow);
        this._supportsBranching = true;
        this.piSessionId = config.session?.sdkSessionId || null;
        this.adapter = new PiEventAdapter();
        if (modelDef?.contextWindow) {
            this.adapter.setContextWindow(modelDef.contextWindow);
        }
        this.adapter.setCallLlmModel(this.getModel());
        // Set session dir on adapter for concurrent-safe toolMetadataStore lookups
        if (config.session?.id && config.workspace.rootPath) {
            this.adapter.setSessionDir(join(config.workspace.rootPath, 'sessions', config.session.id));
        }
        if (!config.isHeadless) {
            this.startConfigWatcher();
        }
    }
    /** @internal */ public assertBackendSessionToolParity(): void {
        return piAgentSubprocessStart.assertBackendSessionToolParity(this);
    }
    /** @internal */ public async ensureSubprocess(): Promise<void> {
        return piAgentSubprocessStart.ensureSubprocess(this);
    }
    /** @internal */ public async spawnSubprocess(): Promise<void> {
        return piAgentSubprocessStart.spawnSubprocess(this, PiAgent);
    }
    private registerPoolToolsWithSubprocess(): void {
        return piAgentSubprocessStart.registerPoolToolsWithSubprocess(this);
    }
    /** @internal */ public async getPiAuth(): Promise<PiAuthPayload | null> {
        return piAgentAuth.getPiAuth(this);
    }
    /** @internal */ public buildAwsEnv(piAuth: Awaited<ReturnType<PiAgent['getPiAuth']>>, runtime: PiBuildAwsEnvRuntimePayload): Record<string, string> {
        return piAgentAuth.buildAwsEnv(this, piAuth, runtime);
    }
    /** @internal */ public buildProviderEnv(runtime: PiBuildProviderEnvRuntimePayload): Record<string, string> {
        return piAgentAuth.buildProviderEnv(this, runtime);
    }
    /** @internal */ public async refreshAndPushTokens(): Promise<void> {
        return piAgentAuth.refreshAndPushTokens(this, PiAgent);
    }
    /** @internal */ public async getApiKey(): Promise<string | null> {
        return piAgentAuth.getApiKey(this);
    }
    private send(cmd: Record<string, unknown>): boolean {
        return piAgentIo.send(this, cmd);
    }
    /** @internal */ public sendForRuntime(cmd: Record<string, unknown>, runtimeContext?: PiSubprocessRuntimeContext): boolean {
        return piAgentIo.sendForRuntime(this, cmd, runtimeContext);
    }
    /** @internal */ public isRuntimeCurrent(runtimeContext?: PiSubprocessRuntimeContext): boolean {
        return piAgentIo.isRuntimeCurrent(this, runtimeContext);
    }
    /** @internal */ public handleLine(line: string, child?: ChildProcess, runtimeContext?: PiSubprocessRuntimeContext): void {
        return piAgentEvents.handleLine(this, PiAgent, line, child, runtimeContext);
    }
    /** @internal */ public handleSubprocessEvent(event: Record<string, unknown>): void {
        return piAgentEvents.handleSubprocessEvent(this, event);
    }
    /** @internal */ public async handlePreToolUseRequest(req: PiPreToolUseRequest, runtimeContext?: PiSubprocessRuntimeContext): Promise<void> {
        return piAgentPretool.handlePreToolUseRequest(this, req, runtimeContext);
    }
    /** @internal */ public async handlePreToolUsePrompt(requestId: string, toolName: string, toolInput: Record<string, unknown>, sessionId: string, checkResult: Extract<PreToolUseCheckResult, PiPreToolUsePrompt>, toolUseId?: string, runtimeContext?: PiSubprocessRuntimeContext, authorizationEpoch = this.promptPreparationRevision): Promise<void> {
        return piAgentPermissionPrompts.handlePreToolUsePrompt(this, requestId, toolName, toolInput, sessionId, checkResult, authorizationEpoch, toolUseId, runtimeContext);
    }
    /** @internal */ public resolveContextualGmailPromptDecision(sessionId: string, toolName: string, toolInput: Record<string, unknown>, toolUseId: string | undefined, approved: boolean) {
        return piAgentPretool.resolveContextualGmailPromptDecision(this, sessionId, toolName, toolInput, toolUseId, approved);
    }
    /** @internal */ public sendPreToolUseDecision(request: PiSendPreToolUseDecisionRequestPayload, decision: Record<string, unknown>): void {
        return piAgentPermissionPrompts.sendPreToolUseDecision(this, request, decision);
    }
    /** @internal */ public async handleToolExecuteRequest(request: PiToolExecuteRequest, runtimeContext?: PiSubprocessRuntimeContext): Promise<void> {
        return piAgentSessionTools.handleToolExecuteRequest(this, request, runtimeContext);
    }
    /** @internal */ public async routeToolCall(toolName: string, args: Record<string, unknown>, toolUseId?: string, runtimeContext?: PiSubprocessRuntimeContext, hostExecutionClaimed = false): Promise<McpToolResult> {
        return piAgentSessionTools.routeToolCall(this, toolName, args, hostExecutionClaimed, toolUseId, runtimeContext);
    }
    /** @internal */ public beginContextualGmailHostExecution(input: Parameters<typeof beginContextualGmailHostExecution>[0]): ReturnType<typeof beginContextualGmailHostExecution> {
        return piAgentPretool.beginContextualGmailHostExecutionOperation(this, input);
    }
    /** @internal */ public settleContextualGmailHostExecution(ticket: Parameters<typeof settleContextualGmailHostExecution>[0]): boolean {
        return piAgentPretool.settleContextualGmailHostExecutionOperation(this, ticket);
    }
    /** @internal */ public confirmContextualGmailRuntimeTeardown(runtimeContext: Parameters<typeof confirmContextualGmailRuntimeTeardown>[0]): boolean {
        return piAgentPretool.confirmContextualGmailRuntimeTeardownOperation(this, runtimeContext);
    }
    /** @internal */ public getSessionToolContext(): SessionToolContext {
        return piAgentSessionTools.getSessionToolContext(this);
    }
    /** @internal */ public async executeSessionTool(toolName: string, args: Record<string, unknown>): Promise<PiSessionToolResult> {
        return piAgentSessionTools.executeSessionTool(this, toolName, args);
    }
    /** @internal */ public handleSessionToolCompleted(msg: Record<string, unknown>): void {
        return piAgentSessionTools.handleSessionToolCompleted(this, msg);
    }
    /** @internal */ public handleMiniCompletionResult(msg: Record<string, unknown>): void {
        return piAgentSessionTools.handleMiniCompletionResult(this, msg);
    }
    /** @internal */ public handleEnsureSessionReadyResult(msg: Record<string, unknown>): void {
        return piAgentRuntime.handleEnsureSessionReadyResult(this, msg);
    }
    /** @internal */ public handleCompactResult(msg: Record<string, unknown>): void {
        return piAgentRuntime.handleCompactResult(this, msg);
    }
    /** @internal */ public handleSetAutoCompactionResult(msg: Record<string, unknown>): void {
        return piAgentRuntime.handleSetAutoCompactionResult(this, msg);
    }
    /** @internal */ public handleRuntimeConfigUpdateResult(msg: Record<string, unknown>): void {
        return piAgentRuntime.handleRuntimeConfigUpdateResult(this, msg);
    }
    /** @internal */ public hasPendingSubprocessWork(): boolean {
        return piAgentIo.hasPendingSubprocessWork(this);
    }
    /** @internal */ public clearSubprocessReadyTimer(): void {
        return piAgentIo.clearSubprocessReadyTimer(this);
    }
    /** @internal */ public resolveSubprocessReady(): void {
        return piAgentIo.resolveSubprocessReady(this);
    }
    /** @internal */ public rejectSubprocessReady(error: Error): void {
        return piAgentIo.rejectSubprocessReady(this, error);
    }
    /** @internal */ public handleSubprocessError(error: Error, child: ChildProcess, runtimeContext?: PiSubprocessRuntimeContext): void {
        return piAgentSubprocessStop.handleSubprocessError(this, error, child, runtimeContext);
    }
    /** @internal */ public handleSubprocessExit(code: number | null, signal: string | null, child?: ChildProcess, processError?: Error, runtimeContext?: PiSubprocessRuntimeContext): void {
        return piAgentSubprocessStop.handleSubprocessExit(this, code, signal, child, processError, runtimeContext);
    }
    /** @internal */ public async requestEnsureSessionReady(): Promise<string | null> {
        return piAgentRuntime.requestEnsureSessionReady(this);
    }
    /** @internal */ public async requestCompact(customInstructions?: string): Promise<PiCompactionResult | null> {
        return piAgentRuntime.requestCompact(this, customInstructions);
    }
    /** Host-triggered bounded-context compaction used by the session cost controller. */
    async compactContext(customInstructions?: string): Promise<PiCompactionResult | null> {
        return piAgentRuntime.compactContext(this, customInstructions);
    }
    /** @internal */ public async requestSetAutoCompaction(enabled: boolean): Promise<boolean> {
        return piAgentRuntime.requestSetAutoCompaction(this, enabled);
    }
    /** @internal */ public async requestRuntimeConfigUpdate(update: BackendRuntimeUpdate): Promise<boolean> {
        return piAgentRuntime.requestRuntimeConfigUpdate(this, update);
    }
    /**
     * Ensure branched Pi sessions are backend-ready before first user message.
     * Called by SessionManager during branch creation to avoid creating
     * transcript-only branches without real Pi session context.
     */
    override async ensureBranchReady(): Promise<void> {
        return piAgentRuntime.ensureBranchReady(this);
    }
    protected async *chatImpl(messageParam: string, attachments?: FileAttachment[], options?: ChatOptions): AsyncGenerator<AgentEvent, void, unknown> {
        return yield* piAgentChat.chatImpl(this, PiAgent, messageParam, attachments, options);
    }
    // ============================================================
    // Permission Handling
    // ============================================================
    /**
     * Respond to a pending permission request.
     * Permission checking now happens in the main process, so this resolves locally.
     */
    respondToPermission(requestId: string, allowed: boolean, _alwaysAllow?: boolean): void {
        return piAgentPermissionPrompts.respondToPermission(this, requestId, allowed, _alwaysAllow);
    }
    // ============================================================
    // Model Forwarding
    // ============================================================
    async updateRuntimeConfig(update: BackendRuntimeUpdate): Promise<boolean> {
        return piAgentRuntime.updateRuntimeConfig(this, update);
    }
    override setModel(model: string): void {
        const previousModel = this.getModel();
        super.setModel(model);
        this.adapter.setCallLlmModel(model);
        // Forward to subprocess so it uses the new model on next turn
        if (this.subprocess) {
            this.debug(`Forwarding model change to subprocess: ${previousModel} → ${model}`);
            this.send({ type: 'set_model', model });
        }
        else {
            this.debug(`Model updated but no subprocess to forward to: ${previousModel} → ${model}`);
        }
    }
    override setThinkingLevel(level: ThinkingLevel): void {
        const previousLevel = this.getThinkingLevel();
        super.setThinkingLevel(level);
        // Forward to subprocess so it uses the new thinking level on next turn
        if (this.subprocess) {
            this.debug(`Forwarding thinking level change to subprocess: ${previousLevel} → ${level}`);
            this.send({ type: 'set_thinking_level', level });
        }
        else {
            this.debug(`Thinking level updated but no subprocess to forward to: ${previousLevel} → ${level}`);
        }
    }
    // ============================================================
    // Source / MCP Integration
    // ============================================================
    override async setSourceServers(mcpServers: Record<string, SdkMcpServerConfig>, apiServers: Record<string, unknown>, intendedSlugs?: string[]): Promise<void> {
        // BaseAgent.setSourceServers() handles:
        //   1. SourceManager state tracking (active slugs)
        //   2. McpClientPool sync (connecting/disconnecting MCP + API sources)
        await super.setSourceServers(mcpServers, apiServers, intendedSlugs);
        // Register pool's proxy tool defs with subprocess so the model can call them.
        this.registerPoolToolsWithSubprocess();
    }
    /** @internal */ public invalidateContextualGmailStateForCurrentSession(): void {
        return piAgentPretool.invalidateContextualGmailStateForCurrentSession(this);
    }
    /** @internal */ public hasContextualGmailInFlightForCurrentRuntime(): boolean {
        return piAgentPretool.hasContextualGmailInFlightForCurrentRuntime(this);
    }
    /** @internal */ public denyAllPendingPermissions(): void {
        return piAgentPermissionPrompts.denyAllPendingPermissions(this);
    }
    isProcessing(): boolean {
        return this._isProcessing;
    }
    async abort(reason?: string): Promise<void> {
        return piAgentLifecycle.abort(this, reason);
    }
    forceAbort(reason: AbortReason): void {
        return piAgentLifecycle.forceAbort(this, reason);
    }
    /**
     * Redirect mid-stream via Pi SDK's steer().
     * Delivers the message after the current tool finishes, skips remaining
     * queued tools, and continues with full context intact.
     * Events flow through the existing generator — no abort needed.
     */
    override redirect(message: string): boolean {
        return piAgentLifecycle.redirect(this, message);
    }
    // ============================================================
    // Session ID overrides — Pi maintains its own subprocess session id
    // ============================================================
    override getSessionId(): string | null {
        return this.piSessionId;
    }
    override setSessionId(sessionId: string | null): void {
        this.piSessionId = sessionId;
    }
    override setWorkspace(workspace: Workspace): void {
        super.setWorkspace(workspace);
        this.piSessionId = null;
        this._sessionToolContext = null;
        this.killSubprocess();
    }
    override clearHistory(): void {
        this.piSessionId = null;
        this.killSubprocess();
        super.clearHistory();
        this.debug('History cleared - next chat will start new subprocess');
    }
    override destroy(): void {
        return piAgentLifecycle.destroy(this);
    }
    async disposeForRestart(): Promise<void> {
        return piAgentLifecycle.disposeForRestart(this);
    }
    /**
     * Reconnect by killing subprocess -- next chat() will spawn fresh.
     */
    async reconnect(): Promise<void> {
        return piAgentLifecycle.reconnect(this);
    }
    /** @internal */ public async killSubprocessGracefully(timeoutMs = 2000): Promise<void> {
        return piAgentSubprocessStop.killSubprocessGracefully(this, timeoutMs);
    }
    /** @internal */ public scheduleSubprocessForceKill(child: ChildProcess, runtimeContext?: PiSubprocessRuntimeContext, delayMs = PI_SUBPROCESS_FORCE_KILL_DELAY_MS): void {
        return piAgentSubprocessStop.scheduleSubprocessForceKill(this, child, delayMs, runtimeContext);
    }
    private killSubprocess(): void {
        return piAgentSubprocessStop.killSubprocess(this);
    }
    // ============================================================
    // Mini Completion (for title generation + summarization)
    // ============================================================
    /**
     * Run a simple text completion via the subprocess.
     * Sends a mini_completion request and waits for the result.
     */
    async runMiniCompletion(prompt: string): Promise<string | null> {
        return piAgentMiniCompletion.runMiniCompletion(this, prompt);
    }
    /**
     * Execute an LLM query via the subprocess.
     * Used by session-scoped tool callbacks (call_llm).
     *
     * Sends the full LLMQueryRequest over the `llm_query` RPC so the subprocess's
     * model-aware queryLlm() can honor `request.model`, `request.systemPrompt`,
     * and (transitively via buildCallLlmRequest) `request.outputSchema`.
     * See packages/shared/CLAUDE.md → "queryLlm backend contract" and
     * packages/pi-agent-server/src/index.ts → handleLlmQuery for the invariant.
     */
    async queryLlm(request: LLMQueryRequest): Promise<LLMQueryResult> {
        return piAgentMiniCompletion.queryLlm(this, request);
    }
    /** @internal */ public resolvedCwd(): string {
        return piAgentContext.resolvedCwd(this);
    }
    /** @internal */ public parsePiError(error: Error): AgentError {
        return piAgentContext.parsePiError(this, error);
    }
    protected override debug(message: string): void {
        return piAgentContext.debug(this, message);
    }
}
// Alias for consistency with other backend naming
export { PiAgent as PiBackend };
