import { describe, expect, it } from 'bun:test';
import {
  buildAntigravitySubprocessEnvironment,
  resolveAntigravityCommand,
} from './antigravity-subprocess.ts';

describe('Google Antigravity subprocess isolation', () => {
  it('resolves the official per-user install before PATH', () => {
    expect(resolveAntigravityCommand(
      { HOME: '/Users/tester' },
      'darwin',
      path => path === '/Users/tester/.local/bin/agy',
    )).toBe('/Users/tester/.local/bin/agy');
  });

  it('honors the explicit test/admin command override', () => {
    expect(resolveAntigravityCommand({
      HOME: '/Users/tester',
      ROBB_ANTIGRAVITY_COMMAND: '/opt/google/agy',
    }, 'darwin', () => false)).toBe('/opt/google/agy');
  });

  it('forwards ordinary runtime settings but strips ambient credentials', () => {
    expect(buildAntigravitySubprocessEnvironment({
      HOME: '/Users/tester',
      PATH: '/usr/bin:/bin',
      HTTPS_PROXY: 'https://proxy.example.test',
      GEMINI_API_KEY: 'must-not-be-forwarded',
      GOOGLE_APPLICATION_CREDENTIALS: '/secret/service-account.json',
      OPENAI_API_KEY: 'must-not-be-forwarded',
      ROBB_ANTIGRAVITY_COMMAND: '/opt/google/agy',
    }, 'darwin')).toEqual({
      HOME: '/Users/tester',
      PATH: '/usr/bin:/bin',
      HTTPS_PROXY: 'https://proxy.example.test',
    });
  });
});
