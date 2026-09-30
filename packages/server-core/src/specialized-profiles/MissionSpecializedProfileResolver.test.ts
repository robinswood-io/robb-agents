import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MissionSpecSchema, type AgentProfile, type MissionSpec } from '@craft-agent/shared/missions';
import {
  SourceCredentialManager,
  saveSourceConfig,
  saveSourceGuide,
} from '@craft-agent/shared/sources';
import {
  resolveConfiguredMissionCapabilities,
  specializedProfileExecutionRouteIdentity,
} from './MissionSpecializedProfileResolver.ts';
import { loadSpecializedSkillPackageSnapshot } from './capability-identity.ts';

function mission(root: string, project: string, profile: AgentProfile): MissionSpec {
  return MissionSpecSchema.parse({
    schemaVersion: 2,
    id: 'resolver-test',
    title: 'Produce a document',
    objective: 'Produce a bounded document',
    cwd: project,
    acceptanceCriteria: [{ id: 'mission-ok', description: 'Complete' }],
    plannerProfileId: 'planner',
    defaultWorkerProfileId: profile.id,
    reviewerProfileId: 'reviewer',
    supervisorProfileId: 'supervisor',
    agentProfiles: [
      { id: 'planner', role: 'planner', specialty: 'plan', systemPrompt: 'Plan.' },
      profile,
      { id: 'reviewer', role: 'reviewer', specialty: 'review', systemPrompt: 'Review.' },
      { id: 'supervisor', role: 'supervisor', specialty: 'review', systemPrompt: 'Review.' },
    ],
    policy: { maxConcurrentAgents: 1, maxTechnicalAttempts: 1 },
    workItems: [
      {
        id: 'objective', kind: 'objective', title: 'Document objective',
        acceptanceCriteria: [{ id: 'objective-ok', description: 'Complete' }],
      },
      {
        id: 'task', kind: 'task', title: 'Write document', prompt: 'Write it.',
        objectiveId: 'objective', dependsOn: [], effect: 'read',
        acceptanceCriteria: [{ id: 'task-ok', description: 'Complete' }],
        requiredEvidence: [],
      },
    ],
  });
}

function worker(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: 'specialist-document-a1b2c3d4e5f6',
    role: 'worker',
    specialty: 'document-production',
    systemPrompt: 'Write.',
    skills: [],
    tools: [],
    sources: [],
    permissionMode: 'safe',
    model: 'model-a',
    llmConnection: 'connection-a',
    thinkingLevel: 'medium',
    ...overrides,
  };
}

function skill(directory: string, script: string): void {
  mkdirSync(join(directory, 'scripts'), { recursive: true });
  writeFileSync(join(directory, 'SKILL.md'), [
    '---',
    'name: Documents',
    'description: Produce documents',
    '---',
    'Run scripts/run.sh.',
  ].join('\n'));
  writeFileSync(join(directory, 'scripts', 'run.sh'), script);
}

