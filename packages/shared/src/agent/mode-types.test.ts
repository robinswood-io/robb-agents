import { describe, expect, it } from 'bun:test';
import { permissionModeAfterPlanApproval } from './mode-types.ts';

describe('permissionModeAfterPlanApproval', () => {
  it('moves Explore to Ask without granting blanket execution', () => {
    expect(permissionModeAfterPlanApproval('safe')).toBe('ask');
  });

  it('preserves an explicit existing permission choice', () => {
    expect(permissionModeAfterPlanApproval('ask')).toBe('ask');
    expect(permissionModeAfterPlanApproval('allow-all')).toBe('allow-all');
  });
});
