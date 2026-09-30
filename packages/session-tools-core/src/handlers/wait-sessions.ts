import type { SessionToolContext, WaitSessionsMode } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { errorResponse, successResponse } from '../response.ts';

export interface WaitSessionsArgs {
  _hostTerminalReconciliationCapability?: string;
  sessionIds: string[];
  timeoutMs?: number;
  afterCursors?: Record<string, string>;
  mode?: WaitSessionsMode;
}

export async function handleWaitSessions(
  ctx: SessionToolContext,
  args: WaitSessionsArgs,
): Promise<ToolResult> {
  if (!ctx.waitForSessions) {
    return errorResponse('wait_sessions is not available in this context.');
  }
  if (args.sessionIds.includes(ctx.sessionId)) {
    return errorResponse('wait_sessions cannot wait on the current session because that would deadlock the active turn.');
  }

  if (Object.keys(args.afterCursors ?? {}).some(id => !args.sessionIds.includes(id))) {
    return errorResponse('afterCursors must only contain requested session IDs.');
  }

  try {
    const mode = args.mode ?? 'first';
    // The capability is host-only, exact-input-bound and one-shot. Keep the
    // model's operational input intact and let the host perform any `all`
    // iteration after consuming that capability exactly once.
    const result = {
      ...await ctx.waitForSessions(
        args.sessionIds,
        args.timeoutMs,
        args.afterCursors,
        args._hostTerminalReconciliationCapability,
        args.mode,
      ),
      mode,
    };
    return successResponse(JSON.stringify(result, null, 2));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return errorResponse(`Failed to wait for sessions: ${message}`);
  }
}
