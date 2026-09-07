import { describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Run each handler fixture in its own process so real config and credential
// modules cannot reuse another test's CONFIG_DIR singleton.
describe('source MCP tool inspection', () => {
  for (const platformOverride of [false, true]) {
    it(`launches a real stdio server with source variables${platformOverride ? ' and platform overrides' : ''}`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'source-tools-inspection-'))
      try {
        const workspace = join(root, 'workspace')
        const sourceDir = join(workspace, 'sources', 'fixture')
        mkdirSync(sourceDir, { recursive: true })
        const mcp = {
          transport: 'stdio',
          command: platformOverride ? '/nonexistent/default-runtime' : process.execPath,
          args: platformOverride ? ['invalid-default-argument'] : ['${SOURCE_DIR}/server.mjs'],
          env: { EXPECTED_SOURCE: '${SOURCE_DIR}', EXPECTED_WORKSPACE: '${WORKSPACE}' },
          ...(platformOverride ? { platform: { [process.platform]: { command: process.execPath, args: ['${SOURCE_DIR}/server.mjs'] } } } : {}),
        }
        const sourceConfig = { id: 'fixture', slug: 'fixture', name: 'Fixture', type: 'mcp', enabled: true, provider: 'custom', connectionStatus: 'connected', mcp }
        writeFileSync(join(sourceDir, 'config.json'), JSON.stringify(sourceConfig))
        writeFileSync(join(root, 'config.json'), JSON.stringify({ workspaces: [{ id: 'fixture-workspace', name: 'Fixture', rootPath: workspace, createdAt: Date.now() }], activeWorkspaceId: 'fixture-workspace', llmConnections: [] }))
        writeFileSync(join(sourceDir, 'server.mjs'), `
          import { createInterface } from 'node:readline';
          import { dirname } from 'node:path';
          import { realpathSync } from 'node:fs';
          import { fileURLToPath } from 'node:url';
          const sourceDir = dirname(fileURLToPath(import.meta.url));
          if (realpathSync(process.env.EXPECTED_SOURCE) !== realpathSync(sourceDir) || realpathSync(process.env.EXPECTED_WORKSPACE) !== realpathSync(${JSON.stringify(workspace)})) process.exit(2);
          createInterface({input:process.stdin}).on('line', line => {
            const request = JSON.parse(line);
            if (request.id === undefined) return;
            const result = request.method === 'initialize'
              ? { protocolVersion: request.params.protocolVersion, capabilities: {tools:{}}, serverInfo:{name:'fixture',version:'1.0.0'} }
              : request.method === 'tools/list'
                ? {tools:[{name:'inspect_fixture',description:'Read fixture',inputSchema:{type:'object',properties:{}}}]}
                : {};
            process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\\n');
          });
        `)
        const handlerPath = join(import.meta.dir, 'sources.ts')
        const probe = join(root, 'probe.ts')
        writeFileSync(probe, `
          import { registerSourcesHandlers } from ${JSON.stringify(handlerPath)};
          const handlers = new Map();
          registerSourcesHandlers({handle:(name,fn)=>handlers.set(name,fn)} as any, {platform:{logger:{info(){},warn(){},error(){}}}} as any);
          const result = await handlers.get('sources:getMcpTools')({}, 'fixture-workspace', 'fixture');
          console.log(JSON.stringify(result));
          process.exit(result.success && result.tools?.[0]?.name === 'inspect_fixture' ? 0 : 1);
        `)
        const child = Bun.spawn([process.execPath, probe], { env: { ...process.env, CRAFT_CONFIG_DIR: root }, stdout: 'pipe', stderr: 'pipe' })
        const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
        expect({ exitCode, stdout: stdout.trim(), stderr: stderr.trim() }).toMatchObject({ exitCode: 0 })
        expect(JSON.parse(readFileSync(join(sourceDir, 'config.json'), 'utf8'))).toEqual(sourceConfig)
      } finally { rmSync(root, { recursive: true, force: true }) }
    }, 20000)
  }
})
