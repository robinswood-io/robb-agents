import type { SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { errorResponse, successResponse } from '../response.ts';
import { RequestUserInputSchema } from '../request-user-input-schema.ts';
import { normalizeUserInputQuestions } from '@craft-agent/core';

/** Returns after the host registers the questions, without waiting for answers. */
export async function handleRequestUserInput(ctx: SessionToolContext, args: unknown): Promise<ToolResult> {
  const requestUserInput = ctx.requestUserInput;
  if (!requestUserInput) {
    return errorResponse('request_user_input is unavailable in this context: no host callback can display the questions. No question was submitted.');
  }
  const parsed = RequestUserInputSchema.safeParse(args);
  if (!parsed.success) {
    return errorResponse(`Invalid request_user_input arguments: ${parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
  }
  try {
    const questions = normalizeUserInputQuestions(parsed.data.questions);
    const result = await requestUserInput(questions);
    if (!result || result.status !== 'pending' || typeof result.requestId !== 'string' || !result.requestId.trim()) {
      return errorResponse('The host did not confirm a pending question request. Do not assume the questions were displayed.');
    }
    return successResponse(JSON.stringify({ requestId: result.requestId, status: result.status }));
  } catch (error) {
    return errorResponse(`Failed to request user input: ${error instanceof Error ? error.message : String(error)}`);
  }
}
