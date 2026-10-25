import type { AgentEvent } from "@craft-agent/core/types";
import type { FileAttachment } from "../utils/files.ts";
import type { ThinkingLevel } from "./thinking-levels.ts";
import { DEFAULT_THINKING_LEVEL, normalizeThinkingLevel } from "./thinking-levels.ts";
import type { PermissionMode } from "./mode-manager.ts";
import type { LoadedSource } from "../sources/types.ts";
import { type LLMQueryRequest, type LLMQueryResult } from "./llm-tool.ts";
import { getBrowserToolEnabled } from "../config/storage.ts";
import type { AgentBackend, ChatOptions, PermissionCallback, PlanCallback, AuthCallback, SourceChangeCallback, SourceActivationCallback, SdkMcpServerConfig, BackendConfig, PostInitResult, SourceServerSnapshot, RecoveryMessage } from "./backend/types.ts";
import { AbortReason } from "./backend/types.ts";
import type { Workspace } from "../config/storage.ts";
// Core modules
import { PermissionManager } from "./core/permission-manager.ts";
import { SourceManager } from "./core/source-manager.ts";
import { PromptBuilder } from "./core/prompt-builder.ts";
import { PathProcessor } from "./core/path-processor.ts";
import { ConfigWatcherManager } from "./core/config-watcher-manager.ts";
import { UsageTracker, type UsageUpdate } from "./core/usage-tracker.ts";
import { PrerequisiteManager } from "./core/prerequisite-manager.ts";
// Automation system for agent events
import type { AutomationSystem } from "../automations/automation-system.ts";
import type { AgentEvent as AutomationAgentEvent, SdkAutomationInput } from "../automations/types.ts";
import { getSessionPlansPath, getSessionDataPath } from "../sessions/storage.ts";
import type { MiniAgentConfig, SpawnSessionRequest, SpawnSessionResult, SpawnSessionHelpResult } from './base-agent/shared.ts';
import type { BaseAgentAdmittedToolExecutions, BaseAgentPendingSourceActivationRestart, BaseAgentAdmitToolExecutionInputPayload, BaseAgentBeginAdmittedToolExecutionBySignatureInputPayload, BaseAgentExtractSkillPathsResult, BaseAgentGenerateTitleOptionsPayload } from './base-agent/protocol.ts';
import * as baseAgentAdmission from './base-agent/admission.ts';
import * as baseAgentConfiguration from './base-agent/configuration.ts';
import * as baseAgentWorkspace from './base-agent/workspace.ts';
import * as baseAgentSources from './base-agent/sources.ts';
import * as baseAgentContext from './base-agent/context.ts';
import * as baseAgentLifecycle from './base-agent/lifecycle.ts';
import * as baseAgentSkills from './base-agent/skills.ts';
import * as baseAgentConversation from './base-agent/conversation.ts';
import * as baseAgentSessionTools from './base-agent/session-tools.ts';
export type { MiniAgentConfig, SpawnSessionRequest, SpawnSessionResult, SpawnSessionHelpResult } from './base-agent/shared.ts';
export { MINI_AGENT_TOOLS, MINI_AGENT_MCP_KEYS } from './base-agent/shared.ts';

// ============================================================
// BaseAgent Abstract Class
// ============================================================
/**
 * Abstract base class for agent backends.
 *
 * Provides:
 * - Common state management (model, thinking, workspace, session)
 * - Core module delegation (PermissionManager, SourceManager, etc.)
 * - Callback declarations for UI integration
 *
 * Subclasses must implement:
 * - backendName: Display name for error messages ('Claude', 'Codex', etc.)
 * - chat(): Provider-specific agentic loop
 * - abort(): Provider-specific abort handling
 * - capabilities(): Provider-specific capabilities
 * - respondToPermission(): Provider-specific permission resolution
 * - destroy(): Provider-specific cleanup
 * - runMiniCompletion(): Simple text completion using backend's auth
 */
