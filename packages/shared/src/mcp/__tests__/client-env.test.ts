import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, 'fixtures', 'mcp-server-env-probe.mjs');
const CLIENT_MODULE = pathToFileURL(join(HERE, '..', 'client.ts')).href;

const PROBE_KEYS = [
  'PATH',
  'LANG',
  'LC_ALL',
  'HTTPS_PROXY',
  'MCP_EXPLICIT_TOKEN',
  'ROBB_SENTINEL_SECRET',
  'LC_SENTINEL_SECRET',
  'SSH_AUTH_SOCK',
  'CI_JOB_TOKEN',
  'AWS_SECRET_ACCESS_KEY',
  'AZURE_CLIENT_SECRET',
] as const;

describe('CraftMcpClient stdio environment boundary', () => {
  it('does not send host secrets to the actual MCP child process', () => {
    // Launch a fresh parent so every probe value is present in the startup
    // environment (Bun does not enumerate variables assigned after startup).
    const runnerEnv: NodeJS.ProcessEnv = {
      ...process.env,
      LANG: 'fr_FR.UTF-8',
      LC_ALL: 'fr_FR.UTF-8',
      HTTPS_PROXY: 'http://proxy.test:8080',
      ROBB_SENTINEL_SECRET: 'must-not-leak',
      LC_SENTINEL_SECRET: 'must-not-leak',
      SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
      CI_JOB_TOKEN: 'ci-secret',
      AWS_SECRET_ACCESS_KEY: 'aws-secret',
      AZURE_CLIENT_SECRET: 'azure-secret',
    };

    const script = `
      import { CraftMcpClient } from ${JSON.stringify(CLIENT_MODULE)};
      const client = new CraftMcpClient({
        transport: 'stdio',
        command: process.execPath,
        args: [${JSON.stringify(FIXTURE)}],
        env: { MCP_EXPLICIT_TOKEN: 'configured-source-token' },
      });
      try {
        const result = await client.callTool('read_env', { keys: ${JSON.stringify([...PROBE_KEYS])} });
        process.stdout.write(JSON.stringify({
          era: client.getProtocolEra(),
          protocolVersion: client.getNegotiatedProtocolVersion(),
          childEnv: JSON.parse(result.content[0].text),
        }));
      } finally {
        await client.close();
      }
    `;
    const probe = spawnSync(process.execPath, ['-e', script], {
      env: runnerEnv,
      encoding: 'utf8',
      timeout: 15_000,
    });

    expect(probe.status).toBe(0);
    expect(probe.stderr).toBe('');
    const output = JSON.parse(probe.stdout) as {
      era: string;
      protocolVersion: string;
      childEnv: Record<string, string | null>;
    };
    const childEnv = output.childEnv;
    const runnerPath = Object.entries(runnerEnv)
      .find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? null;

    expect(childEnv.PATH).toBe(runnerPath);
    expect(childEnv.LANG).toBe('fr_FR.UTF-8');
    expect(childEnv.LC_ALL).toBe('fr_FR.UTF-8');
    expect(childEnv.HTTPS_PROXY).toBe('http://proxy.test:8080');
    expect(childEnv.MCP_EXPLICIT_TOKEN).toBe('configured-source-token');
    expect(output.era).toBe('legacy');
    expect(output.protocolVersion).toBe('2025-11-25');

    expect(childEnv.ROBB_SENTINEL_SECRET).toBeNull();
    expect(childEnv.LC_SENTINEL_SECRET).toBeNull();
    expect(childEnv.SSH_AUTH_SOCK).toBeNull();
    expect(childEnv.CI_JOB_TOKEN).toBeNull();
    expect(childEnv.AWS_SECRET_ACCESS_KEY).toBeNull();
    expect(childEnv.AZURE_CLIENT_SECRET).toBeNull();
  }, 15_000);
});
