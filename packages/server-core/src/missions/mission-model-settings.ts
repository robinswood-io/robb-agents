import type { ThinkingLevel } from '@craft-agent/shared/agent';

interface MissionModelSettings {
  llmConnection?: string;
  connectionRoutePinned?: boolean;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  modelRoutePinned?: boolean;
  thinkingLevelPinned?: boolean;
}

/** Profile overrides win; otherwise preserve the origin's materialized selection. */
export function inheritMissionModelSettings(
  requested: MissionModelSettings,
  origin?: MissionModelSettings,
  defaultConnection?: string,
): MissionModelSettings {
  const llmConnection = requested.llmConnection ?? origin?.llmConnection ?? defaultConnection;
  const model = requested.model ?? (llmConnection === origin?.llmConnection ? origin?.model : undefined);
  const thinkingLevel = requested.thinkingLevel ?? origin?.thinkingLevel;
  return {
    llmConnection,
    connectionRoutePinned: llmConnection !== undefined,
    model,
    thinkingLevel,
    modelRoutePinned: model !== undefined,
    thinkingLevelPinned: thinkingLevel !== undefined,
  };
}
