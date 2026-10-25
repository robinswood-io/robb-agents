/**
 * Commands — handles chat commands from unbound or bound channels.
 *
 * /new [name]    — create session + bind
 * /bind          — list recent sessions (or by id / index)
 * /pair <code>   — finish a session-initiated pairing flow
 * /unbind        — disconnect channel
 * /help          — show available commands
 * /status        — show current binding
 * /stop          — abort the current agent run
 */
import type { ISessionManager } from "@craft-agent/server-core/handlers";
import { type AccessRejectReason } from "./access-control";
import type { BindingStore } from "./binding-store";
import type { IncomingMessage, MessagingLogger, PlatformAdapter } from "./types";
import { NOOP_LOGGER } from './commands/shared.ts';
import type { PairingCodeConsumer, AccessControlDeps } from './commands/shared.ts';
import * as commandsAdmission from './commands/admission.ts';
import * as commandsBinding from './commands/binding.ts';
import * as commandsControl from './commands/control.ts';
export type { PairingConsumeResult, PairingCodeConsumer, AccessControlDeps } from './commands/shared.ts';
export { parseCommand } from './commands/shared.ts';

export class Commands {
    private readonly log: MessagingLogger;
    private readonly access: AccessControlDeps;
    private readonly recentRejectReplies = new Map<string, number>();
    constructor(private readonly sessionManager: ISessionManager, private readonly bindingStore: BindingStore, private readonly workspaceId: string, private readonly pairingConsumer?: PairingCodeConsumer, logger: MessagingLogger = NOOP_LOGGER, access: AccessControlDeps = {
        getWorkspaceConfig: () => ({ enabled: false, platforms: {} }),
        seedOwnerOnFirstPair: async () => [],
    }) {
        this.log = logger;
        this.access = access;
    }
    async handle(adapter: PlatformAdapter, msg: IncomingMessage): Promise<void> {
        return commandsAdmission.handle(this, adapter, msg);
    }
    async handleCommand(adapter: PlatformAdapter, msg: IncomingMessage): Promise<boolean> {
        return commandsAdmission.handleCommand(this, adapter, msg);
    }
    private async sendRejection(adapter: PlatformAdapter, msg: IncomingMessage, reason: AccessRejectReason): Promise<void> {
        return commandsAdmission.sendRejection(this, adapter, msg, reason);
    }
    private async handleNew(adapter: PlatformAdapter, msg: IncomingMessage): Promise<void> {
        return commandsBinding.handleNew(this, adapter, msg);
    }
    private async handleBind(adapter: PlatformAdapter, msg: IncomingMessage): Promise<void> {
        return commandsBinding.handleBind(this, adapter, msg);
    }
    private async handlePair(adapter: PlatformAdapter, msg: IncomingMessage): Promise<void> {
        return commandsBinding.handlePair(this, adapter, msg);
    }
    private async handleSupergroupPair(adapter: PlatformAdapter, msg: IncomingMessage, entry: {
        workspaceId: string;
    }, replyOpts: {
        threadId?: number;
    }): Promise<void> {
        return commandsBinding.handleSupergroupPair(this, adapter, msg, entry, replyOpts);
    }
    private async handleUnbind(adapter: PlatformAdapter, msg: IncomingMessage): Promise<void> {
        return commandsBinding.handleUnbind(this, adapter, msg);
    }
    private async handleStatus(adapter: PlatformAdapter, msg: IncomingMessage): Promise<void> {
        return commandsControl.handleStatus(this, adapter, msg);
    }
    private async handleStop(adapter: PlatformAdapter, msg: IncomingMessage): Promise<void> {
        return commandsControl.handleStop(this, adapter, msg);
    }
    private async handleHelp(adapter: PlatformAdapter, msg: IncomingMessage): Promise<void> {
        return commandsControl.handleHelp(this, adapter, msg);
    }
    private getRecentSessions(): ReturnType<ISessionManager['getSessions']> {
        return commandsControl.getRecentSessions(this);
    }
    private async resolveBindTarget(bindArg: string, recent: ReturnType<ISessionManager['getSessions']>): Promise<Awaited<ReturnType<ISessionManager['getSession']>> | undefined> {
        return commandsControl.resolveBindTarget(this, bindArg, recent);
    }
}
