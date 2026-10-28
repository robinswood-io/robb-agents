import { WorkspaceEventBus, type EventPayloadMap } from "./event-bus.ts";
import { PromptHandler, EventLogHandler, WebhookHandler, type AutomationsConfigProvider } from "./handlers/index.ts";
import { type AutomationsConfig, type AutomationEvent, type AutomationMatcher, type AppEvent, type AgentEvent, type SdkAutomationCallbackMatcher, type SdkAutomationInput } from "./types.ts";
import { SchedulerService } from "../scheduler/scheduler-service.ts";
import type { SessionMetadataSnapshot } from "./types.ts";
import { log } from './automation-system/shared.ts';
import type { AutomationSystemOptions } from './automation-system/shared.ts';
import * as automationSystemConfiguration from './automation-system/configuration.ts';
import * as automationSystemScheduling from './automation-system/scheduling.ts';
import * as automationSystemMetadata from './automation-system/metadata.ts';
import * as automationSystemExecution from './automation-system/execution.ts';
import * as automationSystemLifecycle from './automation-system/lifecycle.ts';
export type { AutomationSystemOptions } from './automation-system/shared.ts';

// ============================================================================
// AutomationSystem Implementation
// ============================================================================
export class AutomationSystem implements AutomationsConfigProvider {
    readonly eventBus: WorkspaceEventBus;
    private readonly options: AutomationSystemOptions;
    private config: AutomationsConfig | null = null;
    private promptHandler: PromptHandler | null = null;
    private webhookHandler: WebhookHandler | null = null;
    private eventLogHandler: EventLogHandler | null = null;
    private scheduler: SchedulerService | null = null;
    private disposed = false;
    /** @internal */ public disposePromise: Promise<void> | null = null;
    // Session metadata tracking (moved from SessionManager)
    private readonly lastKnownMetadata: Map<string, SessionMetadataSnapshot> = new Map();
    /** fs.watch may report the same atomic header replacement several times
     * while the first automation emission is still awaiting its handlers. Keep
     * one per-session diff lane so every later snapshot observes the committed
     * predecessor instead of emitting the same transition again. */
    /** @internal */ public readonly sessionMetadataUpdateTails = new Map<string, Promise<void>>();
    /**
     * Synchronous invalidation tokens for metadata mutations that bypass the
     * async diff lane. A delete/reload/dispose must win immediately over both a
     * running emission and snapshots already queued behind it.
     */
    /** @internal */ public readonly sessionMetadataTokens = new Map<string, object>();
    /** @internal Shared with the extracted backend helpers. */ public metadataLifecycleToken: object = {};
    constructor(options: AutomationSystemOptions) {
        this.options = options;
        this.eventBus = new WorkspaceEventBus(options.workspaceId);
        // Load configuration
        this.loadConfig();
        // Create handlers
        this.createHandlers();
        // Start scheduler if enabled
        if (options.enableScheduler) {
            this.startScheduler();
        }
        log.debug(`[AutomationSystem] Created for workspace: ${options.workspaceId}`);
    }
    /** @internal */ public readAndValidateConfig(configPath: string): {
        raw: unknown;
        validation: import('./types.ts').AutomationsValidationResult;
    } {
        return automationSystemConfiguration.readAndValidateConfig(this, configPath);
    }
    private loadConfig(): void {
        return automationSystemConfiguration.loadConfig(this);
    }
    /**
     * Reload automations configuration.
     * Call this when automations.json changes.
     */
    reloadConfig(): {
        success: boolean;
        automationCount: number;
        errors: string[];
    } {
        return automationSystemConfiguration.reloadConfig(this);
    }
    /** @internal Shared with the extracted backend helpers. */ public backfillIds(configPath: string, raw: unknown): void {
        return automationSystemConfiguration.backfillIds(this, configPath, raw);
    }
    /** @internal Shared with the extracted backend helpers. */ public rotateHistory(): void {
        return automationSystemConfiguration.rotateHistory(this);
    }
    /** @internal Shared with the extracted backend helpers. */ public getActionCount(): number {
        return automationSystemConfiguration.getActionCount(this);
    }
    // ============================================================================
    // AutomationsConfigProvider Implementation
    // ============================================================================
    getConfig(): AutomationsConfig | null {
        return this.config;
    }
    getMatchersForEvent(event: AutomationEvent): AutomationMatcher[] {
        return this.config?.automations[event] ?? [];
    }
    private createHandlers(): void {
        return automationSystemScheduling.createHandlers(this);
    }
    private startScheduler(): void {
        return automationSystemScheduling.startScheduler(this);
    }
    /**
     * Stop the scheduler service.
     */
    stopScheduler(): void {
        return automationSystemScheduling.stopScheduler(this);
    }
    // ============================================================================
    // Session Metadata Diffing
    // ============================================================================
    /**
     * Update session metadata and emit events for changes.
     *
     * This replaces the diffing logic that was in SessionManager.
     * Call this whenever session metadata changes.
     *
     * @param sessionId - The session ID
     * @param next - The new metadata snapshot
     * @returns The events that were emitted
     */
    async updateSessionMetadata(sessionId: string, next: SessionMetadataSnapshot): Promise<AppEvent[]> {
        return automationSystemMetadata.updateSessionMetadata(this, sessionId, next);
    }
    /** @internal Shared with the extracted backend helpers. */ public async updateSessionMetadataNow(sessionId: string, next: SessionMetadataSnapshot, sessionToken: object, lifecycleToken: object): Promise<AppEvent[]> {
        return automationSystemMetadata.updateSessionMetadataNow(this, sessionId, next, sessionToken, lifecycleToken);
    }
    /**
     * Remove session metadata tracking.
     * Call this when a session is deleted.
     */
    removeSessionMetadata(sessionId: string): void {
        return automationSystemMetadata.removeSessionMetadata(this, sessionId);
    }
    /**
     * Get stored metadata for a session.
     */
    getSessionMetadata(sessionId: string): SessionMetadataSnapshot | undefined {
        return this.lastKnownMetadata.get(sessionId);
    }
    /**
     * Set initial metadata for a session (without emitting events).
     * Call this when loading existing sessions.
     */
    setInitialSessionMetadata(sessionId: string, metadata: SessionMetadataSnapshot): void {
        return automationSystemMetadata.setInitialSessionMetadata(this, sessionId, metadata);
    }
    /** @internal Shared with the extracted backend helpers. */ public getOrCreateSessionMetadataToken(sessionId: string): object {
        return automationSystemMetadata.getOrCreateSessionMetadataToken(this, sessionId);
    }
    // ============================================================================
    // Direct Event Emission
    // ============================================================================
    /**
     * Emit a LabelConfigChange event.
     * Call this when labels/config.json changes.
     */
    async emitLabelConfigChange(): Promise<void> {
        return automationSystemMetadata.emitLabelConfigChange(this);
    }
    /**
     * Emit an event directly (for edge cases).
     */
    async emit<T extends AutomationEvent>(event: T, payload: EventPayloadMap[T]): Promise<void> {
        await this.eventBus.emit(event, payload);
    }
    // ============================================================================
    // Agent Event Execution (Backend-Agnostic)
    // ============================================================================
    /**
     * Execute agent event automations directly (without going through the Claude SDK).
     * This is the backend-agnostic entry point for non-Claude backends (Codex, Copilot, Pi)
     * to fire agent events from automations.json.
     *
     * For each matching automation matcher, builds env vars and evaluates matching.
     * Command execution has been removed — all automation actions now go through prompt-based
     * execution (creating agent sessions via PromptHandler).
     * Catches all errors — automations must never break the agent flow.
     *
     * @param signal - Optional AbortSignal for cancelling automation execution on abort
     * @returns Number of matched matchers (for diagnostics/testing)
     */
    async executeAgentEvent(event: AgentEvent, input: SdkAutomationInput, signal?: AbortSignal): Promise<number> {
        return automationSystemExecution.executeAgentEvent(this, event, input, signal);
    }
    // ============================================================================
    // SDK Automation Integration
    // ============================================================================
    /**
     * Build SDK hook callbacks from automations.json definitions.
     *
     * Command execution has been removed — all automation actions now go through prompt-based
     * execution (creating agent sessions via PromptHandler). Agent event automations are not
     * currently supported via prompts, so this returns empty.
     */
    buildSdkHooks(): Partial<Record<AgentEvent, SdkAutomationCallbackMatcher[]>> {
        return {};
    }
    // ============================================================================
    // Lifecycle
    // ============================================================================
    /**
     * Check if the system has been disposed.
     */
    isDisposed(): boolean {
        return this.disposed;
    }
    /**
     * Dispose the automation system, cleaning up all resources.
     */
    dispose(): Promise<void> {
        return automationSystemLifecycle.dispose(this);
    }
    /** @internal Shared with the extracted backend helpers. */ public async disposeResources(): Promise<void> {
        return automationSystemLifecycle.disposeResources(this);
    }
}

// Re-export SessionMetadataSnapshot from types (single source of truth)
export type { SessionMetadataSnapshot } from './types.ts';
