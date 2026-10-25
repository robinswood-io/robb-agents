import { withSessionOperationsForTest } from './session-operation-access.ts';
import { sessionRuntimeStateForTest } from "./runtime-state-access.ts";
import { mkdtempSync, mkdirSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureSessionDir, getSessionFilePath, writeSessionJsonl, type StoredSession } from "@craft-agent/shared/sessions";
import { createProject, saveProjectConfig } from "@craft-agent/shared/projects";
import { SessionManager, createManagedSession } from "../SessionManager";



export const roots: string[] = []

export const managers: SessionManager[] = []

export const originalFetch = globalThis.fetch

export type Managed = ReturnType<typeof createManagedSession>

export interface IdentityTestRuntime {
  sessions: Map<string, Managed>
  persistSession: (managed: Managed) => boolean
  processEvent: (managed: Managed, event: unknown) => Promise<void>
  runtimeProcessingGenerations: WeakMap<object, number>
  runtimeToolAdmissionBindings: WeakMap<object, unknown>
  objectiveAuthorityEpochs: WeakMap<Managed, number>
  durablyRecordAutomaticRecoveryToolAdmission: (
    managed: Managed,
    runtimeAgent: object,
    request: { toolUseId?: string; toolName: string; toolInput: Record<string, unknown> },
  ) => Promise<void>
  captureUserCorrection: (managed: Managed, message: Managed['messages'][number]) => Promise<void>
  captureSessionTerminalLearning: (
    managed: Managed,
    state: 'complete_verified' | 'blocked_human' | 'blocked_policy' | 'exhausted' | 'cancelled',
  ) => Promise<void>
  handleSessionProjectLearning: (
    managed: Managed,
    request: {
      action: 'propose' | 'validate' | 'revoke' | 'list'
      id?: string
      content?: string
      evidenceIds?: string[]
      reviewToolUseId?: string
      kind?: 'procedure' | 'observation'
    },
  ) => Promise<unknown>
  loadSessionProjectMemoryContext: (managed: Managed, query: string) => Promise<string | null>
  loadSessionPlaybook: (managed: Managed) => { instructions: string } | null
}


export function storedFixture(root: string, id: string, name: string, content: string): StoredSession {
  const stored: StoredSession = {
    id,
    workspaceRootPath: root,
    name,
    createdAt: 1,
    lastUsedAt: 1,
    lastMessageAt: 1,
    messages: [{ id: `${id}-${name}`, type: 'user', content, timestamp: 1 } as never],
    tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
  }
  ensureSessionDir(root, id)
  writeSessionJsonl(getSessionFilePath(root, id), stored)
  return stored
}


export function retargetFixture(label: string) {
  const container = mkdtempSync(join(tmpdir(), `robb-root-identity-${label}-`))
  roots.push(container)
  const rootA = join(container, 'workspace-a')
  const rootB = join(container, 'workspace-b')
  const alias = join(container, 'workspace-alias')
  mkdirSync(rootA, { recursive: true })
  mkdirSync(rootB, { recursive: true })
  symlinkSync(rootA, alias, 'dir')
  return {
    container,
    rootA,
    rootB,
    alias,
    retarget: () => {
      unlinkSync(alias)
      symlinkSync(rootB, alias, 'dir')
    },
  }
}


export function register(
  manager: SessionManager,
  stored: StoredSession,
  alias: string,
  messagesLoaded: boolean,
) {
  const { messages: _messages, ...metadata } = stored
  const managed = createManagedSession(
    metadata,
    { id: `workspace-${stored.id}`, name: 'Aliased workspace', rootPath: alias, createdAt: 1 } as never,
    { messagesLoaded },
  )
  const runtime = manager as unknown as IdentityTestRuntime
  sessionRuntimeStateForTest(manager).sessions.set(managed.id, managed)
  return { managed, runtime }
}


export function registerProjectSession(label: string) {
  const fixture = retargetFixture(label)
  const capturedProject = createProject(fixture.rootA, { name: 'Captured project A' })
  const replacementProject = {
    ...capturedProject,
    slug: `replacement-project-b-${label}`,
    name: 'Replacement project B',
  }
  saveProjectConfig(fixture.rootB, replacementProject)
  const stored = storedFixture(fixture.alias, `project-session-${label}`, 'Project session A', 'project-content-a')
  stored.projectId = capturedProject.id
  const manager = withSessionOperationsForTest(new SessionManager())
  managers.push(manager)
  const registered = register(manager, stored, fixture.alias, true)
  registered.managed.projectId = capturedProject.id
  fixture.retarget()
  return { fixture, capturedProject, replacementProject, manager, ...registered }
}
