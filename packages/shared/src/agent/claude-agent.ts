import "node:crypto";
import "./claude-process.ts";
import "@anthropic-ai/claude-agent-sdk";
import "./options.ts";
import "zod";
import "../prompts/system.ts";
import { BaseAgent, type MiniAgentConfig } from "./base-agent.ts";
import "./backend/types.ts";
import "./errors.ts";
import "./claude-sdk-error-mapper.ts";
import "./diagnostics.ts";
import { loadConfigDefaults, type Workspace } from "../config/storage.ts";
import "../auth/state.ts";
import "../config/llm-connections.ts";
import "../projects/storage.ts";
import { DEFAULT_MODEL, getModelContextWindow } from "../config/models.ts";
import "../credentials/index.ts";
import "../config/preferences.ts";
import "../utils/paths.ts";
import "./claude-llm-query.ts";
import { debug } from "../utils/debug.ts";
import "../utils/large-response.ts";
import "./source-activation-drain.ts";
import { resolveKeepBackgroundTasksAlive, type PushableInputStream } from "./backend/claude/persistent-input.ts";
import { registerSessionScopedToolCallbacks, type AuthRequest } from "./session-scoped-tools.ts";
import { initializeModeState, type PermissionMode } from "./mode-manager.ts";
import { getSessionPath } from "../sessions/storage.ts";
import "../interceptor-common.ts";
import "../utils/workspace.ts";
import "./core/pre-tool-use.ts";
import "./core/rtk-detector.ts";
import "../config/storage.ts";
import "./thinking-levels.ts";
import "./conversation-summary.ts";
import "./compact-command.ts";
import "node:fs";
import "node:fs/promises";
import { isExistingDirectory } from "./spawn-helpers.ts";
import "../utils/files.ts";
export {
  // Permission mode API
  getPermissionMode,
  setPermissionMode,
  cyclePermissionMode,
  subscribeModeChanges,
  type PermissionMode,
  PERMISSION_MODE_ORDER,
  PERMISSION_MODE_CONFIG,
} from './mode-manager.ts';
import "./tool-matching.ts";
import { ClaudeEventAdapter } from "./backend/claude/event-adapter.ts";
import { AbortReason, type RecoveryMessage } from "./core/index.ts";

import { type Query, type SDKMessage, type SDKUserMessage, type SDKAssistantMessageError, type Options } from "@anthropic-ai/claude-agent-sdk";

import { type BackendConfig, type PostInitResult } from "./backend/types.ts";
import { type ClaudeSdkApiError } from "./claude-sdk-error-mapper.ts";


import type { FileAttachment } from "../utils/files.ts";
import type { LLMQueryRequest, LLMQueryResult } from "./llm-tool.ts";



import { type SdkAutomationCallbackMatcher } from "../automations/index.ts";


// Centralized PreToolUse pipeline
// Centralized PreToolUse pipeline
import { confirmContextualGmailRuntimeTeardown } from "./core/pre-tool-use.ts";
import type { LoadedSource } from "../sources/types.ts";
import type { ChatOptions } from "./backend/types.ts";

// Documentation is served via local files at ~/.craft-agent/docs/
// Import and re-export AgentEvent from core (single source of truth)
// Documentation is served via local files at ~/.craft-agent/docs/
// Import and re-export AgentEvent from core (single source of truth)
import type { AgentEvent } from "@craft-agent/core/types";
// Stateless tool matching — pure functions for SDK message → AgentEvent conversion
// Stateless tool matching — pure functions for SDK message → AgentEvent conversion
import { ToolIndex } from "./tool-matching.ts";
// Claude event adapter — extracts SDK message → AgentEvent conversion into testable class
// Claude event adapter — extracts SDK message → AgentEvent conversion into testable class

// Import and re-export AbortReason and RecoveryMessage from core module (single source of truth)
// Re-exported for backwards compatibility with existing imports from claude-agent.ts
// Import and re-export AbortReason and RecoveryMessage from core module (single source of truth)
// Re-exported for backwards compatibility with existing imports from claude-agent.ts

