import { describe, expect, it } from 'bun:test';
import { inheritMissionModelSettings } from './mission-model-settings';

describe('public Mission selection inheritance', () => {
  const origin = { llmConnection: 'origin', model: 'pi/gpt-6.1-sol', thinkingLevel: 'high' as const };
  it('inherits concrete legacy selections regardless of retired automatic provenance', () => {
    expect(inheritMissionModelSettings({}, { ...origin, modelRoutePinned: false, thinkingLevelPinned: false })).toEqual({
      ...origin, connectionRoutePinned: true, modelRoutePinned: true, thinkingLevelPinned: true,
    });
  });
  it('keeps explicit profile selections', () => {
    expect(inheritMissionModelSettings({ llmConnection: 'profile', model: 'profile-model', thinkingLevel: 'off' }, origin)).toEqual({
      llmConnection: 'profile', model: 'profile-model', thinkingLevel: 'off',
      connectionRoutePinned: true, modelRoutePinned: true, thinkingLevelPinned: true,
    });
  });
  it('drops an origin model on a provider change while preserving reasoning', () => {
    expect(inheritMissionModelSettings({ llmConnection: 'other' }, origin)).toEqual({
      llmConnection: 'other', model: undefined, thinkingLevel: 'high',
      connectionRoutePinned: true, modelRoutePinned: false, thinkingLevelPinned: true,
    });
  });
  it('scopes a model-only profile to the origin or workspace connection', () => {
    expect(inheritMissionModelSettings({ model: 'chosen' }, origin)).toMatchObject({ llmConnection: 'origin', model: 'chosen' });
    expect(inheritMissionModelSettings({ model: 'chosen' }, undefined, 'workspace')).toMatchObject({ llmConnection: 'workspace', model: 'chosen' });
  });
  it('does not invent a connection, model or reasoning without a selection', () => {
    expect(inheritMissionModelSettings({})).toEqual({ llmConnection: undefined, model: undefined, thinkingLevel: undefined,
      connectionRoutePinned: false, modelRoutePinned: false, thinkingLevelPinned: false });
  });
});
