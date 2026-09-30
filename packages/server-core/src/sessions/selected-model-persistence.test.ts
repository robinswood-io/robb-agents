import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  jest,
  spyOn,
} from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { storedToMessage } from '@craft-agent/core/types';

let SessionManager: typeof import('./SessionManager.ts')['SessionManager'];
let createManagedSession: typeof import('./SessionManager.ts')['createManagedSession'];
let transitionObjectiveContract: typeof import('./objective-contract.ts')['transitionObjectiveContract'];
let loadSession: typeof import('@craft-agent/shared/sessions')['loadSession'];

type Managed = ReturnType<typeof createManagedSession>;
type Manager = InstanceType<typeof SessionManager>;

const CONNECTION_SLUG = 'openai-subscription';
const COMPLEX_MODEL = 'pi/gpt-5.6-sol';
const ROUTINE_MODEL = 'pi/gpt-5.6-luna';
const originalCraftConfigDir = process.env.CRAFT_CONFIG_DIR;
const managers: Manager[] = [];
const workspaceRoots: string[] = [];
let configRoot: string;
let restoreStoredConfig: (() => void) | undefined;

function writeGlobalConfig(): void {
  mkdirSync(configRoot, { recursive: true });
  writeFileSync(join(configRoot, 'config.json'), JSON.stringify({
    workspaces: [],
    activeWorkspaceId: null,
    activeSessionId: null,
    defaultLlmConnection: CONNECTION_SLUG,
    llmConnections: [{
      slug: CONNECTION_SLUG,
      name: 'OpenAI subscription fixture',
      providerType: 'pi',
      authType: 'oauth',
      piAuthProvider: 'openai-codex',
      models: [
        'pi/gpt-6-astra',
        COMPLEX_MODEL,
        'pi/gpt-5.6-terra',
        ROUTINE_MODEL,
      ],
      defaultModel: COMPLEX_MODEL,
      modelSelectionMode: 'automaticallySyncedFromProvider',
      createdAt: 1,
    }],
  }, null, 2));
}

function createWorkspace() {
  const rootPath = mkdtempSync(join(tmpdir(), 'objective-model-floor-'));
  workspaceRoots.push(rootPath);
  const workspace = {
    id: `objective-floor-${workspaceRoots.length}`,
    name: 'Objective model floor fixture',
    rootPath,
    createdAt: 1,
  };
  writeFileSync(join(rootPath, 'config.json'), JSON.stringify({
    schemaVersion: 1,
    id: workspace.id,
    name: workspace.name,
    slug: workspace.id,
    createdAt: 1,
    updatedAt: 1,
    
    defaults: {
      defaultLlmConnection: CONNECTION_SLUG,
      thinkingLevel: 'low',
    },
    costControl: {},
  }, null, 2));
  return workspace;
}

function createAgentStub() {
  return {
    supportsBranching: true,
    isProcessing: () => false,
    setExternalActionPolicy: jest.fn(),
    updateRuntimeConfig: jest.fn().mockResolvedValue(true),
    setModel: jest.fn(),
    dispose: jest.fn(),
    disposeForRestart: jest.fn().mockResolvedValue(undefined),
  };
}

function runtimeFor(manager: Manager) {
  return manager as unknown as {
    sessions: Map<string, Managed>;
    persistSession: (managed: Managed) => boolean;
    tryRefreshAgentRuntime: (managed: Managed, reason: string) => Promise<void>;
    getOrCreateAgent: (
      managed: Managed,
      turn: { message: string; messageId: string },
    ) => Promise<unknown>;
  };
}

function registerManager(): { manager: Manager; runtime: ReturnType<typeof runtimeFor> } {
  const manager = new SessionManager();
  managers.push(manager);
  const runtime = runtimeFor(manager);
  // Keep this integration harness on the real routing and persistence paths;
  // only the live provider-runtime refresh is replaced.
  runtime.tryRefreshAgentRuntime = jest.fn().mockResolvedValue(undefined);
  return { manager, runtime };
}

async function routeObjectiveTurn(input: {
  manager: Manager;
  runtime: ReturnType<typeof runtimeFor>;
  managed: Managed;
  messageId: string;
  text: string;
}): Promise<void> {
  input.managed.messages.push({
    id: input.messageId,
    role: 'user',
    content: input.text,
    timestamp: Date.now(),
  });
  input.managed.activeObjective = transitionObjectiveContract({
    existing: input.managed.activeObjective,
    messageId: input.messageId,
    text: input.text,
    nowMs: Date.now(),
  });
  // sendMessage durably accepts the objective transition before provider
  // preparation; reproduce that boundary while exercising real persistence.
  input.runtime.persistSession(input.managed);
  await input.runtime.getOrCreateAgent(input.managed, {
    message: input.text,
    messageId: input.messageId,
  });
  await input.manager.flushSession(input.managed.id);
}

