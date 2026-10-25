/**
 * MessagingGateway — orchestrator for messaging platform adapters.
 *
 * Runs in-process alongside SessionManager. Wires adapters, router,
 * renderer, and binding store together. One instance per workspace.
 */
import type { ISessionManager } from "@craft-agent/server-core/handlers";
import type { PushTarget } from "@craft-agent/shared/protocol";
import { BindingStore } from "./binding-store";
import { Router } from "./router";
import { Commands, type AccessControlDeps } from "./commands";
import { Renderer, type SessionEvent } from "./renderer";
import { PendingSendersStore } from "./pending-senders";
import { PlanTokenRegistry } from "./plan-tokens";
import type { PlatformAdapter, PlatformType, IncomingMessage, ButtonPress, MessagingLogger } from "./types";
import { consoleLogger } from './gateway/shared.ts';
import type { GatewayOptions, PlanMessageRecord, PermissionMessageRecord, PendingCompactAccept } from './gateway/shared.ts';
import * as gatewayConnection from './gateway/connection.ts';
import * as gatewayEvents from './gateway/events.ts';
import * as gatewayPermissions from './gateway/permissions.ts';
import * as gatewayButtons from './gateway/buttons.ts';
export type { GatewayOptions } from './gateway/shared.ts';

export class MessagingGateway {
    private readonly sessionManager: ISessionManager;
    private readonly workspaceId: string;
    private readonly bindingStore: BindingStore;
    private readonly pendingStore: PendingSendersStore;
    private readonly router: Router;
    private readonly commands: Commands;
    private readonly renderer: Renderer;
    private readonly planTokens: PlanTokenRegistry;
    private readonly planMessages = new Map<string, PlanMessageRecord>();
    /** Live permission prompts, keyed by `requestId`. See PermissionMessageRecord. */
    private readonly permissionMessages = new Map<string, PermissionMessageRecord>();
    private readonly pendingCompactAccepts = new Map<string, PendingCompactAccept>();
    private readonly adapters = new Map<PlatformType, PlatformAdapter>();
    private readonly log: MessagingLogger;
    private started = false;
    /**
     * Access-control surface — `getWorkspaceConfig` is called per-button so
     * config edits take effect without restart, mirroring the text path.
     * `recentRejectReplies` is a separate cooldown map from Router/Commands
     * so callback-button rejection rate-limiting is independent of text
     * rejection rate-limiting (a stranger spamming buttons doesn't lock
     * out their text-channel reply, and vice versa).
     */
    private readonly accessDeps: AccessControlDeps;
    private readonly buttonRecentRejectReplies = new Map<string, number>();
    constructor(opts: GatewayOptions) {
        this.sessionManager = opts.sessionManager;
        this.workspaceId = opts.workspaceId;
        this.log = (opts.logger ?? consoleLogger).child({
            component: 'gateway',
            workspaceId: opts.workspaceId,
        });
        this.bindingStore = new BindingStore(opts.storageDir, opts.legacyStorageDir, this.log.child({ component: 'binding-store' }));
        if (opts.onBindingChanged) {
            this.bindingStore.onChange(opts.onBindingChanged);
        }
        this.pendingStore = new PendingSendersStore(opts.storageDir, this.log.child({ component: 'pending-senders' }));
        if (opts.onPendingChanged) {
            this.pendingStore.onChange(opts.onPendingChanged);
        }
        this.accessDeps = {
            getWorkspaceConfig: opts.getWorkspaceConfig ?? (() => ({ enabled: false, platforms: {} })),
            seedOwnerOnFirstPair: opts.seedOwnerOnFirstPair ?? (async () => []),
            pendingStore: this.pendingStore,
        };
        this.commands = new Commands(opts.sessionManager, this.bindingStore, opts.workspaceId, opts.pairingConsumer, this.log.child({ component: 'commands' }), this.accessDeps);
        this.router = new Router(opts.sessionManager, this.bindingStore, this.commands, this.log.child({ component: 'router' }), {
            getWorkspaceConfig: this.accessDeps.getWorkspaceConfig,
            pendingStore: this.pendingStore,
        });
        this.planTokens = new PlanTokenRegistry();
        this.renderer = new Renderer({
            planTokens: this.planTokens,
            // The renderer hands us the exact binding that sent the message.
            // We must not resolve it ourselves — `findBySession` returns every
            // binding and picking the first Telegram binding attributes the
            // message to the wrong chat whenever the session has more than one.
            recordPlanMessage: (binding, token, messageId) => {
                this.planMessages.set(token, {
                    bindingId: binding.id,
                    platform: binding.platform,
                    channelId: binding.channelId,
                    messageId,
                });
            },
            recordPermissionMessage: (binding, requestId, messageId) => {
                this.permissionMessages.set(requestId, {
                    bindingId: binding.id,
                    sessionId: binding.sessionId,
                    platform: binding.platform,
                    channelId: binding.channelId,
                    messageId,
                    ...(binding.threadId !== undefined ? { threadId: binding.threadId } : {}),
                });
            },
        });
    }
    // -------------------------------------------------------------------------
    // Adapter registration
    // -------------------------------------------------------------------------
    registerAdapter(adapter: PlatformAdapter): void {
        return gatewayConnection.registerAdapter(this, adapter);
    }
    async unregisterAdapter(platform: PlatformType): Promise<void> {
        return gatewayConnection.unregisterAdapter(this, platform);
    }
    getAdapter(platform: PlatformType): PlatformAdapter | undefined {
        return this.adapters.get(platform);
    }
    hasConnectedAdapter(platform: PlatformType): boolean {
        return this.adapters.get(platform)?.isConnected() ?? false;
    }
    // -------------------------------------------------------------------------
    // Lifecycle
    // -------------------------------------------------------------------------
    async start(): Promise<void> {
        return gatewayConnection.start(this);
    }
    async stop(): Promise<void> {
        return gatewayConnection.stop(this);
    }
    private wireAdapter(adapter: PlatformAdapter): void {
        return gatewayConnection.wireAdapter(this, adapter);
    }
    // -------------------------------------------------------------------------
    // Event handling (called by fan-out EventSink)
    // -------------------------------------------------------------------------
    onSessionEvent(channel: string, _target: PushTarget, ...args: unknown[]): void {
        return gatewayEvents.onSessionEvent(this, channel, _target, ...args);
    }
    private sweepStalePermissions(event: SessionEvent): void {
        return gatewayPermissions.sweepStalePermissions(this, event);
    }
    private async handleButtonPress(platform: PlatformType, press: ButtonPress): Promise<void> {
        return gatewayButtons.handleButtonPress(this, platform, press);
    }
    private async handlePermissionButton(adapter: PlatformAdapter, press: ButtonPress): Promise<void> {
        return gatewayPermissions.handlePermissionButton(this, adapter, press);
    }
    private async handlePlanButton(platform: PlatformType, adapter: PlatformAdapter, press: ButtonPress): Promise<void> {
        return gatewayButtons.handlePlanButton(this, platform, adapter, press);
    }
    private async gateButtonPress(adapter: PlatformAdapter, press: ButtonPress): Promise<boolean> {
        return gatewayButtons.gateButtonPress(this, adapter, press);
    }
    private synthesizeMsgForGate(press: ButtonPress): IncomingMessage {
        return gatewayButtons.synthesizeMsgForGate(this, press);
    }
    private async finishPendingCompactAccept(sessionId: string): Promise<void> {
        return gatewayPermissions.finishPendingCompactAccept(this, sessionId);
    }
    // -------------------------------------------------------------------------
    // Accessors
    // -------------------------------------------------------------------------
    getBindingStore(): BindingStore {
        return this.bindingStore;
    }
    getPendingStore(): PendingSendersStore {
        return this.pendingStore;
    }
    isStarted(): boolean {
        return this.started;
    }
}