describe('specialized Mission host identities', () => {
  let root: string;
  let project: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'specialized-resolver-'));
    project = join(root, 'project');
    mkdirSync(project, { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('hashes the exact uncached project skill package, including scripts', async () => {
    const workspaceSkill = join(root, 'skills', 'documents');
    const projectSkill = join(project, '.agents', 'skills', 'documents');
    skill(workspaceSkill, 'workspace-v1');
    skill(projectSkill, 'project-v1');
    const profile = worker({ skills: ['documents'] });
    const spec = mission(root, project, profile);
    const resolve = () => resolveConfiguredMissionCapabilities({
      workspace: { id: 'workspace-1', rootPath: root },
      spec,
      profile,
      assignedItems: [spec.workItems[1]!],
    });

    const first = (await resolve()).find(({ kind }) => kind === 'skill')!.identitySha256;
    writeFileSync(join(workspaceSkill, 'scripts', 'run.sh'), 'workspace-v2');
    expect((await resolve()).find(({ kind }) => kind === 'skill')!.identitySha256).toBe(first);
    writeFileSync(join(projectSkill, 'scripts', 'run.sh'), 'project-v2');
    expect((await resolve()).find(({ kind }) => kind === 'skill')!.identitySha256).not.toBe(first);
  });

  it('captures the exact evaluated skill bytes for inline runtime consumption', async () => {
    const projectSkill = join(project, '.agents', 'skills', 'documents');
    skill(projectSkill, 'sealed-v1');
    const profile = worker({ skills: ['documents'] });
    const spec = mission(root, project, profile);
    const expected = (await resolveConfiguredMissionCapabilities({
      workspace: { id: 'workspace-1', rootPath: root }, spec, profile,
      assignedItems: [spec.workItems[1]!],
    })).find(({ kind }) => kind === 'skill')!.identitySha256!;
    const snapshot = loadSpecializedSkillPackageSnapshot({
      workspaceRoot: root, workingDirectory: project, slug: 'documents',
    })!;
    expect(snapshot.identitySha256).toBe(expected);
    expect(snapshot.content).toContain('sealed-v1');

    writeFileSync(join(projectSkill, 'scripts', 'run.sh'), 'swapped-v2');
    expect(snapshot.content).not.toContain('swapped-v2');
    expect(loadSpecializedSkillPackageSnapshot({
      workspaceRoot: root, workingDirectory: project, slug: 'documents',
    })!.identitySha256).not.toBe(expected);
  });

  it('rejects a symlinked skill root and hard-linked package content', async () => {
    const external = join(root, 'external-skill');
    skill(external, 'external');
    const skillsRoot = join(project, '.agents', 'skills');
    mkdirSync(skillsRoot, { recursive: true });
    symlinkSync(external, join(skillsRoot, 'documents'));
    const profile = worker({ skills: ['documents'] });
    let spec = mission(root, project, profile);
    const resolve = () => resolveConfiguredMissionCapabilities({
      workspace: { id: 'workspace-1', rootPath: root }, spec, profile,
      assignedItems: [spec.workItems[1]!],
    });
    await expect(resolve()).rejects.toThrow('symbolic-link boundary');

    rmSync(join(skillsRoot, 'documents'));
    skill(join(skillsRoot, 'documents'), 'hard-link');
    linkSync(
      join(skillsRoot, 'documents', 'scripts', 'run.sh'),
      join(skillsRoot, 'documents', 'scripts', 'alias.sh'),
    );
    spec = mission(root, project, profile);
    await expect(resolve()).rejects.toThrow('hard-linked file');
  });

  it('ignores volatile route metadata but invalidates operational route drift', () => {
    const profile = worker();
    const base = {
      slug: 'connection-a', providerType: 'openai', type: 'api',
      baseUrl: 'https://api.example.test', authType: 'api-key',
      models: [{ id: 'b' }, { id: 'a' }], defaultModel: 'model-a',
      createdAt: 1, updatedAt: 2, lastUsedAt: 3, name: 'Old label',
      oauthProfileVerifiedAt: 4,
      credentialBinding: { slot: 'llm_api_key', bindingId: 'generation-a' },
      runtimeIdentitySha256: 'a'.repeat(64),
    };
    const first = specializedProfileExecutionRouteIdentity(profile, base);
    expect(specializedProfileExecutionRouteIdentity(profile, {
      ...base,
      models: [{ id: 'a' }, { id: 'b' }],
      createdAt: 100, updatedAt: 200, lastUsedAt: 300,
      name: 'New label', oauthProfileVerifiedAt: 400,
    })).toBe(first);
    expect(specializedProfileExecutionRouteIdentity(profile, {
      ...base, baseUrl: 'https://other.example.test',
    })).not.toBe(first);
    expect(specializedProfileExecutionRouteIdentity(profile, {
      ...base, credentialBinding: { slot: 'llm_api_key', bindingId: 'generation-b' },
    })).not.toBe(first);
    expect(specializedProfileExecutionRouteIdentity(profile, {
      ...base, runtimeIdentitySha256: 'b'.repeat(64),
    })).not.toBe(first);
  });

  it('binds a source capability to the host credential generation, never its secret', async () => {
    saveSourceConfig(root, {
      id: 'drive', name: 'Drive', slug: 'drive', enabled: true,
      provider: 'google', type: 'api', isAuthenticated: true,
      api: { baseUrl: 'https://www.googleapis.com', authType: 'bearer', googleService: 'drive' },
    });
    saveSourceGuide(root, 'drive', { raw: '# Drive\nRead files.' });
    let bindingId = 'credential-generation-a';
    let secret = 'never-hashed-secret';
    const load = spyOn(SourceCredentialManager.prototype, 'loadWithIdentity')
      .mockImplementation(async (source) => ({
        credential: { value: secret, bindingId },
        credentialId: { type: 'source_bearer', workspaceId: source.workspaceId, sourceId: source.config.slug },
      }));
    try {
      const profile = worker({ sources: ['drive'] });
      const spec = mission(root, project, profile);
      const resolve = () => resolveConfiguredMissionCapabilities({
        workspace: { id: 'workspace-1', rootPath: root }, spec, profile,
        assignedItems: [spec.workItems[1]!],
      });
      const first = (await resolve()).find(({ kind }) => kind === 'source')!.identitySha256;
      secret = 'different-unhashed-secret';
      expect((await resolve()).find(({ kind }) => kind === 'source')!.identitySha256).toBe(first);
      bindingId = 'credential-generation-b';
      expect((await resolve()).find(({ kind }) => kind === 'source')!.identitySha256).not.toBe(first);
      expect(JSON.stringify(await resolve())).not.toContain('never-hashed-secret');
    } finally {
      load.mockRestore();
    }
  });

  it('refuses a local stdio source whose executable is not host-attested', async () => {
    saveSourceConfig(root, {
      id: 'local-tool', name: 'Local Tool', slug: 'local-tool', enabled: true,
      provider: 'custom', type: 'mcp',
      mcp: { transport: 'stdio', command: 'mutable-tool-on-path', args: [] },
    });
    saveSourceGuide(root, 'local-tool', { raw: '# Local tool' });
    const profile = worker({ sources: ['local-tool'] });
    const spec = mission(root, project, profile);
    await expect(resolveConfiguredMissionCapabilities({
      workspace: { id: 'workspace-1', rootPath: root }, spec, profile,
      assignedItems: [spec.workItems[1]!],
    })).rejects.toThrow('unattested local stdio executable');
  });
});
