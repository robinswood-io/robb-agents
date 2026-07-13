import { describe, expect, test } from 'bun:test';
import { CONFIG_DIR } from '../../config/paths.ts';
import { expandVars, resolveStdioConfig } from '../paths.ts';

describe('path variable expansion', () => {
  test('expands centralized config dir without forcing bare values to paths', () => {
    expect(expandVars('${CRAFT_CONFIG_DIR}/sources')).toBe(`${CONFIG_DIR}/sources`);
    expect(expandVars('dart')).toBe('dart');
    expect(expandVars('production')).toBe('production');
  });

  test('resolves stdio config with current-platform overrides and source variables', () => {
    const platform = process.platform as 'darwin' | 'linux' | 'win32';
    const resolved = resolveStdioConfig(
      {
        command: 'node',
        args: ['${SOURCE_DIR}/server.js', '--workspace', '${WORKSPACE}', '--mode', 'production'],
        env: {
          CONFIG_HOME: '${CRAFT_CONFIG_DIR}',
          SOURCE_ROOT: '${SOURCE_DIR}',
        },
        platform: {
          [platform]: {
            command: '${SOURCE_DIR}/bin/server',
            env: { PLATFORM_ONLY: '${WORKSPACE}/platform' },
          },
        },
      },
      '/tmp/robb-workspace',
      '/tmp/robb-workspace/sources/demo',
    );

    expect(resolved).toEqual({
      command: '/tmp/robb-workspace/sources/demo/bin/server',
      args: [
        '/tmp/robb-workspace/sources/demo/server.js',
        '--workspace',
        '/tmp/robb-workspace',
        '--mode',
        'production',
      ],
      env: {
        CONFIG_HOME: CONFIG_DIR,
        SOURCE_ROOT: '/tmp/robb-workspace/sources/demo',
        PLATFORM_ONLY: '/tmp/robb-workspace/platform',
      },
    });
  });
});
