import type { z } from 'zod';
import type { ProjectLearningSchema } from '../tool-defs/schemas.ts';
import type { SessionToolContext } from '../context.ts';
import { errorResponse, successResponse } from '../response.ts';

export type ProjectLearningArgs = z.infer<typeof ProjectLearningSchema>;
export async function handleProjectLearning(ctx: SessionToolContext, args: ProjectLearningArgs) {
  if (!ctx.projectLearning) return errorResponse('Bind this session to a project to use learning.');
  try { return successResponse(JSON.stringify(await ctx.projectLearning(args))); }
  catch (error) { return errorResponse(error instanceof Error ? error.message : String(error)); }
}
