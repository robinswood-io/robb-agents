import type { AgentSession } from '@earendil-works/pi-coding-agent';

/** Compaction processes task content with the selected model and reasoning level. */
export async function compactSelectedModel(
  session: AgentSession,
  customInstructions?: string,
): Promise<Awaited<ReturnType<AgentSession['compact']>> & { compactionModel: string }> {
  const model = session.model;
  if (!model) throw new Error('A selected model is required before context compaction');
  const result = await session.compact(customInstructions);
  return { ...result, compactionModel: model.id };
}
