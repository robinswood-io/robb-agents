import type { SessionOperationContext } from '../operation-context.ts';
import { getAdminRememberKey } from '../policy.ts';
import type { EventSink, RpcServer } from '@craft-agent/server-core/transport';
import { CLIENT_BROWSER_INVOKE } from '@craft-agent/server-core/transport';
import type { IBrowserPaneManager } from '@craft-agent/server-core/handlers';
import { RemoteBrowserPaneManager } from '../../RemoteBrowserPaneManager';
import { sessionLog } from '../runtime-platform.ts';

/** Wait until initialize() has completed (sessions loaded from disk).
 *  Resolves immediately if already initialized. */
function sessionOpWaitForInit(sessionOperationContext: SessionOperationContext): Promise<void> {
    return sessionOperationContext.state.initGate.wait();
}

/**
 * Install the automation→topic binder. Wired by the messaging-gateway
 * bootstrap so SessionManager doesn't need to import the messaging
 * package (avoids a package-level circular dependency).
 */
function sessionOpSetAutomationBinder(sessionOperationContext: SessionOperationContext, fn: (input: {
    workspaceId: string;
    sessionId: string;
    topicName: string;
}) => Promise<void>): void {
    sessionOperationContext.state.automationBinder = fn;
}

function sessionOpSetEventSink(sessionOperationContext: SessionOperationContext, sink: EventSink): void {
    sessionOperationContext.state.eventSink = sink;
}

function sessionOpSetBrowserPaneManager(sessionOperationContext: SessionOperationContext, bpm: IBrowserPaneManager): void {
    sessionOperationContext.state.browserPaneManager = bpm;
    bpm.setSessionPathResolver((sessionId) => sessionOperationContext.owner.getSessionPath(sessionId));
}

/**
 * Provide the WS RPC server so remote clients can host browser tools.
 *
 * When called, the SM activates the remote-bridge code path: per-session
 * `RemoteBrowserPaneManager` instances are created lazily by
 * {@link getBrowserPaneManagerForSession}, and the browser-host client is
 * resolved via {@link getBrowserHostClient} with capability-aware fallback.
 *
 * Local Electron callers do not need to call this — they already
 * call `setBrowserPaneManager(bpm)` with the in-process BPM, which takes
 * precedence over the remote bridge in {@link getBrowserPaneManagerForSession}.
 */
function sessionOpSetRpcServer(sessionOperationContext: SessionOperationContext, server: RpcServer): void {
    sessionOperationContext.state.rpcServer = server;
    sessionLog.info('[browser-pane] setRpcServer called — remote browser bridge is now available');
}

/**
 * Resolve the {@link IBrowserPaneManager} that owns the user's local browser
 * for a given session. Returns:
 *
 * 1. The locally-injected `browserPaneManager` when present (Electron client co-located
 *    with the agent), regardless of session.
 * 2. A session-bound {@link RemoteBrowserPaneManager} when `rpcServer` is set.
 *    Cached in `remoteBpms` so repeat lookups don't allocate.
 * 3. `null` when there's neither a local BPM nor an RPC server.
 */
function sessionOpGetBrowserPaneManagerForSession(sessionOperationContext: SessionOperationContext, sid: string): IBrowserPaneManager | null {
    if (sessionOperationContext.state.browserPaneManager)
        return sessionOperationContext.state.browserPaneManager;
    if (!sessionOperationContext.state.rpcServer)
        return null;
    const cached = sessionOperationContext.state.remoteBpms.get(sid);
    if (cached)
        return cached;
    const session = sessionOperationContext.state.sessions.get(sid);
    if (!session)
        return null;
    const bridge = new RemoteBrowserPaneManager({
        sessionId: sid,
        workspaceId: session.workspace.id,
        rpcServer: sessionOperationContext.state.rpcServer,
        getHostClient: () => sessionOpGetBrowserHostClient(sessionOperationContext, sid),
    });
    sessionOperationContext.state.remoteBpms.set(sid, bridge);
    return bridge;
}

