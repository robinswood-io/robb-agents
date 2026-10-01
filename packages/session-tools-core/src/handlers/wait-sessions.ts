import type { SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { errorResponse, successResponse } from '../response.ts';

export interface WaitSessionsArgs {
  sessionIds: string[];
  timeoutMs?: number;
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

  try {
    const result = await ctx.waitForSessions(args.sessionIds, args.timeoutMs ?? 30_000);
    return successResponse(JSON.stringify(result, null, 2));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return errorResponse(`Failed to wait for sessions: ${message}`);
  }
}
