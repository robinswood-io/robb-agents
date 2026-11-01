/**
 * Renderer — converts SessionManager events into chat messages.
 *
 * Three modes selected per binding via `BindingConfig.responseMode`:
 *
 *   - `streaming` (legacy): on Telegram, posts on first `text_delta` and
 *     edits every ~editIntervalMs as tokens arrive; each `text_complete`
 *     finalises the current message, so one agent run with multiple turns
 *     produces multiple messages. On platforms without editing, accumulates
 *     per turn and sends on each `text_complete`.
 *
 *   - `progress` (default): one evolving message per run. Posts
 *     "💭 thinking…" on first activity, edits to "🔧 <tool>…" on each
 *     `tool_start`, back to "💭 thinking…" on `tool_result`, and replaces
 *     the whole bubble with the final text on `complete`. Intermediate
 *     assistant text (`text_complete` with `isIntermediate`) is dropped.
 *     On adapters without `messageEditing`, degrades to a single
 *     send-on-complete (identical to `final_only`).
 *
 *   - `final_only`: silent until `complete`, then sends one message with
 *     the accumulated final text. Nothing is sent for empty completions.
 *
 * Permissions and errors are orthogonal: when the session requests a
 * permission or an error fires, the renderer flushes current mode state
 * and emits the prompt/error as a distinct message regardless of mode.
 */
import type { PlatformAdapter, ChannelBinding, SentMessage } from "./types";
import type { PlanTokenRegistry } from "./plan-tokens";
import type { SessionEvent, RenderState, PlanMessageRecorder, PermissionMessageRecorder } from './renderer/shared.ts';
import * as rendererStreaming from './renderer/streaming.ts';
import * as rendererProgress from './renderer/progress.ts';
import * as rendererResponses from './renderer/responses.ts';
export type { SessionEvent, PlanMessageRecorder, PermissionMessageRecorder } from './renderer/shared.ts';

export class Renderer {
    /** Per-binding render state. Keyed by binding.id */
    /** @internal */ public states = new Map<string, RenderState>();
    /** @internal */ public readonly planTokens: PlanTokenRegistry | undefined;
    /** @internal */ public readonly recordPlanMessage: PlanMessageRecorder | undefined;
    /** @internal */ public readonly recordPermissionMessage: PermissionMessageRecorder | undefined;
    constructor(deps?: {
        planTokens?: PlanTokenRegistry;
        recordPlanMessage?: PlanMessageRecorder;
        recordPermissionMessage?: PermissionMessageRecorder;
    }) {
        this.planTokens = deps?.planTokens;
        this.recordPlanMessage = deps?.recordPlanMessage;
        this.recordPermissionMessage = deps?.recordPermissionMessage;
    }
    /** @internal */ public getState(bindingId: string): RenderState {
        return rendererStreaming.getState(this, bindingId);
    }
    /** Handle an outbound session event for a specific binding. */
    async handle(event: SessionEvent, binding: ChannelBinding, adapter: PlatformAdapter): Promise<void> {
        return rendererStreaming.handle(this, event, binding, adapter);
    }
    /** @internal */ public async handleStreaming(event: SessionEvent, binding: ChannelBinding, adapter: PlatformAdapter): Promise<void> {
        return rendererStreaming.handleStreaming(this, event, binding, adapter);
    }
    /** @internal */ public async handleStreamingDelta(state: RenderState, binding: ChannelBinding, adapter: PlatformAdapter): Promise<void> {
        return rendererStreaming.handleStreamingDelta(this, state, binding, adapter);
    }
    /** @internal */ public scheduleEdit(state: RenderState, binding: ChannelBinding, adapter: PlatformAdapter): void {
        return rendererStreaming.scheduleEdit(this, state, binding, adapter);
    }
    /** @internal */ public async handleProgress(event: SessionEvent, binding: ChannelBinding, adapter: PlatformAdapter): Promise<void> {
        return rendererProgress.handleProgress(this, event, binding, adapter);
    }
    /** @internal */ public async ensureProgressBubble(state: RenderState, binding: ChannelBinding, adapter: PlatformAdapter, status: string): Promise<void> {
        return rendererProgress.ensureProgressBubble(this, state, binding, adapter, status);
    }
    /** @internal */ public async handleFinalOnly(event: SessionEvent, binding: ChannelBinding, adapter: PlatformAdapter): Promise<void> {
        return rendererResponses.handleFinalOnly(this, event, binding, adapter);
    }
    /** @internal */ public async handlePermissionRequest(event: SessionEvent, binding: ChannelBinding, adapter: PlatformAdapter, state: RenderState): Promise<void> {
        return rendererResponses.handlePermissionRequest(this, event, binding, adapter, state);
    }
    /** @internal */ public async handleCredentialRequest(binding: ChannelBinding, adapter: PlatformAdapter): Promise<void> {
        return rendererResponses.handleCredentialRequest(this, binding, adapter);
    }
    /** @internal */ public async handlePlanSubmitted(event: SessionEvent, binding: ChannelBinding, adapter: PlatformAdapter): Promise<void> {
        return rendererResponses.handlePlanSubmitted(this, event, binding, adapter);
    }
    /** @internal */ public async handleError(event: SessionEvent, binding: ChannelBinding, adapter: PlatformAdapter, state: RenderState): Promise<void> {
        return rendererResponses.handleError(this, event, binding, adapter, state);
    }
    /** @internal */ public async tryEditMessage(adapter: PlatformAdapter, binding: ChannelBinding, messageId: string, text: string, state: RenderState): Promise<void> {
        return rendererStreaming.tryEditMessage(this, adapter, binding, messageId, text, state);
    }
    /** @internal */ public cancelEditTimer(state: RenderState): void {
        return rendererStreaming.cancelEditTimer(this, state);
    }
    /** @internal */ public resetRun(state: RenderState): void {
        return rendererResponses.resetRun(this, state);
    }
    /** @internal */ public async sendText(adapter: PlatformAdapter, binding: ChannelBinding, text: string): Promise<SentMessage | undefined> {
        return rendererResponses.sendText(this, adapter, binding, text);
    }
    /** Clean up state for a removed binding. */
    removeBinding(bindingId: string): void {
        return rendererResponses.removeBinding(this, bindingId);
    }
}