beforeAll(async () => {
  configRoot = mkdtempSync(join(tmpdir(), 'objective-model-floor-config-'));
  process.env.CRAFT_CONFIG_DIR = configRoot;
  writeGlobalConfig();

  const storage = await import('@craft-agent/shared/config/storage');
  const storedConfigSpy = spyOn(storage, 'loadStoredConfig').mockImplementation(() => (
    JSON.parse(readFileSync(join(configRoot, 'config.json'), 'utf8'))
  ));
  restoreStoredConfig = () => storedConfigSpy.mockRestore();

  ({ SessionManager, createManagedSession } = await import('./SessionManager.ts'));
  ({ transitionObjectiveContract } = await import('./objective-contract.ts'));
  ({ loadSession } = await import('@craft-agent/shared/sessions'));
});

afterEach(async () => {
  while (managers.length > 0) await managers.pop()!.cleanup();
  while (workspaceRoots.length > 0) {
    rmSync(workspaceRoots.pop()!, { recursive: true, force: true });
  }
});

afterAll(() => {
  restoreStoredConfig?.();
  rmSync(configRoot, { recursive: true, force: true });
  if (originalCraftConfigDir === undefined) delete process.env.CRAFT_CONFIG_DIR;
  else process.env.CRAFT_CONFIG_DIR = originalCraftConfigDir;
});

describe('public selected-model persistence', () => {
  it('preserves the selected model through complex work, continuation, restart and a new objective', async () => {
    const workspace = createWorkspace();
    const first = registerManager();
    const managed = createManagedSession({
      id: 'monotone-objective',
      name: 'Monotone objective',
      llmConnection: CONNECTION_SLUG,
      connectionRoutePinned: true,
      model: ROUTINE_MODEL,
      modelRoutePinned: false,
      thinkingLevel: 'low',
      thinkingLevelPinned: false,
      createdAt: 1,
    }, workspace as never, { messagesLoaded: true });
    managed.agent = createAgentStub() as never;
    first.runtime.sessions.set(managed.id, managed);

    await routeObjectiveTurn({
      ...first,
      managed,
      messageId: 'complex-root',
      text: 'Conçois une architecture multi-étapes et vérifie les changements dans plusieurs modules.',
    });
    expect(managed).toMatchObject({ model: ROUTINE_MODEL, thinkingLevel: 'low' });
    expect(managed.activeObjective).toMatchObject({
      userMessageId: 'complex-root',
    });
    expect(loadSession(workspace.rootPath, managed.id)?.activeObjective)
      .not.toHaveProperty('automaticModelTier');

    // A short acknowledgement cannot alter the recorded model selection.
    await routeObjectiveTurn({
      ...first,
      managed,
      messageId: 'simple-continuation',
      text: 'Merci.',
    });
    expect(managed.model).toBe(ROUTINE_MODEL);
    expect(managed.activeObjective).toMatchObject({
      userMessageId: 'complex-root',
      lastUserMessageId: 'simple-continuation',
    });

    const persisted = loadSession(workspace.rootPath, managed.id);
    expect(persisted).not.toBeNull();
    expect(persisted?.activeObjective?.automaticModelTier).toBeUndefined();

    const resumed = registerManager();
    const { messages: persistedMessages, ...persistedSession } = persisted!;
    const reloaded = createManagedSession(persistedSession, workspace as never, {
      messages: persistedMessages.map(storedToMessage),
      messagesLoaded: true,
    });
    reloaded.agent = createAgentStub() as never;
    resumed.runtime.sessions.set(reloaded.id, reloaded);

    await routeObjectiveTurn({
      ...resumed,
      managed: reloaded,
      messageId: 'post-reload-continuation',
      text: 'Merci.',
    });
    expect(reloaded.model).toBe(ROUTINE_MODEL);
    expect(reloaded.activeObjective?.automaticModelTier).toBeUndefined();

    const newObjectiveText = 'Nouvel objectif : corrige cette coquille.';
    const resetPreview = transitionObjectiveContract({
      existing: reloaded.activeObjective,
      messageId: 'explicit-new-objective',
      text: newObjectiveText,
      nowMs: Date.now(),
    });
    expect(resetPreview.userMessageId).toBe('explicit-new-objective');
    expect(resetPreview.automaticModelTier).toBeUndefined();

    await routeObjectiveTurn({
      ...resumed,
      managed: reloaded,
      messageId: 'explicit-new-objective',
      text: newObjectiveText,
    });
    expect(reloaded).toMatchObject({ model: ROUTINE_MODEL, thinkingLevel: 'low' });
    expect(reloaded.activeObjective).toMatchObject({
      userMessageId: 'explicit-new-objective',
    });
    expect(loadSession(workspace.rootPath, reloaded.id)?.activeObjective)
      .not.toHaveProperty('automaticModelTier');
  });
});
