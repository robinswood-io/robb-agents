import type { ThinkingLevel } from '@craft-agent/shared/agent';

interface MissionModelSettings {
  llmConnection?: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
}

/** Inherit the origin's explicit settings; changing connection clears its model. */
export function inheritMissionModelSettings(
  requested: MissionModelSettings,
  origin?: MissionModelSettings,
): MissionModelSettings {
  const llmConnection = requested.llmConnection ?? origin?.llmConnection;
  return {
    llmConnection,
    model: requested.model ?? (llmConnection === origin?.llmConnection ? origin?.model : undefined),
    thinkingLevel: requested.thinkingLevel ?? origin?.thinkingLevel,
  };
}
