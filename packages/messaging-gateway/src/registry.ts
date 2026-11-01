import type { PlatformRuntimePatch, TelegramConfigPatch } from './registry/shared.ts';
import { RPC_CHANNELS } from "@craft-agent/shared/protocol";
import type { PushTarget } from "@craft-agent/shared/protocol";
import type { IMessagingGatewayRegistry, MessagingBindingInfo, MessagingConfigInfo } from "@craft-agent/server-core/handlers";
import { PairingCodeManager } from "./pairing";
import { type WhatsAppEvent } from "./adapters/whatsapp/index";
import { type LarkCredentials } from "./adapters/lark/index";
import type { SessionEvent } from "./renderer";
import type { EventSinkFn } from "./event-fanout";
import type { BindingAccessMode, MessagingConfig, MessagingLogger, MessagingPlatformRuntimeInfo, PendingSender, PlatformAccessMode, PlatformOwner, PlatformType } from "./types";
import { consoleLogger } from './registry/shared.ts';
import type { MessagingGatewayRegistryOptions, WorkspaceState } from './registry/shared.ts';
import * as registryLifecycle from './registry/lifecycle.ts';
import * as registryConfiguration from './registry/configuration.ts';
import * as registryPairing from './registry/pairing.ts';
import * as registryCredentials from './registry/credentials.ts';
import * as registryConnections from './registry/connections.ts';
import * as registryAccess from './registry/access.ts';
import * as registryEvents from './registry/events.ts';
export type { MessagingGatewayRegistryOptions } from './registry/shared.ts';

