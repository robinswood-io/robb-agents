import type { SessionToolContext } from '../context.ts';
import { errorResponse, successResponse } from '../response.ts';
import { completionCriteriaSchemaError, SET_COMPLETION_CRITERIA_FORMAT_HELP, SetCompletionCriteriaSchema } from '../completion-criteria-schema.ts';

export async function handleSetCompletionCriteria(ctx: SessionToolContext, args: unknown) {
  if (!ctx.setCompletionCriteria) return errorResponse('Objective contracts are unavailable in this context.');
  // Pi's pre-tool checks normally remove these UI fields, but standalone MCP
  // forwards raw arguments. Ignore only the two reserved root metadata fields;
  // the strict criterion contract (including every nested field) stays intact.
  let contractArgs = args;
  let terminalCapability: string | undefined;
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    const { _intent, _displayName, _hostTerminalReconciliationCapability, ...rest } = args as Record<string, unknown>;
    terminalCapability = typeof _hostTerminalReconciliationCapability === 'string'
      ? _hostTerminalReconciliationCapability : undefined;
    contractArgs = rest;
  }
  const parsed = SetCompletionCriteriaSchema.safeParse(contractArgs);
  if (!parsed.success) return errorResponse(`Invalid set_completion_criteria arguments: ${completionCriteriaSchemaError(parsed.error)}. ${SET_COMPLETION_CRITERIA_FORMAT_HELP}`);
  try { return successResponse(JSON.stringify(await ctx.setCompletionCriteria(parsed.data.criteria, parsed.data.procedure, terminalCapability))); }
  catch (error) {
    const reason = (error instanceof Error ? error.message : String(error)).slice(0, 512);
    return errorResponse(`The host rejected these criteria: ${reason}. ${SET_COMPLETION_CRITERIA_FORMAT_HELP}`);
  }
}
