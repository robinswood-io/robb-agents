import { isContextOverflow } from "@earendil-works/pi-ai";
import { createProviderHandoffPreflight } from "../provider-handoff.ts";
import { recoverContextOverflow } from "../overflow-recovery.ts";
import { prepareMessagesForIncompleteTailContinuation } from "../incomplete-tool-tail-recovery.ts";
import { extractRecentUserTexts } from "../source-tool-activation.ts";
import type { InboundMessage } from "./contracts.ts";
import type { PiRuntimeState } from "./runtime-state.ts";
import { handleSessionEvent } from "./events.ts";
import { ensureSession } from "./session.ts";
import { debugLog, send } from "./stdio.ts";

/**
 * Wait for any in-flight compaction to finish before sending a prompt or
 * starting another compaction. Prevents a race in the Pi SDK where concurrent
 * _runAutoCompaction calls crash on a shared AbortController
 * (see craft-agents-oss#464). Prompt-side waiting remains bounded at five
 * minutes because a native overflow compaction can legitimately take 60–120 s;
 * host-requested compaction uses a shorter explicit wait before it starts.
 */
export async function waitForCompaction(session: {
    isCompacting: boolean;
}, timeoutMs = 300000): Promise<boolean> {
    if (!session.isCompacting)
        return true;
    debugLog('Waiting for in-flight compaction to finish before prompt...');
    const start = Date.now();
    while (session.isCompacting) {
        if (Date.now() - start > timeoutMs) {
            debugLog(`Compaction wait timed out after ${Math.floor(timeoutMs / 1000)}s, proceeding anyway`);
            return false;
        }
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    if (Date.now() - start < timeoutMs) {
        debugLog('Compaction finished, proceeding with prompt');
    }
    return true;
}

export async function handlePrompt(runtimeState: PiRuntimeState, msg: Extract<InboundMessage, {
    type: 'prompt';
}>): Promise<void> {
    if (runtimeState.initConfig && typeof msg.modelRoutePinned === 'boolean') {
        runtimeState.initConfig.modelRoutePinned = msg.modelRoutePinned;
    }
    runtimeState.currentUserMessage = msg.message;
    if (runtimeState.incompleteToolTailRecovery.beginPrompt()) {
        runtimeState.lastNativeSettlement = { type: 'agent_settled', aborted: false };
        runtimeState.overflowRecoveryAttempted = false;
    }
    runtimeState.toolLoopBudget.beginPrompt();
    try {
        // If proxy tools changed since last session creation, dispose and recreate.
        // This avoids calling _buildRuntime() for dynamic tool updates — instead
        // we create a fresh session via continueRecent() with all tools known upfront.
        if (runtimeState.toolsChanged && runtimeState.piSession) {
            debugLog('Recreating session due to tool changes');
            if (runtimeState.unsubscribeEvents) {
                runtimeState.unsubscribeEvents();
                runtimeState.unsubscribeEvents = null;
            }
            runtimeState.piSession.dispose();
            runtimeState.piSession = null;
        }
        const session = await ensureSession(runtimeState);
        // Keep Robb's instructions current through the public per-turn hook.
        if (msg.systemPrompt) {
            runtimeState.systemPromptController!.setPrompt(msg.systemPrompt);
        }
        // Large workspace aggregators can expose hundreds of unrelated schemas.
        // Keep normal sources untouched, but activate only the relevant product
        // families when intent is clear. The selector fails open on ambiguity and
        // carries prior intent across terse follow-ups for autonomy.
        const activation = runtimeState.sourceToolActivation.select(session.getAllTools().map(tool => tool.name), msg.message, extractRecentUserTexts(session.agent.state.messages));
        // A follow-up may arrive while the preceding turn is still consuming tool
        // results. Never remove tools from that in-flight turn; only expand its set.
        const activeToolNames = session.isStreaming
            ? [...new Set([...session.getActiveToolNames(), ...activation.activeToolNames])]
            : activation.activeToolNames;
        const currentToolNames = session.getActiveToolNames();
        const unchanged = currentToolNames.length === activeToolNames.length
            && activeToolNames.every(name => currentToolNames.includes(name));
        if (!unchanged)
            session.setActiveToolsByName(activeToolNames);
        if (activation.filtered) {
            debugLog(`Source tool activation: ${activation.sourceToolsActive}/${activation.sourceToolsTotal} source tools selected; families=${activation.selectedFamilies.join(',')}; streamingUnion=${session.isStreaming}`);
        }
        // Wire up event handler
        if (runtimeState.unsubscribeEvents) {
            runtimeState.unsubscribeEvents();
        }
        runtimeState.unsubscribeEvents = session.subscribe(event => handleSessionEvent(runtimeState, event, session));
        // Wait for any in-flight auto-compaction to avoid race (craft-agents-oss#464)
        const compactionSettled = await waitForCompaction(session);
        if (!compactionSettled) {
            throw new Error('Previous compaction did not settle before the prompt safety deadline');
        }
        // Fire prompt — use followUp when session is already streaming so the
        // message is queued instead of throwing "Agent is already processing".
        await session.prompt(msg.message, {
            ...(msg.images?.length ? { images: msg.images } : {}),
            streamingBehavior: 'followUp',
            preflightResult: createProviderHandoffPreflight(() => send({ type: 'provider_handoff', id: msg.id })),
        });
        await session.waitForIdle();
        const continueIncompleteTail = async () => {
            const prepared = prepareMessagesForIncompleteTailContinuation(session.agent.state.messages);
            if (prepared.removedAbortedAssistant)
                session.agent.state.messages = prepared.messages;
            await session.agent.continue();
            await session.waitForIdle();
            runtimeState.incompleteToolTailRecovery.observeSettledTail(session.agent.state.messages);
        };
        runtimeState.incompleteToolTailRecovery.observeSettledTail(session.agent.state.messages);
        let recoveryResult = await runtimeState.incompleteToolTailRecovery.recover(continueIncompleteTail);
        const lastMessage = session.agent.state.messages.at(-1);
        if (!runtimeState.overflowRecoveryAttempted && !runtimeState.incompleteToolTailRecovery.isAbortRequested
            && session.autoCompactionEnabled && lastMessage?.role === 'assistant'
            && isContextOverflow(lastMessage)) {
            runtimeState.overflowRecoveryAttempted = true;
            await recoverContextOverflow(session);
            runtimeState.incompleteToolTailRecovery.observeSettledTail(session.agent.state.messages);
            recoveryResult = await runtimeState.incompleteToolTailRecovery.recover(continueIncompleteTail);
        }
        if (recoveryResult === 'exhausted') {
            const message = 'The agent repeatedly stopped with an incomplete turn before producing a final response. Completed tool results were preserved; retry to resume safely.';
            debugLog('Incomplete tool-tail recovery exhausted');
            send({ type: 'error', message, code: 'incomplete_tool_tail' });
        }
    }
    catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        debugLog(`Prompt failed: ${errorMsg}`);
        send({ type: 'error', id: msg.id, message: errorMsg, code: 'prompt_error' });
    }
    finally {
        if (runtimeState.incompleteToolTailRecovery.endPrompt()) {
            send({ type: 'event', event: runtimeState.lastNativeSettlement });
        }
    }
}