import { createClaudeBackendConfig } from './claude-agent/shared.ts';
import type { ClaudeAgentConfig, PendingPermission, SourceProxyGmailLifecycleContext, ClaudeQueryPreparation, ClaudeQueryFailureContext } from './claude-agent/shared.ts';
import type { ClaudeOnPermissionRequest, ClaudeOnUsageUpdate, ClaudeCheckToolPermissionResult, ClaudeMapSDKErrorToTypedErrorResult, ClaudeDetectInactiveSourceToolErrorResult, ClaudeResolveSpawnCwdInputPayload } from './claude-agent/protocol.ts';
import * as claudeAgentPersistentRuntime from './claude-agent/persistent-runtime.ts';
import * as claudeAgentInitialization from './claude-agent/initialization.ts';
import * as claudeAgentPermissions from './claude-agent/permissions.ts';
import * as claudeAgentPreToolUse from './claude-agent/pre-tool-use.ts';
import * as claudeAgentSdkOptions from './claude-agent/sdk-options.ts';
import * as claudeAgentPreparation from './claude-agent/preparation.ts';
import * as claudeAgentResponse from './claude-agent/response.ts';
import * as claudeAgentRecovery from './claude-agent/recovery.ts';
import * as claudeAgentMessages from './claude-agent/messages.ts';
import * as claudeAgentInterrupt from './claude-agent/interrupt.ts';
import * as claudeAgentWorkspace from './claude-agent/workspace.ts';
import * as claudeAgentBranches from './claude-agent/branches.ts';
export type { ClaudeAgentConfig } from './claude-agent/shared.ts';
export { shouldAutomaticallyRecoverClaudeProcessInterruption, resolveClaudeThinkingOptions, resolveClaudeCallLlmInterceptInput, resolveClaudeNestedQueryModel, resolveClaudeMiniCompletionRoute, setGlobalPermissionHandler, requestToolPermission, resolveGlobalPermission, clearGlobalPermissions, executeSourceProxyCall } from './claude-agent/shared.ts';