export abstract class BaseAgent implements AgentBackend {
    // ============================================================
    // Backend Identity
    // ============================================================
    protected abstract backendName: string;
    /** Whether this backend supports session branching. Subclasses can override. */
    protected _supportsBranching = true;
    get supportsBranching(): boolean { return this._supportsBranching; }
    // ============================================================
    // Configuration (protected for subclass access)
    // ============================================================
    protected config: BackendConfig;
    protected workingDirectory: string;
    protected _sessionId: string;
    // ============================================================
    // Model Configuration (protected for subclass access)
    // ============================================================
    protected _model: string;
    protected _thinkingLevel: ThinkingLevel;
    // ============================================================
    // Core Modules (protected for subclass access)
    // ============================================================
    protected permissionManager: PermissionManager;
    protected sourceManager: SourceManager;
    protected promptBuilder: PromptBuilder;
    protected pathProcessor: PathProcessor;
    protected configWatcherManager: ConfigWatcherManager | null = null;
    protected usageTracker: UsageTracker;
    protected prerequisiteManager: PrerequisiteManager;
    protected automationSystem?: AutomationSystem;
    // ============================================================
    // Additional State (protected for subclass access)
    // ============================================================
    protected temporaryClarifications: string | null = null;
    /**
     * One host-owned admission per provider tool-use id. The model never sees
     * this state: it bridges the asynchronous PreToolUse decision to the actual
     * proxy execution (Pi), and marks the SDK-owned execution window (Claude).
     */
    private admittedToolExecutions = new Map<string, BaseAgentAdmittedToolExecutions>();
    private sourceServerSnapshot: SourceServerSnapshot = {
        mcpServers: {},
        apiServers: {},
        intendedSlugs: [],
    };
    // ============================================================
    // Source activation auto-retry (routed through the existing source_activated
    // + forceAbort + auto_retry pipeline used for tool-call errors).
    //
    // When a session-scoped tool (source_test) successfully activates a new source
    // mid-turn, the Claude SDK's mcpServers is already frozen for the current query
    // (and Pi's tool registry is only refreshed between turns). The only way to
    // expose the new tools is to end the current turn and auto-resend the user's
    // original message with a "[{slug} activated]" suffix — same as what happens
    // when a model directly calls an unknown tool on an inactive source.
    //
    // activateSourceInSessionFn in SessionManager sets this; the per-backend event
    // loop consumes it after yielding the source_test tool_result.
    // ============================================================
    protected _pendingSourceActivationRestart: BaseAgentPendingSourceActivationRestart | null = null;
    protected _currentTurnUserMessage: string | null = null;
    setPendingSourceActivationRestart(pending: BaseAgentPendingSourceActivationRestart): void {
        return baseAgentAdmission.setPendingSourceActivationRestart(this, pending);
    }
    consumePendingSourceActivationRestart(): BaseAgentPendingSourceActivationRestart | null {
        return baseAgentAdmission.consumePendingSourceActivationRestart(this);
    }
    getCurrentTurnUserMessage(): string | null {
        return baseAgentAdmission.getCurrentTurnUserMessage(this);
    }
    protected setCurrentTurnUserMessage(message: string | null): void {
        return baseAgentAdmission.setCurrentTurnUserMessage(this, message);
    }
    protected admitToolExecution(input: BaseAgentAdmitToolExecutionInputPayload): boolean {
        return baseAgentAdmission.admitToolExecution(this, input);
    }
    protected beginAdmittedToolExecution(input: BaseAgentAdmitToolExecutionInputPayload): boolean {
        return baseAgentAdmission.beginAdmittedToolExecution(this, input);
    }
    protected beginAdmittedToolExecutionBySignature(input: BaseAgentBeginAdmittedToolExecutionBySignatureInputPayload): string | undefined {
        return baseAgentAdmission.beginAdmittedToolExecutionBySignature(this, input);
    }
    protected settleAdmittedToolExecution(toolUseId: string | undefined): void {
        return baseAgentAdmission.settleAdmittedToolExecution(this, toolUseId);
    }
    protected revokeAdmittedToolExecutions(): void {
        return baseAgentAdmission.revokeAdmittedToolExecutions(this);
    }
    protected hasAdmittedToolExecutions(): boolean {
        return baseAgentAdmission.hasAdmittedToolExecutions(this);
    }
    // ============================================================
    // Callbacks (public for facade wiring)
    // ============================================================
    onPermissionRequest: PermissionCallback | null = null;
    onPlanSubmitted: PlanCallback | null = null;
    onAuthRequest: AuthCallback | null = null;
    onSourceChange: SourceChangeCallback | null = null;
    onSourcesListChange: ((sources: LoadedSource[]) => void) | null = null;
    onConfigValidationError: ((file: string, errors: string[]) => void) | null = null;
    onPermissionModeChange: ((mode: PermissionMode) => void) | null = null;
    onDebug: ((message: string) => void) | null = null;
    onSourceActivationRequest: SourceActivationCallback | null = null;
    onUsageUpdate: ((update: UsageUpdate) => void) | null = null;
    onBackendAuthRequired: ((reason: string) => void) | null = null;
    onSpawnSession: ((request: SpawnSessionRequest) => Promise<SpawnSessionResult>) | null = null;
    onProviderHandoff: (() => void) | null = null;
    onBeforeProviderDispatch: (() => Promise<void>) | null = null;
    onProviderDispatchRejected: (() => void) | null = null;
    onProviderDispatchUncertain: (() => void) | null = null;
    protected async awaitProviderDispatchWriteAhead(): Promise<void> {
        return baseAgentAdmission.awaitProviderDispatchWriteAhead(this);
    }
    protected async performProviderDispatchWriteAhead<T>(dispatch: () => T): Promise<T> {
        return baseAgentAdmission.performProviderDispatchWriteAhead<T>(this, dispatch);
    }
    protected captureProviderDispatchRejection(): () => void {
        return baseAgentAdmission.captureProviderDispatchRejection(this);
    }
    private invokeProviderHandoff(callback: (() => void) | null): void {
        return baseAgentAdmission.invokeProviderHandoff(this, callback);
    }
    protected captureProviderHandoffAcknowledgement(): () => void {
        return baseAgentAdmission.captureProviderHandoffAcknowledgement(this);
    }
    protected captureProviderDispatchUncertainAcknowledgement(): () => void {
        return baseAgentAdmission.captureProviderDispatchUncertainAcknowledgement(this);
    }
    protected performProviderHandoff<T>(dispatch: () => T): T {
        return baseAgentAdmission.performProviderHandoff<T>(this, dispatch);
    }
    // ============================================================
    // Constructor
    // ============================================================
    constructor(config: BackendConfig, defaultModel: string, contextWindow?: number) {
        this.config = config;
        // Use session's workingDirectory if set (user-changeable), fallback to workspace root
        this.workingDirectory = config.session?.workingDirectory ?? config.workspace.rootPath ?? process.cwd();
        this._sessionId = config.session?.id || `agent-${Date.now()}`;
        this._model = config.model || defaultModel;
        this._thinkingLevel = normalizeThinkingLevel(config.thinkingLevel) ?? DEFAULT_THINKING_LEVEL;
        // Initialize core modules
        // PermissionManager: handles permission evaluation, mode management, and command whitelisting
        this.permissionManager = new PermissionManager({
            workspaceId: config.workspace.id,
            sessionId: this._sessionId,
            workingDirectory: this.workingDirectory,
            plansFolderPath: getSessionPlansPath(config.workspace.rootPath, this._sessionId),
            dataFolderPath: getSessionDataPath(config.workspace.rootPath, this._sessionId),
        });
        // SourceManager: tracks active/inactive sources and formats state for context injection
        this.sourceManager = new SourceManager({
            onDebug: (msg) => this.debug(msg),
        });
        // PromptBuilder: builds context blocks for user messages
        this.promptBuilder = new PromptBuilder({
            workspace: config.workspace,
            session: config.session,
            debugMode: config.debugMode,
            systemPromptPreset: config.systemPromptPreset,
            isHeadless: config.isHeadless,
            externalActionPolicy: config.externalActionPolicy,
            getHumanInputAllowed: config.getHumanInputAllowed,
        });
        // PathProcessor: expands ~ and normalizes paths
        this.pathProcessor = new PathProcessor();
        // UsageTracker: token usage and context window tracking
        this.usageTracker = new UsageTracker({
            contextWindow,
            onUsageUpdate: (update) => this.onUsageUpdate?.(update),
            onDebug: (msg) => this.debug(msg),
        });
        // PrerequisiteManager: blocks source tool calls until guide.md is read
        this.prerequisiteManager = new PrerequisiteManager({
            workspaceRootPath: config.workspace.rootPath,
            // buildSystemPrompt injects this contract into stable system context.
            browserGuideLoadedInContext: getBrowserToolEnabled(),
            onDebug: (msg) => this.debug(msg),
        });
        // AutomationSystem: workspace-level automations from automations.json
        this.automationSystem = config.automationSystem;
    }
    protected startConfigWatcher(): void {
        return baseAgentConfiguration.startConfigWatcher(this);
    }
    protected stopConfigWatcher(): void {
        return baseAgentConfiguration.stopConfigWatcher(this);
    }
    protected debug(message: string): void {
        return baseAgentConfiguration.debug(this, message);
    }
    protected async emitAutomationEvent(event: AutomationAgentEvent, input: SdkAutomationInput, signal?: AbortSignal): Promise<void> {
        return baseAgentConfiguration.emitAutomationEvent(this, event, input, signal);
    }
    protected handleSessionMcpToolCompletion(toolName: string, args: Record<string, unknown>): void {
        return baseAgentConfiguration.handleSessionMcpToolCompletion(this, toolName, args);
    }
    // ============================================================
    // Model & Thinking Configuration (AgentBackend interface)
    // ============================================================
    getModel(): string {
        return this._model;
    }
    setModel(model: string): void {
        return baseAgentConfiguration.setModel(this, model);
    }
    getThinkingLevel(): ThinkingLevel {
        return baseAgentConfiguration.getThinkingLevel(this);
    }
    setThinkingLevel(level: ThinkingLevel): void {
        return baseAgentConfiguration.setThinkingLevel(this, level);
    }
    // ============================================================
    // Permission Mode (delegated to PermissionManager)
    // ============================================================
    getPermissionMode(): PermissionMode {
        return this.permissionManager.getPermissionMode();
    }
    setPermissionMode(mode: PermissionMode): void {
        return baseAgentConfiguration.setPermissionMode(this, mode);
    }
    setExternalActionPolicy(policy: 'confirm' | 'allow-in-execute'): void {
        return baseAgentConfiguration.setExternalActionPolicy(this, policy);
    }
    cyclePermissionMode(): PermissionMode {
        return baseAgentConfiguration.cyclePermissionMode(this);
    }
    isInSafeMode(): boolean {
        return baseAgentConfiguration.isInSafeMode(this);
    }
    getWorkspace(): Workspace {
        return baseAgentWorkspace.getWorkspace(this);
    }
    setWorkspace(workspace: Workspace): void {
        return baseAgentWorkspace.setWorkspace(this, workspace);
    }
    getSessionId(): string | null {
        return this._sessionId;
    }
    setSessionId(sessionId: string | null): void {
        return baseAgentWorkspace.setSessionId(this, sessionId);
    }
    clearHistory(): void {
        return baseAgentWorkspace.clearHistory(this);
    }
    resetPrerequisiteState(): void {
        return baseAgentWorkspace.resetPrerequisiteState(this);
    }
    updateWorkingDirectory(path: string): void {
        return baseAgentWorkspace.updateWorkingDirectory(this, path);
    }
    updateSdkCwd(path: string): void {
        return baseAgentWorkspace.updateSdkCwd(this, path);
    }
    async setSourceServers(mcpServers: Record<string, SdkMcpServerConfig>, apiServers: Record<string, unknown>, intendedSlugs?: string[]): Promise<void> {
        return baseAgentSources.setSourceServers(this, mcpServers, apiServers, intendedSlugs);
    }
    getSourceServerSnapshot(): SourceServerSnapshot {
        return baseAgentSources.getSourceServerSnapshot(this);
    }
    getActiveSourceSlugs(): string[] {
        return baseAgentSources.getActiveSourceSlugs(this);
    }
    getAllSources(): LoadedSource[] {
        return baseAgentSources.getAllSources(this);
    }
    setAllSources(sources: LoadedSource[]): void {
        return baseAgentSources.setAllSources(this, sources);
    }
    markSourceUnseen(sourceSlug: string): void {
        return baseAgentSources.markSourceUnseen(this, sourceSlug);
    }
    isSourceServerActive(serverName: string): boolean {
        return baseAgentSources.isSourceServerActive(this, serverName);
    }
    getActiveSourceServerNames(): Set<string> {
        return baseAgentSources.getActiveSourceServerNames(this);
    }
    setTemporaryClarifications(text: string | null): void {
        return baseAgentSources.setTemporaryClarifications(this, text);
    }
    getSourceManager(): SourceManager {
        return baseAgentSources.getSourceManager(this);
    }
    getPermissionManager(): PermissionManager {
        return baseAgentSources.getPermissionManager(this);
    }
    getPromptBuilder(): PromptBuilder {
        return baseAgentSources.getPromptBuilder(this);
    }
    isMiniAgent(): boolean {
        return baseAgentContext.isMiniAgent(this);
    }
    getMiniAgentConfig(): MiniAgentConfig {
        return baseAgentContext.getMiniAgentConfig(this);
    }
    getMiniSystemPrompt(): string {
        return baseAgentContext.getMiniSystemPrompt(this);
    }
    filterMcpServersForMiniAgent<T>(servers: Record<string, T>, allowedKeys: readonly string[]): Record<string, T> {
        return baseAgentContext.filterMcpServersForMiniAgent<T>(this, servers, allowedKeys);
    }
    protected buildRecoveryContext(): string | null {
        return baseAgentContext.buildRecoveryContext(this);
    }
    protected buildBranchSeedContext(messages?: RecoveryMessage[]): string | null {
        return baseAgentContext.buildBranchSeedContext(this, messages);
    }
    protected clearSessionForRecovery(): void {
        return baseAgentContext.clearSessionForRecovery(this);
    }
    protected getSessionStoragePath(): string | undefined {
        return baseAgentContext.getSessionStoragePath(this);
    }
    async postInit(): Promise<PostInitResult> {
        return baseAgentLifecycle.postInit(this);
    }
    async ensureBranchReady(): Promise<void> {
        return baseAgentLifecycle.ensureBranchReady(this);
    }
    dispose(): void {
        return baseAgentLifecycle.dispose(this);
    }
    destroy(): void {
        return baseAgentLifecycle.destroy(this);
    }
    protected extractSkillPaths(message: string): BaseAgentExtractSkillPathsResult {
        return baseAgentSkills.extractSkillPaths(this, message);
    }
    protected formatSkillDirective(skillPaths: Map<string, string>): string {
        return baseAgentSkills.formatSkillDirective(this, skillPaths);
    }
    protected formatSealedSkillDirective(skills: Map<string, string>): string {
        return baseAgentSkills.formatSealedSkillDirective(this, skills);
    }
    async *chat(message: string, attachments?: FileAttachment[], options?: ChatOptions): AsyncGenerator<AgentEvent> {
        return yield* baseAgentConversation.chat(this, message, attachments, options);
    }
    // ============================================================
    // Abstract Methods (provider-specific, must be implemented)
    // ============================================================
    /**
     * Provider-specific chat implementation.
     * Called by chat() after skill validation, prerequisite registration,
     * and directive injection. The message already contains any skill
     * read directives — subclasses don't handle skills at all.
     *
     * @param message - User message (may have skill read directive prepended)
     * @param attachments - File attachments
     * @param options - Chat options (resume, retry, etc.)
     */
    protected abstract chatImpl(message: string, attachments?: FileAttachment[], options?: ChatOptions): AsyncGenerator<AgentEvent>;
    /**
     * Abort current query (user stop or internal abort).
     */
    abstract abort(reason?: string): Promise<void>;
    /**
     * Force abort with specific reason.
     * Used for true hard-stop semantics (user stop, redirect fallback, teardown).
     */
    abstract forceAbort(reason: AbortReason): void;
    interruptForHandoff(reason: AbortReason): void {
        return baseAgentLifecycle.interruptForHandoff(this, reason);
    }
    redirect(_message: string): boolean {
        return baseAgentLifecycle.redirect(this, _message);
    }
    /**
     * Check if currently processing a query.
     */
    abstract isProcessing(): boolean;
    /**
     * Respond to a pending permission request.
     */
    abstract respondToPermission(requestId: string, allowed: boolean, alwaysAllow?: boolean): void;
    /**
     * Run a simple text completion using the agent's auth infrastructure.
     * No tools, no system prompt - just text in → text out.
     * Each backend implements using its own SDK (Claude SDK query() or Codex app-server).
     *
     * @param prompt - The prompt to send
     * @returns The model's response text, or null if completion fails
     */
    abstract runMiniCompletion(prompt: string): Promise<string | null>;
    /**
     * Execute an LLM query using the agent's auth infrastructure.
     * Used by call_llm tool (via queryFn callback) and potentially by runMiniCompletion.
     *
     * Each backend implements this using its own SDK/session mechanism:
     * - ClaudeAgent: SDK query() with OAuth
     * - PiAgent: One-shot completion via Pi SDK in the subprocess
     *
     * @param request - The query request (prompt, model, systemPrompt, etc.)
     * @returns The model's response text and optional token usage
     */
    abstract queryLlm(request: LLMQueryRequest): Promise<LLMQueryResult>;
    protected async preExecuteCallLlm(input: Record<string, unknown>): Promise<LLMQueryResult> {
        return baseAgentSessionTools.preExecuteCallLlm(this, input);
    }
    protected modelRoutePinned(): boolean {
        return baseAgentSessionTools.modelRoutePinned(this);
    }
    /**
     * Optional model validation hook for call_llm.
     * Override in subclasses to filter models (e.g., Codex rejects non-OpenAI models).
     * Return undefined to reject an unsupported explicit model.
     */
    protected validateCallLlmModel?(modelId: string): string | undefined;
    protected async preExecuteSpawnSession(input: Record<string, unknown>): Promise<SpawnSessionResult | SpawnSessionHelpResult> {
        return baseAgentSessionTools.preExecuteSpawnSession(this, input);
    }
    protected getSpawnSessionHelp(): SpawnSessionHelpResult {
        return baseAgentSessionTools.getSpawnSessionHelp(this);
    }
    async generateTitle(message: string, options?: BaseAgentGenerateTitleOptionsPayload): Promise<string | null> {
        return baseAgentSessionTools.generateTitle(this, message, options);
    }
    async regenerateTitle(recentUserMessages: string[], lastAssistantResponse: string, options?: BaseAgentGenerateTitleOptionsPayload): Promise<string | null> {
        return baseAgentSessionTools.regenerateTitle(this, recentUserMessages, lastAssistantResponse, options);
    }
    getSummarizeCallback(): (prompt: string) => Promise<string | null> {
        return baseAgentLifecycle.getSummarizeCallback(this);
    }
}

// Re-export for convenience
export { AbortReason };
