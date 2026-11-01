import type { ManagedSession } from '../sessions/SessionManager/managed-session.ts';

type MissionModelSettings = Pick<ManagedSession,
  | 'llmConnection' | 'connectionRoutePinned' | 'model' | 'thinkingLevel'
  | 'modelRoutePinned' | 'thinkingLevelPinned'
>;

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
    ...(llmConnection !== undefined ? { llmConnection: llmConnection } : {}),
    connectionRoutePinned: llmConnection !== undefined,
    ...(model !== undefined ? { model: model } : {}),
    ...(thinkingLevel !== undefined ? { thinkingLevel: thinkingLevel } : {}),
    modelRoutePinned: model !== undefined,
    thinkingLevelPinned: thinkingLevel !== undefined,
  };
}
