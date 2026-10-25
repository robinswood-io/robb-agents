import { evaluateBindingAccess, evaluatePreBindingAccess, executeRejection } from "../access-control";
import type { PlatformAdapter, PlatformType, IncomingMessage, ButtonPress } from "../types";
import type { MessagingGateway } from '../gateway.ts';

// -------------------------------------------------------------------------
  // Button handling
  // -------------------------------------------------------------------------
export async function handleButtonPress(transportOwner: MessagingGateway, platform: PlatformType, press: ButtonPress): Promise<void> {
    const adapter = transportOwner["adapters"].get(platform);
    if (!adapter)
        return;
    // Press metadata reused across all branches so responses post back into
    // the same topic (Telegram supergroup) the button was tapped from.
    const pressOpts = press.threadId !== undefined ? { threadId: press.threadId } : {};
    // Access gate. Inline buttons in supergroup topics are visible to
    // every member of the chat, so without this gate any non-owner could
    // tap `bind:`/`perm:`/`plan:` and bypass the text-side filter. The
    // text path is locked but callbacks would not be — that's exactly
    // the "looks locked but isn't" UX the access control is meant to
    // prevent.
    const allowed = await transportOwner["gateButtonPress"](adapter, press);
    if (!allowed)
        return;
    if (press.buttonId.startsWith('bind:')) {
        const sessionId = press.buttonId.slice('bind:'.length);
        const session = await transportOwner["sessionManager"].getSession(sessionId);
        if (!session) {
            await adapter.sendText(press.channelId, 'Session not found.', pressOpts);
            return;
        }
        transportOwner["bindingStore"].bind(transportOwner["workspaceId"], session.id, platform, press.channelId, undefined, undefined, press.threadId);
        await adapter.sendText(press.channelId, `Bound to "${session.name || session.id}"`, pressOpts);
        return;
    }
    if (press.buttonId.startsWith('perm:')) {
        if (platform === 'whatsapp') {
            transportOwner["log"].warn('ignored chat-side permission interaction for WhatsApp', {
                event: 'whatsapp_permission_button_ignored',
                channelId: press.channelId,
                buttonId: press.buttonId,
            });
            await adapter.sendText(press.channelId, '⏸ Permission required. Approve it in the desktop app to continue.', pressOpts);
            return;
        }
        await transportOwner["handlePermissionButton"](adapter, press);
        return;
    }
    if (press.buttonId.startsWith('plan:')) {
        await transportOwner["handlePlanButton"](platform, adapter, press);
        return;
    }
}

export async function handlePlanButton(transportOwner: MessagingGateway, platform: PlatformType, adapter: PlatformAdapter, press: ButtonPress): Promise<void> {
    const parts = press.buttonId.split(':');
    const action = parts[1];
    const token = parts[2];
    if (!token || (action !== 'accept' && action !== 'compact'))
        return;
    const pressOpts = press.threadId !== undefined ? { threadId: press.threadId } : {};
    const entry = transportOwner["planTokens"].resolve(token);
    if (!entry) {
        await adapter.sendText(press.channelId, '⚠️ This plan has expired. Retry from the desktop app.', pressOpts);
        return;
    }
    // Disable the buttons so the user can't tap twice. Non-fatal if it fails.
    const record = transportOwner["planMessages"].get(token);
    if (record && adapter.clearButtons) {
        await adapter.clearButtons(record.channelId, record.messageId).catch(() => { });
    }
    transportOwner["planTokens"].revoke(token);
    transportOwner["planMessages"].delete(token);
    if (action === 'accept') {
        try {
            await transportOwner["sessionManager"].acceptPlan(entry.sessionId, entry.planPath);
            await adapter.sendText(press.channelId, '✅ Plan accepted. Agent resuming.', pressOpts);
        }
        catch (err) {
            transportOwner["log"].error('acceptPlan failed', {
                event: 'plan_accept_failed',
                sessionId: entry.sessionId,
                error: err,
            });
            await adapter.sendText(press.channelId, '❌ Couldn\'t accept the plan. Check the desktop app.', pressOpts);
        }
        return;
    }
    // action === 'compact': persist the "waiting for compaction" intent, send
    // /compact, and let onSessionEvent → finishPendingCompactAccept dispatch
    // the approval once compaction finishes.
    const binding = transportOwner["bindingStore"].findByChannel(platform, press.channelId, press.threadId);
    if (!binding)
        return;
    transportOwner["pendingCompactAccepts"].set(entry.sessionId, {
        token,
        sessionId: entry.sessionId,
        bindingId: binding.id,
        platform,
        channelId: press.channelId,
        ...(press.threadId !== undefined ? { threadId: press.threadId } : {}),
        messageId: record?.messageId ?? '',
        planPath: entry.planPath,
        createdAt: Date.now(),
    });
    try {
        await transportOwner["sessionManager"].setPendingPlanExecution(entry.sessionId, entry.planPath);
        await transportOwner["sessionManager"].sendMessage(entry.sessionId, '/compact');
        await adapter.sendText(press.channelId, '♻️ Compacting conversation, then executing the plan…', pressOpts);
    }
    catch (err) {
        transportOwner["pendingCompactAccepts"].delete(entry.sessionId);
        transportOwner["log"].error('compact dispatch failed', {
            event: 'plan_compact_failed',
            sessionId: entry.sessionId,
            error: err,
        });
        await adapter.sendText(press.channelId, '❌ Couldn\'t start compaction. Check the desktop app.', pressOpts);
    }
}