export function handleRegisterTools(runtimeState: PiRuntimeState, msg: Extract<InboundMessage, {
    type: 'register_tools';
}>): void {
    // Merge: replace existing tools by name, add new ones
    const incoming = new Map(msg.tools.map(t => [t.name, t]));
    runtimeState.proxyToolDefs = [
        ...runtimeState.proxyToolDefs.filter(t => !incoming.has(t.name)),
        ...msg.tools,
    ];
    debugLog(`Registered ${msg.tools.length} proxy tools (total: ${runtimeState.proxyToolDefs.length}): ${msg.tools.map(t => t.name).join(', ')}`);
    // If session exists, mark for recreation on next prompt.
    // Don't dispose mid-generation — the flag is checked in handlePrompt().
    if (runtimeState.piSession) {
        runtimeState.toolsChanged = true;
        debugLog('Proxy tools changed — session will be recreated on next prompt');
    }
}

export function handleToolExecuteResponse(runtimeState: PiRuntimeState, msg: Extract<InboundMessage, {
    type: 'tool_execute_response';
}>): void {
    const pending = runtimeState.pendingToolExecutions.get(msg.requestId);
    if (pending) {
        pending.resolve(msg.result);
    }
    else {
        debugLog(`No pending tool execution for requestId: ${msg.requestId}`);
    }
}

export function handlePreToolUseResponse(runtimeState: PiRuntimeState, msg: Extract<InboundMessage, {
    type: 'pre_tool_use_response';
}>): void {
    const pending = runtimeState.pendingPreToolUse.get(msg.requestId);
    if (pending) {
        runtimeState.pendingPreToolUse.delete(msg.requestId);
        pending.resolve({ action: msg.action, ...(msg.input !== undefined ? { input: msg.input } : {}), ...(msg.reason !== undefined ? { reason: msg.reason } : {}) });
    }
    else {
        debugLog(`No pending pre_tool_use for requestId: ${msg.requestId}`);
    }
}
