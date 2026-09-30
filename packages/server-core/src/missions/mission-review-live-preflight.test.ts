import { describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('Mission review live tool preflight', () => {
  it('refuses absent, destructive, invalid-input and unauthenticated tools without mutation or provider dispatch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mission-live-preflight-'))
    try {
      const workspace = join(root, 'workspace')
      const sourceDir = join(workspace, 'sources', 'fixture')
      const authSourceDir = join(workspace, 'sources', 'auth-fixture')
      const brokenSourceDir = join(workspace, 'sources', 'broken-fixture')
      mkdirSync(sourceDir, { recursive: true })
      mkdirSync(authSourceDir, { recursive: true })
      mkdirSync(brokenSourceDir, { recursive: true })
      writeFileSync(join(root, 'config.json'), JSON.stringify({
        workspaces: [{
          id: 'mission-preflight-workspace', name: 'Mission preflight',
          rootPath: workspace, createdAt: 1,
        }],
        activeWorkspaceId: 'mission-preflight-workspace',
        llmConnections: [],
      }))
      writeFileSync(join(workspace, 'config.json'), JSON.stringify({
        schemaVersion: 1,
        id: 'mission-preflight-workspace',
        name: 'Mission preflight',
        slug: 'mission-preflight-workspace',
        defaults: { enabledSourceSlugs: ['fixture'] },
        localMcpServers: { enabled: true },
        createdAt: 1,
        updatedAt: 1,
      }))
      writeFileSync(join(workspace, 'permissions.json'), JSON.stringify({
        allowedMcpPatterns: [
          '^mcp__fixture__inspect_fixture$',
          '^mcp__fixture__delete_fixture$',
        ],
      }))
      writeFileSync(join(sourceDir, 'config.json'), JSON.stringify({
        id: 'fixture', slug: 'fixture', name: 'Fixture', type: 'mcp', enabled: true,
        provider: 'custom', connectionStatus: 'connected',
        mcp: {
          transport: 'stdio', command: process.execPath,
          args: ['${SOURCE_DIR}/server.mjs', '${SOURCE_DIR}/starts.log'], authType: 'none',
        },
      }))
      writeFileSync(join(authSourceDir, 'config.json'), JSON.stringify({
        id: 'auth-fixture', slug: 'auth-fixture', name: 'Auth fixture', type: 'mcp', enabled: true,
        provider: 'custom', isAuthenticated: true, connectionStatus: 'connected',
        mcp: { transport: 'http', url: 'http://127.0.0.1:1/mcp', authType: 'bearer' },
      }))
      writeFileSync(join(brokenSourceDir, 'config.json'), JSON.stringify({
        id: 'broken-fixture', slug: 'broken-fixture', name: 'Broken fixture', type: 'mcp', enabled: true,
        provider: 'custom', connectionStatus: 'connected',
        mcp: { transport: 'stdio', command: '/tmp/mission-secret-command-DO_NOT_ECHO', authType: 'none' },
      }))
      writeFileSync(join(sourceDir, 'server.mjs'), `
        import { createInterface } from 'node:readline';
        import { appendFileSync } from 'node:fs';
        appendFileSync(process.argv[2], 'start\\n');
        createInterface({ input: process.stdin }).on('line', line => {
          const request = JSON.parse(line);
          if (request.id === undefined) return;
          const result = request.method === 'initialize'
            ? { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1.0.0' } }
            : request.method === 'tools/list'
              ? { tools: [
                  { name: 'inspect_fixture', inputSchema: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] }, annotations: { readOnlyHint: true } },
                  { name: 'delete_fixture', inputSchema: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] }, annotations: { readOnlyHint: true, destructiveHint: true } },
                ] }
              : {};
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
        });
      `)

      const probePath = join(root, 'probe.ts')
      const managerPath = join(import.meta.dir, '..', 'sessions', 'SessionManager.ts')
      const executorPath = join(import.meta.dir, 'SessionMissionExecutor.ts')
      writeFileSync(probePath, `
        import { readFileSync } from 'node:fs';
        import { SessionManager } from ${JSON.stringify(managerPath)};
        import { SessionMissionExecutor } from ${JSON.stringify(executorPath)};

        const manager = new SessionManager();
        const commonPreflight = {
          toolInput: { target: 'exact' }, permissionMode: 'safe', enabledSourceSlugs: ['fixture'],
        };
        const batch = await manager.preflightMissionToolInvocations('mission-preflight-workspace', [
          { ...commonPreflight, toolName: 'mcp__fixture__missing_fixture' },
          { ...commonPreflight, toolName: 'mcp__fixture__delete_fixture' },
        ]);
        const batchStarts = readFileSync(${JSON.stringify(join(sourceDir, 'starts.log'))}, 'utf8').trim().split('\\n').length;
        const authConfigPath = ${JSON.stringify(join(authSourceDir, 'config.json'))};
        const authBefore = readFileSync(authConfigPath, 'utf8');
        const authRequired = await manager.preflightMissionToolInvocation('mission-preflight-workspace', {
          toolName: 'mcp__auth-fixture__inspect_fixture', toolInput: { target: 'exact' },
          permissionMode: 'safe', enabledSourceSlugs: ['auth-fixture'],
        });
        const authAfter = readFileSync(authConfigPath, 'utf8');
        const sensitiveCatalogFailure = await manager.preflightMissionToolInvocation('mission-preflight-workspace', {
          toolName: 'mcp__broken-fixture__inspect_fixture', toolInput: { target: 'exact' },
          permissionMode: 'safe', enabledSourceSlugs: ['broken-fixture'],
        });
        let createCalls = 0;
        let sendCalls = 0;
        const run = async (toolName, dispatchId, criterionInput = { target: 'exact' }) => {
          const origin = {
            id: 'origin-session', workspaceId: 'mission-preflight-workspace', workspaceName: 'Mission preflight',
            lastMessageAt: 1, messages: [], isProcessing: false,
            activeObjective: {
              schemaVersion: 1, originalText: 'Inspect the exact fixture target.', userMessageId: 'origin-message',
              startedAt: 1, budgetBaselineUsd: 0, tokenBaseline: 0, continuationCount: 0,
              orchestrationMode: 'mission', risk: 'high-stakes', completionCriteria: ['requested-outcome-delivered'],
              terminalState: 'active', acceptanceCriteria: [{
                id: 'live-tool', description: 'Observe fixture.', toolName,
                input: criterionInput, checks: [{ path: '$.ok', equals: true }],
              }],
            },
          };
          const mission = {
            id: 'live-preflight-mission', title: 'Live preflight', objective: 'Review exact evidence',
            originSessionId: 'origin-session', agentProfiles: [], workItems: [], policy: {},
          };
          const assignment = {
            mission,
            item: { id: 'review-item', kind: 'final-review', title: 'Review', reviewTargetId: mission.id,
              acceptanceCriteria: [], requiredEvidence: [], dependsOn: [], effect: 'read' },
            profile: { id: 'reviewer', role: 'reviewer', specialty: 'quality', systemPrompt: 'Review.',
              skills: [], tools: [], sources: [], permissionMode: 'safe' },
            dispatchId,
            upstream: [],
          };
          const host = {
            getSessions: () => [origin],
            getSession: async () => null,
            createSession: async () => { createCalls += 1; throw new Error('unexpected create'); },
            bindSpecializedMissionCapabilityLock: async () => {},
            sendMessage: async () => { sendCalls += 1; throw new Error('unexpected send'); },
            onSessionComplete: () => () => {},
            getSessionFinalText: () => undefined,
            resolveMissionEnabledSourceSlugs: manager.resolveMissionEnabledSourceSlugs.bind(manager),
            preflightMissionToolInvocation: manager.preflightMissionToolInvocation.bind(manager),
          };
          const executor = new SessionMissionExecutor({
            host, workspaceId: 'mission-preflight-workspace', workspaceRoot: ${JSON.stringify(workspace)},
          });
          return executor.execute(assignment, await executor.prepare(assignment));
        };

        const absent = await run('mcp__fixture__missing_fixture', 'dispatch-absent');
        const destructive = await run('mcp__fixture__delete_fixture', 'dispatch-destructive');
        const invalidInput = await run('mcp__fixture__inspect_fixture', 'dispatch-invalid-input', { target: 42 });
        const starts = readFileSync(${JSON.stringify(join(sourceDir, 'starts.log'))}, 'utf8').trim().split('\\n').length;
        console.log(JSON.stringify({
          batch, batchStarts, absent, destructive, invalidInput, authRequired,
          sensitiveCatalogFailure,
          authStateUnchanged: authBefore === authAfter, authAfter: JSON.parse(authAfter),
          createCalls, sendCalls, starts,
        }));
      `)

      const child = Bun.spawn([process.execPath, probePath], {
        env: { ...process.env, CRAFT_CONFIG_DIR: root, CRAFT_LOCAL_MCP_ENABLED: 'true' },
        stdout: 'pipe', stderr: 'pipe',
      })
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect({ exitCode, stderr: stderr.trim() }).toMatchObject({ exitCode: 0 })
      const result = JSON.parse(stdout.trim()) as {
        absent: { status: string; reason: string }
        destructive: { status: string; reason: string }
        invalidInput: { status: string; reason: string }
        authRequired: { allowed: boolean; reason?: string }
        sensitiveCatalogFailure: { allowed: boolean; reason?: string }
        authStateUnchanged: boolean
        authAfter: { isAuthenticated?: boolean; connectionStatus?: string; connectionError?: string }
        batch: Array<{ allowed: boolean; reason?: string }>
        batchStarts: number
        createCalls: number
        sendCalls: number
        starts: number
      }
      expect(result.batch[0]).toMatchObject({ allowed: false })
      expect(result.batch[0]?.reason).toContain('absent from the live source catalog')
      expect(result.batch[1]).toMatchObject({ allowed: false })
      expect(result.batch[1]?.reason).toContain('declared destructive')
      expect(result.absent).toMatchObject({ status: 'failed' })
      expect(result.absent.reason).toContain('absent from the live source catalog')
      expect(result.destructive).toMatchObject({ status: 'failed' })
      expect(result.destructive.reason).toContain('declared destructive')
      expect(result.invalidInput).toMatchObject({ status: 'failed' })
      expect(result.invalidInput.reason).toContain('does not satisfy its exact live MCP schema')
      expect(result.authRequired).toMatchObject({ allowed: false })
      expect(result.authRequired.reason).toContain('MISSION_SOURCE_CATALOG_UNAVAILABLE')
      expect(result.authStateUnchanged).toBe(true)
      expect(result.authAfter).toMatchObject({ isAuthenticated: true, connectionStatus: 'connected' })
      expect(result.authAfter.connectionError).toBeUndefined()
      expect(result.sensitiveCatalogFailure).toMatchObject({ allowed: false })
      expect(result.sensitiveCatalogFailure.reason).toContain('MISSION_SOURCE_CATALOG_')
      expect(result.sensitiveCatalogFailure.reason).not.toContain('DO_NOT_ECHO')
      expect(result.sensitiveCatalogFailure.reason).not.toContain('/tmp/mission-secret-command')
      expect(result.createCalls).toBe(0)
      expect(result.sendCalls).toBe(0)
      expect(result.batchStarts).toBeGreaterThan(0)
      expect(result.starts).toBe(result.batchStarts * 4)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)
})