/**
   * Decide whether a button press may proceed. `bind:` is workspace-owner
   * only (matches the `/bind` text command); `perm:` and `plan:` are gated
   * by the binding's access policy (matches the routing-time check in
   * Router.route). Bot senders are silent-dropped before any other logic.
   *
   * Returns true to proceed, false on reject (caller must return early).
   * The reject path emits the friendly reply and records the sender in
   * the pending-senders store via the shared `executeRejection` helper.
   */
export async function gateButtonPress(transportOwner: MessagingGateway, adapter: PlatformAdapter, press: ButtonPress): Promise<boolean> {
    const senderShape: import('../access-control').RejectableSender = {
        platform: press.platform,
        channelId: press.channelId,
        ...(press.threadId !== undefined ? { threadId: press.threadId } : {}),
        senderId: press.senderId,
        ...(press.senderName ? { senderName: press.senderName } : {}),
        ...(press.senderUsername ? { senderUsername: press.senderUsername } : {}),
    };
    let verdict: import('../access-control').AccessDecision;
    let extra: {
        bindingId?: string;
        sessionId?: string;
    } = {};
    if (press.buttonId.startsWith('bind:')) {
        // `bind:` runs the same gate as the `/bind` text command — the
        // operator who emitted the keyboard is offering session-binding
        // privileges, but only owners may take them.
        verdict = evaluatePreBindingAccess({
            msg: transportOwner["synthesizeMsgForGate"](press),
            workspaceConfig: transportOwner["accessDeps"].getWorkspaceConfig(),
        });
    }
    else if (press.buttonId.startsWith('perm:') ||
        press.buttonId.startsWith('plan:')) {
        // `perm:`/`plan:` are session-level approvals; the sender must have
        // routing access to the binding the button was attached to.
        const binding = transportOwner["bindingStore"].findByChannel(press.platform, press.channelId, press.threadId);
        if (!binding) {
            // No binding to evaluate against — fall through to the existing
            // "not bound" handling in the caller (which will silently no-op
            // for perm/plan since they require a binding lookup anyway).
            return true;
        }
        extra = { bindingId: binding.id, sessionId: binding.sessionId };
        verdict = evaluateBindingAccess({
            msg: transportOwner["synthesizeMsgForGate"](press),
            workspaceConfig: transportOwner["accessDeps"].getWorkspaceConfig(),
            binding,
        });
    }
    else {
        // Unknown button prefix — let the caller handle it.
        return true;
    }
    if (verdict.allow)
        return true;
    await executeRejection(adapter, senderShape, verdict.reason, {
        recentRejectReplies: transportOwner["buttonRecentRejectReplies"],
        pendingStore: transportOwner["pendingStore"],
    }, transportOwner["log"], extra);
    return false;
}

/**
   * Build the minimum `IncomingMessage` shape the access evaluators read.
   * The evaluators only consult `platform`, `senderId`, `senderIsBot` —
   * everything else is dummy/empty for the button-press path.
   */
export function synthesizeMsgForGate(transportOwner: MessagingGateway, press: ButtonPress): IncomingMessage {
    return {
        platform: press.platform,
        channelId: press.channelId,
        ...(press.threadId !== undefined ? { threadId: press.threadId } : {}),
        messageId: press.messageId,
        senderId: press.senderId,
        ...(press.senderName ? { senderName: press.senderName } : {}),
        ...(press.senderUsername ? { senderUsername: press.senderUsername } : {}),
        ...(press.senderIsBot ? { senderIsBot: true } : {}),
        text: '',
        timestamp: Date.now(),
        raw: press,
    };
}
