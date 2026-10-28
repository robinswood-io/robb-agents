import type { z } from 'zod';
import type { GetSessionInfoSchema } from '../tool-defs/schemas.ts';
import type { SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { successResponse, errorResponse } from '../response.ts';

export type GetSessionInfoArgs = z.infer<typeof GetSessionInfoSchema>;

export async function handleGetSessionInfo(
  ctx: SessionToolContext,
  args: GetSessionInfoArgs
): Promise<ToolResult> {
  if (!ctx.getSessionInfo) {
    return errorResponse('get_session_info is not available in this context.');
  }

  try {
    const info = ctx.getSessionInfo(args.sessionId);
    if (!info) {
      return errorResponse(`Session not found: ${args.sessionId ?? ctx.sessionId}`);
    }
    return successResponse(JSON.stringify(info, null, 2));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return errorResponse(`Failed to get session info: ${message}`);
  }
}