export class ClaudeAgent extends BaseAgent {
    protected backendName = 'Claude';
    // Note: ClaudeAgentConfig is compatible with BackendConfig, so we use the inherited this.config
    private currentQuery: Query | null = null;
    private currentQueryAbortController: AbortController | null = null;
    private lastAbortReason: AbortReason | null = null;
    private promptPreparationRevision = 0;
    private persistentGmailRuntimeId: string | null = null;
    private persistentGmailSessionId: string | null = null;
    private activeTurnGmailRuntime: SourceProxyGmailLifecycleContext | null = null;
    private sessionId: string | null = null;
    // Whether the most recent user turn included image/PDF attachments. Read by
    // mapSDKErrorToTypedError to decide whether attachment-related hints belong
    // in the invalid_request error message.
    private lastTurnHadAttachments: boolean = false;
    private branchFromSdkSessionId: string | null = null;
    private branchFromSdkCwd: string | null = null;
    private branchFromSdkTurnId: string | null = null;
    private isHeadless: boolean = false;
    private pendingPermissions: Map<string, PendingPermission> = new Map();
    // Permission whitelists are now managed by this.permissionManager (inherited from BaseAgent)
    // Source state tracking is now managed by this.sourceManager (inherited from BaseAgent)
    // Source MCP connections are managed by this.config.mcpPool (centralized in main process)
    // Both MCP sources and API sources are routed through the pool.
    // Safe mode state - user-controlled read-only exploration mode
    private safeMode: boolean = false;
    // Event adapter for SDK message → AgentEvent conversion (testable, pluggable)
    private eventAdapter!: ClaudeEventAdapter;
    // Thinking level is managed by BaseAgent
    // Pinned system prompt components (captured on first chat, used for consistency after compaction)
    private pinnedPreferencesPrompt: string | null = null;
    private pinnedIncludeCoAuthoredBy: boolean | null = null;
    private pinnedProjectContext: import('../projects/types.ts').ProjectPromptContext | null = null;
    // Track if preference drift notification has been shown this session
    private preferencesDriftNotified: boolean = false;
    // Captured stderr from SDK subprocess (for error diagnostics when process exits with code 1)
    private lastStderrOutput: string[] = [];
    /**
     * WS2 keep-alive: when true, use one long-lived streaming-input `query()` per
     * session so background sub-agents survive across turns (instead of a fresh
     * per-turn subprocess that tears them down at turn end). Resolved once from
     * `CRAFT_KEEP_BG_AGENTS_ALIVE` via the shared resolver. Default is ON (opt-out);
     * set `CRAFT_KEEP_BG_AGENTS_ALIVE=0` to force the per-turn kill-switch path.
     */
    private readonly keepBackgroundTasksAlive: boolean = resolveKeepBackgroundTasksAlive();
    // ── WS2 persistent streaming-input query state (flag ON only) ─────────────
    /** Pushable prompt feeding the one long-lived `query()`; `push()` per turn, `end()` to tear down. */
    private persistentInput: PushableInputStream<SDKUserMessage> | null = null;
    /** The sole iterator over the persistent query — owned exclusively by the consumer loop. */
    private persistentIterator: AsyncIterator<SDKMessage> | null = null;
    /** AbortController bound to the persistent query for its whole life (hard-kill backstop). */
    private persistentAbortController: AbortController | null = null;
    /** Monotonic identity for the persistent query owned by this agent instance. */
    private persistentQueryGeneration = 0;
    /** Generation currently owned by the consumer attached to the live iterator. */
    private persistentConsumerGeneration: number | null = null;
    /** The current turn's SDK-message channel; the consumer routes into it, chatImpl drains it. */
    private activeTurnChannel: PushableInputStream<SDKMessage> | null = null;
    /** Sink for background task events that arrive between turns (wired by the session layer). */
    private onBackgroundEvent: ((event: AgentEvent) => void) | null = null;
    private teardownPersistentQuery(reason: string = 'teardown', runtimeTerminationAlreadyConfirmed = false): void {
        return claudeAgentPersistentRuntime.teardownPersistentQuery(this, reason, runtimeTerminationAlreadyConfirmed);
    }
    private beginPersistentTurn(prompt: SDKUserMessage, options: Options, gmailLifecycle: SourceProxyGmailLifecycleContext): AsyncIterable<SDKMessage> {
        return claudeAgentPersistentRuntime.beginPersistentTurn(this, prompt, options, gmailLifecycle);
    }
    private createProviderTurnMessageSource(effectiveUserMessage: string, attachments: FileAttachment[] | undefined, options: Options, gmailRuntimeContext: SourceProxyGmailLifecycleContext): AsyncIterable<SDKMessage> {
        return claudeAgentPersistentRuntime.createProviderTurnMessageSource(this, effectiveUserMessage, attachments, options, gmailRuntimeContext);
    }
    private createOneShotProviderInput(prompt: SDKUserMessage): AsyncIterable<SDKUserMessage> {
        return claudeAgentPersistentRuntime.createOneShotProviderInput(this, prompt);
    }
    private startPersistentConsumer(): void {
        return claudeAgentPersistentRuntime.startPersistentConsumer(this);
    }
    private routeBackgroundMessage(message: SDKMessage): void {
        return claudeAgentPersistentRuntime.routeBackgroundMessage(this, message);
    }
    setBackgroundEventSink(sink: ((event: AgentEvent) => void) | null): void {
        return claudeAgentPersistentRuntime.setBackgroundEventSink(this, sink);
    }
    /**
     * Get the session ID for mode operations.
     * Returns a temp ID if no session is configured (shouldn't happen in practice).
     */
    private get modeSessionId(): string {
        return this.config.session?.id || `temp-${Date.now()}`;
    }
    /**
     * Get the workspace root path for workspace-scoped operations.
     */
    private get workspaceRootPath(): string {
        return this.config.workspace.rootPath;
    }
    private resolveProjectContext(): import('../projects/types.ts').ProjectPromptContext | null {
        return claudeAgentInitialization.resolveProjectContext(this);
    }
    // Callback for permission requests - set by application to receive permission prompts
    public onPermissionRequest: ((request: ClaudeOnPermissionRequest) => void) | null = null;
    // Debug callback for status messages
    public onDebug: ((message: string) => void) | null = null;
    /** Callback when permission mode changes */
    public onPermissionModeChange: ((mode: PermissionMode) => void) | null = null;
    // Callback when a plan is submitted - set by application to display plan message
    public onPlanSubmitted: ((planPath: string) => void) | null = null;
    // Callback when authentication is requested (unified auth flow)
    // This follows the SubmitPlan pattern:
    // 1. Tool calls onAuthRequest
    // 2. Session manager creates auth-request message and calls forceAbort
    // 3. User completes auth in UI
    // 4. Auth result is sent as a "faked user message"
    // 5. Agent resumes and processes the result
    public onAuthRequest: ((request: AuthRequest) => void) | null = null;
    // Callback when a source config changes (hot-reload from file watcher)
    public onSourceChange: ((slug: string, source: LoadedSource | null) => void) | null = null;
    // onSourcesListChange, onConfigValidationError, and onSourceActivationRequest are inherited from BaseAgent
    // Callback when token usage is updated (for context window display).
    // Note: Full UsageTracker integration is planned for Phase 4 refactoring.
    public onUsageUpdate: ((update: ClaudeOnUsageUpdate) => void) | null = null;
    constructor(config: ClaudeAgentConfig) {
        // Resolve model: prioritize session model > config model > current Anthropic default.
        const model = config.session?.model ?? config.model ?? DEFAULT_MODEL;
        // Build BackendConfig for BaseAgent
        // Context window from registry (1M for Opus/Sonnet 4.6, 200K for others)
        const CLAUDE_CONTEXT_WINDOW = getModelContextWindow(model) ?? 200000;
        const backendConfig: BackendConfig = createClaudeBackendConfig(config, model);
        // Call BaseAgent constructor - initializes model, thinkingLevel, permissionManager, sourceManager, etc.
        // The inherited this.config is set by super() and compatible with ClaudeAgentConfig
        super(backendConfig, DEFAULT_MODEL, CLAUDE_CONTEXT_WINDOW);
        this.isHeadless = config.isHeadless ?? false;
        this.automationSystem = config.automationSystem;
        // Initialize event adapter for SDK message → AgentEvent conversion
        this.eventAdapter = new ClaudeEventAdapter({
            onDebug: (msg) => this.onDebug?.(msg),
            mapSDKError: (errorCode) => this.mapSDKErrorToTypedError(errorCode),
        });
        // Log which model is being used (helpful for debugging custom models)
        this.debug(`Using model: ${model}`);
        // Initialize sessionId from session config for conversation resumption
        if (config.session?.sdkSessionId) {
            this.sessionId = config.session.sdkSessionId;
        }
        // Initialize branch params for SDK-level fork (resume parent + forkSession)
        if (config.session?.branchFromSdkSessionId) {
            this.branchFromSdkSessionId = config.session.branchFromSdkSessionId;
            this.branchFromSdkCwd = config.session.branchFromSdkCwd ?? null;
            this.branchFromSdkTurnId = config.session.branchFromSdkTurnId ?? null;
        }
        // Initialize permission mode state with callbacks
        const sessionId = this.modeSessionId;
        // Get initial mode: from session, or from global default
        const globalDefaults = loadConfigDefaults();
        const initialMode: PermissionMode = config.session?.permissionMode ?? globalDefaults.workspaceDefaults.permissionMode;
        initializeModeState(sessionId, initialMode, {
            onStateChange: (state) => {
                // Sync permission mode state with agent
                this.safeMode = state.permissionMode === 'safe';
                // Notify UI of permission mode changes
                this.onPermissionModeChange?.(state.permissionMode);
            },
        });
        // Register session-scoped tool callbacks
        registerSessionScopedToolCallbacks(sessionId, {
            onPlanSubmitted: (planPath) => {
                this.onDebug?.(`[ClaudeAgent] onPlanSubmitted received: ${planPath}`);
                this.onPlanSubmitted?.(planPath);
            },
            onAuthRequest: (request) => {
                this.onDebug?.(`[ClaudeAgent] onAuthRequest received: ${request.sourceSlug} (type: ${request.type})`);
                this.onAuthRequest?.(request);
            },
            queryFn: (request) => this.queryLlm(request),
            spawnSessionFn: (input) => this.preExecuteSpawnSession(input),
        });
        // Start config watcher for hot-reloading source changes
        // Only start in non-headless mode to avoid overhead in batch/script scenarios
        if (!this.isHeadless) {
            this.startConfigWatcher();
        }
    }
    override async postInit(): Promise<PostInitResult> {
        return claudeAgentInitialization.postInit(this);
    }
    respondToPermission(requestId: string, allowed: boolean, alwaysAllow: boolean = false): void {
        return claudeAgentPermissions.respondToPermission(this, requestId, allowed, alwaysAllow);
    }
    private denyAllPendingPermissions(): void {
        return claudeAgentPermissions.denyAllPendingPermissions(this);
    }
    private resolveContextualGmailPromptDecision(sessionId: string, toolName: string, toolInput: Record<string, unknown>, toolUseId: string | undefined, approved: boolean) {
        return claudeAgentPermissions.resolveContextualGmailPromptDecision(this, sessionId, toolName, toolInput, toolUseId, approved);
    }
    private async checkToolPermission(toolName: string, input: Record<string, unknown>, toolUseId: string): Promise<ClaudeCheckToolPermissionResult> {
        return claudeAgentPermissions.checkToolPermission(this, toolName, input, toolUseId);
    }
    private async getToken(): Promise<string | null> {
        return claudeAgentInitialization.getToken(this);
    }
    private createGmailRuntimeId(sessionId: string): string {
        return claudeAgentPersistentRuntime.createGmailRuntimeId(this, sessionId);
    }
    private confirmContextualGmailRuntimeTeardown(runtime: Parameters<typeof confirmContextualGmailRuntimeTeardown>[0]): boolean {
        return claudeAgentPersistentRuntime.confirmContextualGmailRuntimeTeardownOperation(this, runtime);
    }
    protected async *chatImpl(userMessage: string, attachments?: FileAttachment[], options?: ChatOptions): AsyncGenerator<AgentEvent> {
        return yield* claudeAgentResponse.chatImpl(this, userMessage, attachments, options);
    }
    private buildSDKUserMessage(text: string, attachments?: FileAttachment[]): SDKUserMessage {
        return claudeAgentMessages.buildSDKUserMessage(this, text, attachments);
    }
    private mapImageMediaType(mimeType?: string): 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' | null {
        return claudeAgentMessages.mapImageMediaType(this, mimeType);
    }
    private async parseApiErrorFromDebugLog(): Promise<ClaudeSdkApiError | null> {
        return claudeAgentMessages.parseApiErrorFromDebugLog(this);
    }
    private getCapturedApiErrorForSession() {
        return claudeAgentMessages.getCapturedApiErrorForSession(this);
    }
    private async mapSDKErrorToTypedError(errorCode: SDKAssistantMessageError): Promise<ClaudeMapSDKErrorToTypedErrorResult> {
        return claudeAgentMessages.mapSDKErrorToTypedError(this, errorCode);
    }
    private detectInactiveSourceToolError(event: AgentEvent, toolIndex: ToolIndex): ClaudeDetectInactiveSourceToolErrorResult | null {
        return claudeAgentMessages.detectInactiveSourceToolError(this, event, toolIndex);
    }
    clearHistory(): void {
        this.clearClaudeHistoryState();
        super.clearHistory();
    }
    override redirect(_message: string): boolean {
        return claudeAgentInterrupt.redirect(this, _message);
    }
    override interruptForHandoff(reason: AbortReason): void {
        return claudeAgentInterrupt.interruptForHandoff(this, reason);
    }
    forceAbort(reason: AbortReason = AbortReason.UserStop): void {
        return claudeAgentInterrupt.forceAbort(this, reason);
    }
    getModel(): string {
        return claudeAgentSdkOptions.getModel(this);
    }
    getSdkTools(): string[] {
        return claudeAgentSdkOptions.getSdkTools(this);
    }
    setModel(model: string): void {
        super.setModel(model);
    }
    isMiniAgent(): boolean {
        return claudeAgentSdkOptions.isMiniAgent(this);
    }
    getMiniAgentConfig(): MiniAgentConfig {
        return claudeAgentSdkOptions.getMiniAgentConfig(this);
    }
    getWorkspace(): Workspace {
        return claudeAgentWorkspace.getWorkspace(this);
    }
    setWorkspace(workspace: Workspace): void {
        return claudeAgentWorkspace.setWorkspace(this, workspace);
    }
    getSessionId(): string | null {
        return claudeAgentPersistentRuntime.getSessionId(this);
    }
    setSessionId(sessionId: string | null): void {
        return claudeAgentPersistentRuntime.setSessionId(this, sessionId);
    }
    updateWorkingDirectory(path: string): void {
        return claudeAgentWorkspace.updateWorkingDirectory(this, path);
    }
    async close(): Promise<void> {
        return claudeAgentInterrupt.close(this);
    }
    async abort(reason?: string): Promise<void> {
        return claudeAgentInterrupt.abort(this, reason);
    }
    /**
     * Destroy the agent and clean up resources.
     * Calls super.destroy() for base cleanup, then Claude-specific cleanup.
     */
    destroy(): void {
        this.destroyClaudeRuntime();
        // Base cleanup (stops config watcher, clears whitelists, resets source trackers)
        super.destroy();
    }
    isProcessing(): boolean {
        return claudeAgentInterrupt.isProcessing(this);
    }
    getPermissionMode(): PermissionMode {
        return claudeAgentPermissions.getPermissionModeOperation(this);
    }
    setPermissionMode(mode: PermissionMode): void {
        return claudeAgentPermissions.setPermissionModeOperation(this, mode);
    }
    cyclePermissionMode(): PermissionMode {
        return claudeAgentPermissions.cyclePermissionModeOperation(this);
    }
    override async ensureBranchReady(): Promise<void> {
        return claudeAgentBranches.ensureBranchReady(this);
    }
    async runMiniCompletion(prompt: string): Promise<string | null> {
        return claudeAgentBranches.runMiniCompletion(this, prompt);
    }
    /**
     * Pick the first existing directory among the cwd candidates.
     *
     * `branchFromSdkCwd` is consulted only on the first attempt of a branched
     * session — pre-spawn detection (in `chat()`) routes stale-branch cases
     * through `recoverFromStaleBranchFork` before this method runs, so the
     * branch candidate here is only relevant in the rare race where the cwd
     * vanishes between the pre-spawn check and the actual spawn.
     */
    private resolveSpawnCwd({ isRetry, sessionId, }: ClaudeResolveSpawnCwdInputPayload): string {
        const candidates: Array<string | null | undefined> = [
            !isRetry && this.branchFromSdkSessionId ? this.branchFromSdkCwd : null,
            this.config.session?.sdkCwd,
            sessionId ? getSessionPath(this.workspaceRootPath, sessionId) : null,
            this.workspaceRootPath,
        ];
        for (const c of candidates) {
            if (isExistingDirectory(c))
                return c!;
        }
        // workspaceRootPath itself is missing — pathological, but we have nothing
        // better to fall back to. Let the SDK surface the spawn failure.
        debug('[ClaudeAgent] No cwd candidate exists; falling back to workspaceRootPath anyway', {
            candidates,
        });
        return this.workspaceRootPath;
    }
    private async *recoverFromStaleBranchFork(userMessage: string, attachments: FileAttachment[] | undefined, isPreSpawn: boolean): AsyncGenerator<AgentEvent> {
        return yield* claudeAgentBranches.recoverFromStaleBranchFork(this, userMessage, attachments, isPreSpawn);
    }
    private async generateBranchFallbackContext(): Promise<string | null> {
        return claudeAgentBranches.generateBranchFallbackContext(this);
    }
    async queryLlm(request: LLMQueryRequest): Promise<LLMQueryResult> {
        return claudeAgentBranches.queryLlm(this, request);
    }
    private createPreToolUseHook(sessionId: string, gmailRuntimeId: string): SdkAutomationCallbackMatcher['hooks'][number] {
        return claudeAgentPreToolUse.createPreToolUseHook(this, sessionId, gmailRuntimeId);
    }
    private buildClaudeHooks(sessionId: string, gmailRuntimeId: string): Options['hooks'] {
        return claudeAgentSdkOptions.buildClaudeHooks(this, sessionId, gmailRuntimeId);
    }
    private async buildClaudeQueryOptions(sessionId: string, gmailRuntimeId: string, _isRetry: boolean, prepared: ClaudeQueryPreparation): Promise<Options> {
        return claudeAgentSdkOptions.buildClaudeQueryOptions(this, sessionId, gmailRuntimeId, _isRetry, prepared);
    }
    private async *prepareClaudeQueryRuntime(userMessage: string, attachments: FileAttachment[] | undefined, sessionId: string, _isRetry: boolean, gmailRuntimeId: string, gmailRuntimeContext: SourceProxyGmailLifecycleContext): AsyncGenerator<AgentEvent, ClaudeQueryPreparation | undefined> {
        return yield* claudeAgentPreparation.prepareClaudeQueryRuntime(this, userMessage, attachments, sessionId, _isRetry, gmailRuntimeId, gmailRuntimeContext);
    }
    private async *recoverClaudeQueryError(sdkError: unknown, context: ClaudeQueryFailureContext): AsyncGenerator<AgentEvent> {
        return yield* claudeAgentRecovery.recoverClaudeQueryError(this, sdkError, context);
    }
    private async createClaudeTurnMessageSource(userMessage: string, attachments: FileAttachment[] | undefined, options: Options, slashCommandRunsOutsidePersistentRuntime: boolean, _isRetry: boolean, gmailRuntimeContext: SourceProxyGmailLifecycleContext): Promise<AsyncIterable<SDKMessage>> {
        return claudeAgentPreparation.createClaudeTurnMessageSource(this, userMessage, attachments, options, slashCommandRunsOutsidePersistentRuntime, _isRetry, gmailRuntimeContext);
    }
    private destroyClaudeRuntime(): void {
        return claudeAgentPersistentRuntime.destroyClaudeRuntime(this);
    }
    private clearClaudeHistoryState(): void {
        return claudeAgentPersistentRuntime.clearClaudeHistoryState(this);
    }
}

export { jsonPropToZod } from "./claude-agent/schema";
// Re-export permission mode functions for application usage

export type { AgentEvent };
// Re-export types for UI components
export type { LoadedSource } from '../sources/types.ts';
export { AbortReason, type RecoveryMessage };
// ============================================================
// Backward Compatibility Exports
// ============================================================
// These aliases allow gradual migration from CraftAgent to ClaudeAgent.
// Once all consumers are updated, these can be removed.

/** @deprecated Use ClaudeAgent instead */
export { ClaudeAgent as CraftAgent };
/** @deprecated Use ClaudeAgentConfig instead */
export type { ClaudeAgentConfig as CraftAgentConfig };