/**
 * Record which desktop client should host this session's browser. Called
 * with `ctx.clientId` from the `sessions.sendMessage` RPC handler so the
 * agent's browser_* tools route back to the client that posted the message.
 *
 * No-op when `callerClientId` is undefined — preserves the existing pin
 * (lets reconnected clients continue holding the host role).
 */
function sessionOpSetLastMessageClientId(sessionOperationContext: SessionOperationContext, sid: string, callerClientId: string | undefined): void {
    if (!callerClientId)
        return;
    sessionOperationContext.state.browserHostByCanvas.set(sid, callerClientId);
}

/**
 * Called by the transport bootstrap on `onClientDisconnected`. Drops any
 * pins held by `clientId` so the next browser tool call re-resolves via
 * {@link findClientsWithCapability} instead of trying to ship to a dead client.
 */
function sessionOpOnClientDisconnected(sessionOperationContext: SessionOperationContext, clientId: string): void {
    for (const [sid, pinned] of sessionOperationContext.state.browserHostByCanvas) {
        if (pinned === clientId)
            sessionOperationContext.state.browserHostByCanvas.delete(sid);
    }
}

/**
 * Pinned client first, with fallback to any connected client for the workspace
 * that advertises `client:browser:invoke`. The fallback handles reconnect-with-
 * new-clientId so the agent isn't stuck waiting for another user message.
 */
function sessionOpGetBrowserHostClient(sessionOperationContext: SessionOperationContext, sid: string): string | null {
    if (!sessionOperationContext.state.rpcServer)
        return null;
    const pinned = sessionOperationContext.state.browserHostByCanvas.get(sid);
    if (pinned && sessionOperationContext.state.rpcServer.hasClientCapability(pinned, CLIENT_BROWSER_INVOKE)) {
        return pinned;
    }
    const session = sessionOperationContext.state.sessions.get(sid);
    if (!session)
        return null;
    const candidates = sessionOperationContext.state.rpcServer.findClientsWithCapability(CLIENT_BROWSER_INVOKE, { workspaceId: session.workspace.id });
    const fallback = candidates[0];
    if (!fallback)
        return null;
    sessionOperationContext.state.browserHostByCanvas.set(sid, fallback);
    return fallback;
}

/** Returns a strictly increasing timestamp (ms). When Date.now() collides with
 *  the previous value, increments by 1 to preserve event ordering. */
function sessionOpMonotonic(sessionOperationContext: SessionOperationContext): number {
    const now = Date.now();
    sessionOperationContext.state.lastTimestamp = now > sessionOperationContext.state.lastTimestamp ? now : sessionOperationContext.state.lastTimestamp + 1;
    return sessionOperationContext.state.lastTimestamp;
}

function sessionOpHasActiveAdminRememberApproval(sessionOperationContext: SessionOperationContext, sessionId: string, commandHash: string): boolean {
    const key = getAdminRememberKey(sessionId, commandHash);
    const entry = sessionOperationContext.state.adminRememberApprovals.get(key);
    if (!entry) {
        return false;
    }
    if (Date.now() > entry.expiresAt) {
        sessionOperationContext.state.adminRememberApprovals.delete(key);
        sessionOperationContext.state.privilegedExecutionBroker.auditEvent('privileged_remember_window_expired', {
            sessionId,
            commandHash,
            sourceRequestId: entry.sourceRequestId,
            expiresAt: entry.expiresAt,
        });
        return false;
    }
    return true;
}

export { sessionOpWaitForInit as waitForInit };
export { sessionOpSetAutomationBinder as setAutomationBinder };
export { sessionOpSetEventSink as setEventSink };
export { sessionOpSetBrowserPaneManager as setBrowserPaneManager };
export { sessionOpSetRpcServer as setRpcServer };
export { sessionOpGetBrowserPaneManagerForSession as getBrowserPaneManagerForSession };
export { sessionOpSetLastMessageClientId as setLastMessageClientId };
export { sessionOpOnClientDisconnected as onClientDisconnected };
export { sessionOpGetBrowserHostClient as getBrowserHostClient };
export { sessionOpMonotonic as monotonic };
export { sessionOpHasActiveAdminRememberApproval as hasActiveAdminRememberApproval };
