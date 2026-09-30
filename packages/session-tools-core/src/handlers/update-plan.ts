import { z } from 'zod';
import type { SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { successResponse, errorResponse } from '../response.ts';

export const UpdatePlanSchema = z.object({
  explanation: z.string().trim().min(1).max(2000).optional(),
  plan: z.array(z.object({
    step: z.string().trim().min(1).max(500),
    status: z.enum(['pending', 'in_progress', 'completed']),
  })).max(30).refine(steps => steps.filter(step => step.status === 'in_progress').length <= 1,
    'At most one step may be in progress.'),
});

/** The existing persisted tool event is the plan record; no separate file or approval. */
export async function handleUpdatePlan(_ctx: SessionToolContext, args: unknown): Promise<ToolResult> {
  const parsed = UpdatePlanSchema.safeParse(args);
  if (!parsed.success) return errorResponse(`Invalid plan: ${parsed.error.message}`);
  return successResponse(JSON.stringify(parsed.data));
}
