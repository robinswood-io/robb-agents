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

    expect(env.PATH).toBe('/safe/bin');
    expect(env.MCP_SOURCE_TOKEN).toBe('explicit-source-secret');
    expect(env.CUSTOM_RUNTIME_FLAG).toBe('enabled');
    expect(env.ROBB_SENTINEL_SECRET).toBeUndefined();
  });

  it('preserves Windows Path casing and ignores exported shell functions', () => {
    const env = pickSafeHostEnvironment({
      Path: 'C:\\Windows\\System32',
      LANG: '() { :; }; echo unsafe',
    }, 'win32');

    expect(env.Path).toBe('C:\\Windows\\System32');
    expect(env.PATH).toBeUndefined();
    expect(env.LANG).toBeUndefined();
  });
});
