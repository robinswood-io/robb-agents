import { describe, expect, it } from 'bun:test';
import { THINKING_TO_PI } from '../../shared/src/agent/backend/pi/constants.ts';
import { applySelectedThinkingLevel } from './selected-thinking-level.ts';

describe('manual reasoning selection during Pi startup', () => {
  it('keeps a choice made before session creation for the next initialization', () => {
    const config = { thinkingLevel: 'low' };
    applySelectedThinkingLevel(config, null, 'high');
    expect(config.thinkingLevel).toBe('high');
    expect(THINKING_TO_PI[config.thinkingLevel as keyof typeof THINKING_TO_PI]).toBe('high');
  });

  it('updates an active session and preserves the explicit off choice', () => {
    const config = { thinkingLevel: 'high' };
    const applied: string[] = [];
    applySelectedThinkingLevel(config, { setThinkingLevel: level => { applied.push(level); } }, 'off');
    expect(applied).toEqual(['off']);
    expect(config.thinkingLevel).toBe('off');
  });

  it('rejects invalid choices without changing the saved selection', () => {
    const config = { thinkingLevel: 'medium' };
    expect(() => applySelectedThinkingLevel(config, null, 'unknown')).toThrow('Unsupported reasoning level');
    expect(config.thinkingLevel).toBe('medium');
    expect(() => applySelectedThinkingLevel(null, null, 'high')).toThrow('before init');
  });
});
