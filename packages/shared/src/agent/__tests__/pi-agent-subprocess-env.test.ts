import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { buildPiProviderEnvironment, buildPiSubprocessEnvironment } from '../pi-agent.ts';

describe('PiAgent subprocess environment boundary', () => {
  it('keeps runtime essentials and explicit grants out of a secret-bearing host env', () => {
    const env = buildPiSubprocessEnvironment(
      {
        proxyEnv: { HTTPS_PROXY: 'http://stored-proxy.test:8080' },
        envOverrides: {
          CRAFT_WORKSPACE_PATH: '/workspace',
          EXPLICIT_PROVIDER_VALUE: 'granted',
        },
        providerEnv: { GOOGLE_CLOUD_PROJECT: 'project-id' },
        awsEnv: {},
        sessionDir: '/workspace/sessions/session-test',
        debugEnabled: false,
      },
      {
        PATH: process.env.PATH || '/usr/bin',
        LANG: 'fr_FR.UTF-8',
        LC_ALL: 'fr_FR.UTF-8',
        LC_SENTINEL_SECRET: 'must-not-leak',
        HTTPS_PROXY: 'http://host-proxy.test:8080',
        ROBB_SENTINEL_SECRET: 'must-not-leak',
        SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
        CI_JOB_TOKEN: 'ci-secret',
        AWS_SECRET_ACCESS_KEY: 'unrelated-aws-secret',
        AZURE_CLIENT_SECRET: 'unrelated-azure-secret',
      },
    );

    const probe = spawnSync(
      process.execPath,
      ['-e', `process.stdout.write(JSON.stringify(process.env))`],
      { env, encoding: 'utf8' },
    );

    expect(probe.status).toBe(0);
    const childEnv = JSON.parse(probe.stdout) as Record<string, string>;
    expect(childEnv.PATH).toBe(env.PATH);
    expect(childEnv.LANG).toBe('fr_FR.UTF-8');
    expect(childEnv.LC_ALL).toBe('fr_FR.UTF-8');
    expect(childEnv.HTTPS_PROXY).toBe('http://stored-proxy.test:8080');
    expect(childEnv.CRAFT_WORKSPACE_PATH).toBe('/workspace');
    expect(childEnv.CRAFT_SESSION_DIR).toBe('/workspace/sessions/session-test');
    expect(childEnv.EXPLICIT_PROVIDER_VALUE).toBe('granted');
    expect(childEnv.GOOGLE_CLOUD_PROJECT).toBe('project-id');
    expect(childEnv.CRAFT_DEBUG).toBe('0');

    expect(childEnv.ROBB_SENTINEL_SECRET).toBeUndefined();
    expect(childEnv.LC_SENTINEL_SECRET).toBeUndefined();
    expect(childEnv.SSH_AUTH_SOCK).toBeUndefined();
    expect(childEnv.CI_JOB_TOKEN).toBeUndefined();
    expect(childEnv.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(childEnv.AZURE_CLIENT_SECRET).toBeUndefined();
  });
});

describe('Pi provider contract environment', () => {
  const hostEnvironment = {
    ROBB_DISABLE_UNSTABLE_PROVIDERS: '1',
    ROBB_DISABLE_CHATGPT_CODEX_BACKEND: 'true',
    ROBB_DISABLE_GITHUB_COPILOT_PROXY: '1',
    ROBB_DISABLE_GOOGLE_CODE_ASSIST_V1INTERNAL: '1',
    ROBB_VIBE_ACP_COMMAND: '/opt/vibe-acp',
    ROBB_ANTIGRAVITY_COMMAND: '/opt/agy',
    GOOGLE_CLOUD_PROJECT: 'project-id',
    ROBB_SENTINEL_SECRET: 'must-not-leak',
  };

  it('passes only master and selected provider controls', () => {
    expect(buildPiProviderEnvironment('openai-codex', hostEnvironment)).toEqual({
      ROBB_DISABLE_UNSTABLE_PROVIDERS: '1',
      ROBB_DISABLE_CHATGPT_CODEX_BACKEND: 'true',
    });
    expect(buildPiProviderEnvironment('github-copilot', hostEnvironment)).toEqual({
      ROBB_DISABLE_UNSTABLE_PROVIDERS: '1',
      ROBB_DISABLE_GITHUB_COPILOT_PROXY: '1',
    });
    expect(buildPiProviderEnvironment('google-gemini-code-assist', hostEnvironment)).toEqual({
      ROBB_DISABLE_UNSTABLE_PROVIDERS: '1',
      ROBB_DISABLE_GOOGLE_CODE_ASSIST_V1INTERNAL: '1',
      GOOGLE_CLOUD_PROJECT: 'project-id',
    });
  });

  it('does not widen unrelated provider environments', () => {
    expect(buildPiProviderEnvironment('openai', hostEnvironment)).toEqual({
      ROBB_DISABLE_UNSTABLE_PROVIDERS: '1',
    });
    expect(buildPiProviderEnvironment('mistral-vibe', hostEnvironment)).toEqual({
      ROBB_DISABLE_UNSTABLE_PROVIDERS: '1',
      ROBB_VIBE_ACP_COMMAND: '/opt/vibe-acp',
    });
    expect(buildPiProviderEnvironment('google-antigravity', hostEnvironment)).toEqual({
      ROBB_DISABLE_UNSTABLE_PROVIDERS: '1',
      ROBB_ANTIGRAVITY_COMMAND: '/opt/agy',
    });
  });

  it('prefers the per-connection Google Cloud project over ambient host values', () => {
    expect(buildPiProviderEnvironment(
      'google-gemini-code-assist',
      { GOOGLE_CLOUD_PROJECT: 'ambient-project', GOOGLE_CLOUD_PROJECT_ID: 'legacy-project' },
      'saved-organization-project',
    )).toEqual({
      GOOGLE_CLOUD_PROJECT: 'saved-organization-project',
    });
  });
});
