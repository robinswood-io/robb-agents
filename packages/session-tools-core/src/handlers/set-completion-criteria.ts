import type { ObjectiveAcceptanceCriterion } from '@craft-agent/core/types';
import type { SessionToolContext } from '../context.ts';
import { errorResponse, successResponse } from '../response.ts';

export async function handleSetCompletionCriteria(ctx: SessionToolContext, args: { criteria: ObjectiveAcceptanceCriterion[] }) {
  if (!ctx.setCompletionCriteria) return errorResponse('Objective contracts are unavailable in this context.');
  try { return successResponse(JSON.stringify(await ctx.setCompletionCriteria(args.criteria))); }
  catch (error) { return errorResponse(error instanceof Error ? error.message : String(error)); }
}
