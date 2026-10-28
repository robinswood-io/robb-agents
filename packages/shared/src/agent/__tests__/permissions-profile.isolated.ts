import { afterEach, describe, expect, it } from 'bun:test';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getAppPermissionsDir } from '../permissions-config/app-defaults.ts';

const keys = ['CRAFT_CONFIG_DIR', 'ROBB_BUILD_CHANNEL'] as const;
const original = new Map(keys.map(key => [key, process.env[key]]));

afterEach(() => {
  for (const key of keys) {
    const value = original.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('permissions profile selection without filesystem writes', () => {
  it('preserves the compatible production directory', () => {
    delete process.env['CRAFT_CONFIG_DIR'];
    process.env['ROBB_BUILD_CHANNEL'] = 'production';
    expect(getAppPermissionsDir()).toBe(join(homedir(), '.craft-agent', 'permissions'));
  });

  it('keeps development permissions separate when no override is present', () => {
    delete process.env['CRAFT_CONFIG_DIR'];
    process.env['ROBB_BUILD_CHANNEL'] = 'development';
    expect(getAppPermissionsDir()).toBe(join(homedir(), '.craft-agent-dev', 'permissions'));
  });

  it('honors an explicit profile and reads changes dynamically', () => {
    process.env['ROBB_BUILD_CHANNEL'] = 'development';
    process.env['CRAFT_CONFIG_DIR'] = '/qa/first-profile';
    expect(getAppPermissionsDir()).toBe(join('/qa/first-profile', 'permissions'));
    process.env['CRAFT_CONFIG_DIR'] = '/qa/second-profile';
    expect(getAppPermissionsDir()).toBe(join('/qa/second-profile', 'permissions'));
  });
});