export class MessagingGatewayRegistry implements IMessagingGatewayRegistry {
    private readonly workspaces = new Map<string, WorkspaceState>();
    private readonly pairing = new PairingCodeManager();
    private readonly log: MessagingLogger;
    constructor(private readonly opts: MessagingGatewayRegistryOptions) {
        this.log = (opts.logger ?? consoleLogger).child({ component: 'registry' });
        // Install the automation→topic binder hook on the SessionManager so
        // executePromptAutomation can route topic-bound sessions without the
        // SessionManager needing to import this package (avoids a package-level
        // circular dependency).
        opts.sessionManager.setAutomationBinder?.(async (input) => {
            const result = await this.bindAutomationSession(input);
            if (!result.ok) {
                this.log.info('automation topic bind skipped', {
                    event: 'automation_topic_bind_skipped',
                    workspaceId: input.workspaceId,
                    sessionId: input.sessionId,
                    topicName: input.topicName,
                    reason: result.reason,
                    error: result.error,
                });
            }
        });
    }
    // -------------------------------------------------------------------------
    // Public registry lifecycle (called by the app bootstrap)
    // -------------------------------------------------------------------------
    async initializeWorkspace(workspaceId: string): Promise<void> {
        return registryLifecycle.initializeWorkspace(this, workspaceId);
    }
    async removeWorkspace(workspaceId: string): Promise<void> {
        return registryLifecycle.removeWorkspace(this, workspaceId);
    }
    async stopAll(): Promise<void> {
        return registryLifecycle.stopAll(this);
    }
    get size(): number {
        return this.workspaces.size;
    }
    // -------------------------------------------------------------------------
    // IMessagingGatewayRegistry — config
    // -------------------------------------------------------------------------
    getConfig(workspaceId: string): MessagingConfigInfo | null {
        return registryConfiguration.getConfig(this, workspaceId);
    }
    async updateConfig(workspaceId: string, partial: Partial<MessagingConfigInfo>): Promise<void> {
        return registryConfiguration.updateConfig(this, workspaceId, partial);
    }
    // -------------------------------------------------------------------------
    // IMessagingGatewayRegistry — bindings
    // -------------------------------------------------------------------------
    getBindings(workspaceId: string): MessagingBindingInfo[] {
        return registryConfiguration.getBindings(this, workspaceId);
    }
    unbindSession(workspaceId: string, sessionId: string, platform?: string): void {
        return registryConfiguration.unbindSession(this, workspaceId, sessionId, platform);
    }
    unbindBinding(workspaceId: string, bindingId: string): boolean {
        return registryConfiguration.unbindBinding(this, workspaceId, bindingId);
    }
    // -------------------------------------------------------------------------
    // IMessagingGatewayRegistry — pairing
    // -------------------------------------------------------------------------
    generatePairingCode(workspaceId: string, sessionId: string, platform: string): {
        code: string;
        expiresAt: number;
        botUsername?: string;
    } {
        return registryPairing.generatePairingCode(this, workspaceId, sessionId, platform);
    }
    /**
     * Issue a workspace-supergroup pairing code. The user types
     * `/pair <code>` from any topic of the desired Telegram supergroup; the
     * bot captures `chat.id` and persists it as the workspace's accepted
     * supergroup, after which the adapter starts accepting messages from it.
     */
    generateSupergroupPairingCode(workspaceId: string, platform: string): {
        code: string;
        expiresAt: number;
        botUsername?: string;
    } {
        return registryPairing.generateSupergroupPairingCode(this, workspaceId, platform);
    }
    /**
     * Persist a paired supergroup at the workspace level and tell the running
     * adapter to start accepting its messages. Called from the gateway's
     * `pairingConsumer.bindWorkspaceSupergroup` hook after the user types
     * `/pair <code>` in the group, and also reachable directly via RPC for
     * future programmatic flows.
     */
    async bindWorkspaceSupergroup(workspaceId: string, platform: PlatformType, chatId: string, fallbackTitle?: string): Promise<{
        title: string;
    }> {
        return registryPairing.bindWorkspaceSupergroup(this, workspaceId, platform, chatId, fallbackTitle);
    }
    /**
     * Forget the paired supergroup. Existing topic-bound bindings are kept on
     * disk (they reference chatId only) but stop matching inbound updates
     * because the adapter rejects messages from the chat. Reconnecting the
     * same supergroup later restores routing.
     */
    async unbindWorkspaceSupergroup(workspaceId: string): Promise<void> {
        return registryPairing.unbindWorkspaceSupergroup(this, workspaceId);
    }
    /** Read accessor for the current paired supergroup, if any. */
    getWorkspaceSupergroup(workspaceId: string): {
        chatId: string;
        title: string;
        capturedAt: number;
    } | null {
        return registryPairing.getWorkspaceSupergroup(this, workspaceId);
    }
    /**
     * Bind a freshly-spawned automation session to a Telegram forum topic in
     * the workspace's paired supergroup. The topic is created on first use and
     * reused thereafter.
     *
     * Best-effort: returns a discriminated result instead of throwing so the
     * caller (SessionManager) can log + continue without blocking the session.
     */
    async bindAutomationSession(args: {
        workspaceId: string;
        sessionId: string;
        topicName: string;
    }): Promise<{
        ok: true;
        chatId: string;
        threadId: number;
        reused: boolean;
    } | {
        ok: false;
        reason: 'invalid-name' | 'no-supergroup' | 'no-adapter' | 'topic-create-failed';
        error?: string;
    }> {
        return registryPairing.bindAutomationSession(this, args);
    }
    /**
     * Drop a cached topic entry. Does NOT delete the topic in Telegram (the
     * bot has no signal that the user wants the history gone). Useful when
     * an automation is renamed/removed and the user wants the next use of
     * a topic name to create a fresh topic instead of reusing the cached one.
     */
    async removeAutomationTopic(workspaceId: string, topicName: string): Promise<void> {
        return registryPairing.removeAutomationTopic(this, workspaceId, topicName);
    }
    // -------------------------------------------------------------------------
    // IMessagingGatewayRegistry — platform lifecycle
    // -------------------------------------------------------------------------
    async testTelegramToken(token: string): Promise<{
        success: boolean;
        botName?: string;
        botUsername?: string;
        error?: string;
    }> {
        return registryCredentials.testTelegramToken(this, token);
    }
    async saveTelegramToken(workspaceId: string, token: string): Promise<void> {
        return registryCredentials.saveTelegramToken(this, workspaceId, token);
    }
    /**
     * Verify a Lark/Feishu App ID + App Secret pair by exchanging them for a
     * tenant access token. The Open Platform returns a structured error code
     * we forward to the user when the credentials are bad — saves a confused
     * round-trip through "Invalid token" guesses.
     */
    async testLarkCredentials(creds: LarkCredentials): Promise<{
        success: boolean;
        botName?: string;
        error?: string;
    }> {
        return registryCredentials.testLarkCredentials(this, creds);
    }
    async saveLarkCredentials(workspaceId: string, creds: LarkCredentials): Promise<void> {
        return registryCredentials.saveLarkCredentials(this, workspaceId, creds);
    }
    async disconnectPlatform(workspaceId: string, platform: string): Promise<void> {
        return registryCredentials.disconnectPlatform(this, workspaceId, platform);
    }
    async forgetPlatform(workspaceId: string, platform: string): Promise<void> {
        return registryCredentials.forgetPlatform(this, workspaceId, platform);
    }
    // -------------------------------------------------------------------------
    // WhatsApp — subprocess lifecycle
    // -------------------------------------------------------------------------
    async startWhatsAppConnect(workspaceId: string): Promise<void> {
        return registryConnections.startWhatsAppConnect(this, workspaceId);
    }
    async submitWhatsAppPhone(workspaceId: string, phoneNumber: string): Promise<void> {
        return registryConnections.submitWhatsAppPhone(this, workspaceId, phoneNumber);
    }
    /** @internal */ public async startWhatsAppAdapter(workspaceId: string, state: WorkspaceState, options: {
        persistConfig: boolean;
        reason: 'restore' | 'user_connect';
    }): Promise<void> {
        return registryConnections.startWhatsAppAdapter(this, workspaceId, state, options);
    }
    /** @internal */ public onWhatsAppEvent(workspaceId: string, event: WhatsAppEvent): void {
        return registryConnections.onWhatsAppEvent(this, workspaceId, event);
    }
    // -------------------------------------------------------------------------
    // EventSink-compatible callback
    // -------------------------------------------------------------------------
    onSessionEvent: EventSinkFn = (channel: string, target: PushTarget, ...args: unknown[]) => {
        if (channel !== RPC_CHANNELS.sessions.EVENT)
            return;
        const event = args[0] as SessionEvent | undefined;
        if (!event?.sessionId)
            return;
        const workspaceId = 'workspaceId' in target ? (target as {
            workspaceId: string;
        }).workspaceId : undefined;
        if (!workspaceId) {
            for (const state of this.workspaces.values()) {
                state.gateway.onSessionEvent(channel, target, ...args);
            }
            return;
        }
        const state = this.workspaces.get(workspaceId);
        if (state)
            state.gateway.onSessionEvent(channel, target, ...args);
    };
    private bootstrapWorkspace(workspaceId: string): WorkspaceState {
        return registryLifecycle.bootstrapWorkspace(this, workspaceId);
    }
    private async tryConnectLark(workspaceId: string, state: WorkspaceState): Promise<void> {
        return registryConnections.tryConnectLark(this, workspaceId, state);
    }
    private async tryConnectTelegram(workspaceId: string, state: WorkspaceState): Promise<void> {
        return registryConnections.tryConnectTelegram(this, workspaceId, state);
    }
    private setPlatformRuntime(workspaceId: string, state: WorkspaceState, platform: PlatformType, patch: PlatformRuntimePatch): void {
        return registryLifecycle.setPlatformRuntime(this, workspaceId, state, platform, patch);
    }
    /** @internal */ public emitBindingChanged(workspaceId: string): void {
        return registryEvents.emitBindingChanged(this, workspaceId);
    }
    /** @internal */ public emitPendingChanged(workspaceId: string): void {
        return registryEvents.emitPendingChanged(this, workspaceId);
    }
    private patchTelegramConfig(workspaceId: string, patch: TelegramConfigPatch, options: {
        ensureMessagingEnabled?: boolean;
    } = {}): MessagingConfig {
        return registryConfiguration.patchTelegramConfig(this, workspaceId, patch, options);
    }
    /** @internal */ public async seedFirstOwner(workspaceId: string, platform: PlatformType, candidate: PlatformOwner): Promise<PlatformOwner[]> {
        return registryAccess.seedFirstOwner(this, workspaceId, platform, candidate);
    }
    getPlatformOwners(workspaceId: string, platform: PlatformType): PlatformOwner[] {
        return registryAccess.getPlatformOwners(this, workspaceId, platform);
    }
    setPlatformOwners(workspaceId: string, platform: PlatformType, owners: PlatformOwner[]): PlatformOwner[] {
        return registryAccess.setPlatformOwners(this, workspaceId, platform, owners);
    }
    getPlatformAccessMode(workspaceId: string, platform: PlatformType): PlatformAccessMode {
        return registryAccess.getPlatformAccessMode(this, workspaceId, platform);
    }
    setPlatformAccessMode(workspaceId: string, platform: PlatformType, mode: PlatformAccessMode): void {
        return registryAccess.setPlatformAccessMode(this, workspaceId, platform, mode);
    }
    /** @internal */ public migrateOpenBindingsToInherit(workspaceId: string): void {
        return registryAccess.migrateOpenBindingsToInherit(this, workspaceId);
    }
    /** Pending senders surface in Settings → Messaging as "Pending requests". */
    getPendingSenders(workspaceId: string, platform?: PlatformType): PendingSender[] {
        return registryAccess.getPendingSenders(this, workspaceId, platform);
    }
    dismissPendingSender(workspaceId: string, platform: PlatformType, userId: string): boolean {
        return registryAccess.dismissPendingSender(this, workspaceId, platform, userId);
    }
    /**
     * Allow a pending sender. Behaviour depends on why the sender was
     * rejected:
     *
     * - `'not-owner'` (workspace-level reject) → add to platform `owners`.
     *   Result: sender can run pre-binding commands and inherits binding
     *   access for `accessMode === 'inherit'` bindings.
     * - `'not-on-binding-allowlist'` (binding-level reject) → append to
     *   that binding's `allowedSenderIds`. Workspace owners list is NOT
     *   touched — closing the privilege-escalation footgun where a Bob
     *   denied by a single sensitive binding would have been promoted to
     *   workspace owner.
     *
     * `entryKey` identifies the specific pending row (a sender may have
     * multiple — one per reason/binding combination). When omitted, the
     * earliest matching entry for the sender is used.
     */
    allowPendingSender(workspaceId: string, platform: PlatformType, userId: string, entryKey?: {
        reason?: PendingSender['reason'];
        bindingId?: string;
    }): {
        owners: PlatformOwner[];
        bindingId?: string;
    } {
        return registryAccess.allowPendingSender(this, workspaceId, platform, userId, entryKey);
    }
    /**
     * Update the access policy on a single binding. Uses the in-place
     * `updateBindingConfig` method so the binding's `id` and `createdAt`
     * survive — anything keyed on bindingId (audit logs, deep links, stale
     * renderer closures) keeps working.
     */
    setBindingAccess(workspaceId: string, bindingId: string, access: {
        mode: BindingAccessMode;
        allowedSenderIds?: string[];
    }): void {
        return registryAccess.setBindingAccess(this, workspaceId, bindingId, access);
    }
    /** @internal */ public emitPlatformStatus(workspaceId: string, platform: PlatformType, status: MessagingPlatformRuntimeInfo): void {
        return registryLifecycle.emitPlatformStatus(this, workspaceId, platform, status);
    }
    /** @internal */ public hasWhatsAppAuthState(workspaceId: string): boolean {
        return registryConnections.hasWhatsAppAuthState(this, workspaceId);
    }
    private getWhatsAppAuthStateDir(workspaceId: string): string {
        return registryConnections.getWhatsAppAuthStateDir(this, workspaceId);
    }
}
