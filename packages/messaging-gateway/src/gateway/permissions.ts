import { type SessionEvent } from "../renderer";
import type { PlatformAdapter, ButtonPress } from "../types";
import type { MessagingGateway } from '../gateway.ts';
import { COMPACT_ACCEPT_TTL_MS } from './shared.ts';

/**
   * Drop entries from `permissionMessages` whose requestId differs from the
   * event's current permission request (or all of them, for non-permission
   * events). For each dropped entry we also fire-and-forget a `clearButtons`
   * so Telegram won't deliver any further callbacks for the stale prompt.
   *
   * Same-requestId `permission_request` events are preserved so a re-render
   * (rare but possible when the renderer retries) doesn't blow away the
   * record we'd then need to re-create.
   */
export function sweepStalePermissions(transportOwner: MessagingGateway, event: SessionEvent): void {
    if (transportOwner["permissionMessages"].size === 0)
        return;
    const eventRequestId = event.type === 'permission_request'
        ? ((event.request as {
            requestId?: string;
        } | undefined)?.requestId ?? null)
        : null;
    for (const [requestId, record] of transportOwner["permissionMessages"]) {
        if (record.sessionId !== event.sessionId)
            continue;
        if (requestId === eventRequestId)
            continue;
        transportOwner["permissionMessages"].delete(requestId);
        const adapter = transportOwner["adapters"].get(record.platform);
        if (adapter?.clearButtons && adapter.isConnected()) {
            adapter.clearButtons(record.channelId, record.messageId).catch(() => { });
        }
        transportOwner["log"].info('cleared stale permission prompt after agent moved on', {
            event: 'perm_prompt_cleared_stale',
            requestId,
            sessionId: record.sessionId,
            triggerEventType: event.type,
        });
    }
}

/**
   * Handle an inline `perm:allow:<id>` / `perm:deny:<id>` press.
   *
   * Brought to parity with `handlePlanButton` (#726): claim the prompt via
   * `permissionMessages.delete()` before any visible action so a second tap
   * silently no-ops, clear the inline keyboard so Telegram won't even
   * deliver further callbacks for it, and only post the user-facing
   * `✅ Allowed / ❌ Denied` confirmation when `respondToPermission` reports
   * the response was actually delivered to a live agent.
   */
export async function handlePermissionButton(transportOwner: MessagingGateway, adapter: PlatformAdapter, press: ButtonPress): Promise<void> {
    const startedAt = Date.now();
    const pressOpts = press.threadId !== undefined ? { threadId: press.threadId } : {};
    const parts = press.buttonId.split(':');
    const action = parts[1];
    const requestId = parts[2];
    if (!requestId || (action !== 'allow' && action !== 'deny'))
        return;
    // Idempotency claim: remove the entry up-front. A concurrent second tap
    // (or a race with the stale-prompt sweep in onSessionEvent) finds nothing
    // here and exits silently — no duplicate "✅ Allowed" message.
    const record = transportOwner["permissionMessages"].get(requestId);
    if (!record) {
        transportOwner["log"].info('perm press dropped: no live prompt for requestId', {
            event: 'perm_press_stale',
            requestId,
            channelId: press.channelId,
            senderId: press.senderId,
        });
        return;
    }
    transportOwner["permissionMessages"].delete(requestId);
    // Clear the inline keyboard before doing anything else so Telegram won't
    // deliver further callbacks for this prompt at all.
    if (adapter.clearButtons) {
        await adapter.clearButtons(record.channelId, record.messageId).catch(() => { });
    }
    const allowed = action === 'allow';
    const delivered = transportOwner["sessionManager"].respondToPermission(record.sessionId, requestId, allowed, false);
    transportOwner["log"].info('perm response routed to session manager', {
        event: 'perm_response_routed',
        requestId,
        sessionId: record.sessionId,
        action,
        delivered,
        elapsedMs: Date.now() - startedAt,
    });
    if (!delivered) {
        // Session/agent gone or the prompt was already resolved by another
        // channel between our `permissionMessages.get()` and here. Don't post a
        // misleading "✅ Allowed" — the action did not take effect on this side.
        return;
    }
    await adapter.sendText(press.channelId, allowed ? '✅ Allowed' : '❌ Denied', pressOpts);
}

export async function finishPendingCompactAccept(transportOwner: MessagingGateway, sessionId: string): Promise<void> {
    const entry = transportOwner["pendingCompactAccepts"].get(sessionId);
    if (!entry)
        return;
    transportOwner["pendingCompactAccepts"].delete(sessionId);
    if (Date.now() - entry.createdAt > COMPACT_ACCEPT_TTL_MS) {
        transportOwner["log"].warn('dropping stale compact-accept entry', {
            event: 'plan_compact_stale',
            sessionId,
        });
        return;
    }
    const adapter = transportOwner["adapters"].get(entry.platform);
    const opts = entry.threadId !== undefined ? { threadId: entry.threadId } : {};
    try {
        await transportOwner["sessionManager"].acceptPlan(sessionId, entry.planPath);
        await transportOwner["sessionManager"].clearPendingPlanExecution(sessionId);
        if (adapter?.isConnected()) {
            await adapter.sendText(entry.channelId, '✅ Plan executing after compaction.', opts);
        }
    }
    catch (err) {
        transportOwner["log"].error('post-compaction acceptPlan failed', {
            event: 'plan_post_compact_accept_failed',
            sessionId,
            error: err,
        });
        if (adapter?.isConnected()) {
            await adapter.sendText(entry.channelId, '❌ Compaction finished but the plan couldn\'t execute. Check the desktop app.', opts);
        }
    }
}
