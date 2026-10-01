import { describe, expect, it } from 'bun:test';
import { spawnVibeSubprocess } from './vibe-subprocess.ts';

describe('Vibe ACP subprocess environment boundary', () => {
  it('does not forward arbitrary, SSH, CI or cloud secrets to the actual child', async () => {
    const child = spawnVibeSubprocess(process.execPath, process.cwd(), {
      args: ['-e', 'process.stdout.write(JSON.stringify(process.env))'],
      baseEnv: {
        PATH: process.env.PATH || '/usr/bin',
        HOME: '/safe/home',
        LANG: 'fr_FR.UTF-8',
        LC_ALL: 'fr_FR.UTF-8',
        LC_SENTINEL_SECRET: 'must-not-leak',
        HTTPS_PROXY: 'http://proxy.test:8080',
        ROBB_SENTINEL_SECRET: 'must-not-leak',
        SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
        CI_JOB_TOKEN: 'ci-secret',
        AWS_SECRET_ACCESS_KEY: 'aws-secret',
        AZURE_CLIENT_SECRET: 'azure-secret',
        MISTRAL_API_KEY: 'unrelated-mistral-secret',
      },
    });

    let stdout = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });

    expect(exitCode).toBe(0);
    const childEnv = JSON.parse(stdout) as Record<string, string>;
    expect(childEnv.PATH).toBeDefined();
    expect(childEnv.HOME).toBe('/safe/home');
    expect(childEnv.LANG).toBe('fr_FR.UTF-8');
    expect(childEnv.LC_ALL).toBe('fr_FR.UTF-8');
    expect(childEnv.HTTPS_PROXY).toBe('http://proxy.test:8080');

    expect(childEnv.ROBB_SENTINEL_SECRET).toBeUndefined();
    expect(childEnv.LC_SENTINEL_SECRET).toBeUndefined();
    expect(childEnv.SSH_AUTH_SOCK).toBeUndefined();
    expect(childEnv.CI_JOB_TOKEN).toBeUndefined();
    expect(childEnv.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(childEnv.AZURE_CLIENT_SECRET).toBeUndefined();
    expect(childEnv.MISTRAL_API_KEY).toBeUndefined();
  });
});
