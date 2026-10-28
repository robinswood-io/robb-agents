import type { z } from 'zod';
import type { ListSessionsSchema } from '../tool-defs/schemas.ts';
import type { SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { successResponse, errorResponse } from '../response.ts';

export type ListSessionsArgs = z.infer<typeof ListSessionsSchema>;

export async function handleListSessions(
  ctx: SessionToolContext,
  args: ListSessionsArgs
): Promise<ToolResult> {
  if (!ctx.listSessions) {
    return errorResponse('list_sessions is not available in this context.');
  }

  try {
    const result = ctx.listSessions({
      ...(args.status !== undefined ? { status: args.status } : {}),
      ...(args.label !== undefined ? { label: args.label } : {}),
      ...(args.search !== undefined ? { search: args.search } : {}),
      ...(args.sortBy !== undefined ? { sortBy: args.sortBy } : {}),
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
      ...(args.offset !== undefined ? { offset: args.offset } : {}),
    });
    return successResponse(JSON.stringify(result, null, 2));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return errorResponse(`Failed to list sessions: ${message}`);
  }
}
