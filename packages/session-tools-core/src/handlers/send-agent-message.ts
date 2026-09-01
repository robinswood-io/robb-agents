import type { SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { successResponse, errorResponse } from '../response.ts';

export interface SendAgentMessageArgs {
  sessionId: string;
  message: string;
  messageType?: 'progress' | 'result' | 'question' | 'decision';
  attachments?: Array<{ path: string; name?: string }>;
}

export async function handleSendAgentMessage(
  ctx: SessionToolContext,
  args: SendAgentMessageArgs
): Promise<ToolResult> {
  if (!ctx.sendAgentMessage) {
    return errorResponse('send_agent_message is not available in this context.');
  }

  if (!args.sessionId?.trim()) {
    return errorResponse('sessionId is required.');
  }

  if (!args.message?.trim()) {
    return errorResponse('message is required.');
  }

  // Prevent self-send (would create a recursive loop)
  if (args.sessionId === ctx.sessionId) {
    return errorResponse('Cannot send a message to your own session. Use a different sessionId.');
  }

  try {
    // Build sender envelope so the target session knows who sent the message
    const senderName = ctx.getSessionInfo?.()?.name ?? ctx.sessionId;
    const messageType = args.messageType ?? 'progress';
    const wrappedMessage = [
      `[Agent message type="${messageType}" from_session="${ctx.sessionId}" sender="${senderName}"]`,
      messageType === 'question' || messageType === 'decision'
        ? `Reply to session "${ctx.sessionId}" only when the requested answer or decision is ready.`
        : 'No acknowledgement is required. Reply only with a new decision, blocker, requested answer, or terminal handoff.',
      '',
      '---',
      '',
      args.message,
    ].join('\n');

    const result = await ctx.sendAgentMessage(args.sessionId, wrappedMessage, args.attachments);

    // Report the real delivery status instead of an unconditional "sent". A busy
    // target queues the message behind its current turn; an idle target starts
    // now. This is what lets the sender avoid guessing (e.g. never invent "the
    // app restarted") — for actual task status, call list_background_tasks.
    if (result.delivery === 'queued') {
      return successResponse(
        `Message queued for session ${args.sessionId}. It may be coalesced with adjacent agent updates. ` +
          `Do not send an acknowledgement or poll for a reply; query status only when a decision depends on it.`
      );
    }

    return successResponse(
      `Message delivered to session ${args.sessionId}; it will start processing independently now.`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return errorResponse(`Failed to send message: ${message}`);
  }
}
