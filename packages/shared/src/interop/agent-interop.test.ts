import { describe, expect, test } from 'bun:test';
import {
  AgentInteropError,
  createAgentInteropAdapters,
  type AgentInteropIdentity,
  type AgentTaskCreateInput,
  type AgentTaskEvent,
  type AgentTaskService,
  type AgentTaskSnapshot,
} from './agent-interop';

class MemoryTaskService implements AgentTaskService {
  private sequence = 0;
  private readonly tasks = new Map<string, AgentTaskSnapshot>();
  private readonly listeners = new Map<string, Set<(event: AgentTaskEvent) => void>>();

  async create(_input: AgentTaskCreateInput): Promise<AgentTaskSnapshot> {
    const id = `task-${++this.sequence}`;
    const task: AgentTaskSnapshot = {
      id,
      status: 'queued',
      revision: 1,
      updatedAt: '2026-07-23T10:00:00.000Z',
    };
    this.tasks.set(id, task);
    return task;
  }

  async get(taskId: string): Promise<AgentTaskSnapshot | null> {
    return this.tasks.get(taskId) ?? null;
  }

  async cancel(taskId: string): Promise<AgentTaskSnapshot> {
    return this.update(taskId, 'canceled');
  }

  async resume(taskId: string): Promise<AgentTaskSnapshot> {
    return this.update(taskId, 'running');
  }

  subscribe(taskId: string, listener: (event: AgentTaskEvent) => void): () => void {
    const listeners = this.listeners.get(taskId) ?? new Set();
    listeners.add(listener);
    this.listeners.set(taskId, listeners);
    return () => listeners.delete(listener);
  }

  emit(event: AgentTaskEvent): void {
    this.listeners.get(event.taskId)?.forEach((listener) => listener(event));
  }

  private update(taskId: string, status: AgentTaskSnapshot['status']): AgentTaskSnapshot {
    const task = this.tasks.get(taskId);
    if (!task) throw new AgentInteropError('TASK_NOT_FOUND', `Task ${taskId} not found`);
    const updated = { ...task, status, revision: task.revision + 1 };
    this.tasks.set(taskId, updated);
    return updated;
  }
}

const identity: AgentInteropIdentity = {
  subjectId: 'user-1',
  spaceId: 'team-1',
  allowedPermissions: [
    'task:create',
    'task:read',
    'task:cancel',
    'task:resume',
    'task:subscribe',
    'workspace:read',
  ],
};

function configuration(enabled = true, timeoutMs = 100) {
  return {
    mcpTasks: { enabled, protocolVersion: '2025-11-25', requestTimeoutMs: timeoutMs },
    a2a: { enabled, protocolVersion: '1.0', requestTimeoutMs: timeoutMs },
    agUi: { enabled, protocolVersion: '0.1', requestTimeoutMs: timeoutMs },
  };
}

describe('agent interoperability adapters', () => {
  test('keeps every protocol disabled until explicitly enabled', async () => {
    const adapters = createAgentInteropAdapters(new MemoryTaskService(), configuration(false));
    await expect(adapters.mcpTasks.handle({ method: 'tasks/get', taskId: 'missing' }, identity))
      .rejects.toMatchObject({ code: 'ADAPTER_DISABLED' });
    expect(() => adapters.a2a.discover(identity)).toThrow(AgentInteropError);
    expect(() => adapters.agUi.subscribe('missing', identity, () => undefined)).toThrow(AgentInteropError);
    expect(adapters.audit.list().every((event) => event.outcome === 'failed')).toBe(true);
  });

  test('supports two independent protocol clients against one internal task model', async () => {
    const service = new MemoryTaskService();
    const adapters = createAgentInteropAdapters(service, configuration());
    const mcpTask = await adapters.mcpTasks.handle({
      method: 'tasks/create',
      objective: 'Préparer le rapport',
      requestedPermissions: ['workspace:read'],
    }, identity);
    const card = adapters.a2a.discover(identity);
    const a2aTask = await adapters.a2a.delegate({
      objective: 'Vérifier le rapport',
      requestedPermissions: ['workspace:read'],
    }, identity);
    expect([mcpTask.id, a2aTask.id]).toEqual(['task-1', 'task-2']);
    expect(card.supportedInterfaces[0]).toMatchObject({
      protocolBinding: 'HTTP+JSON',
      protocolVersion: '1.0',
    });
    expect(card.capabilities.streaming).toBe(true);
    expect(adapters.audit.list().map((event) => event.protocolVersion))
      .toEqual(['2025-11-25', '1.0', '1.0']);
    expect(adapters.audit.verify()).toBe(true);
  });

  test('enforces the host permission ceiling before delegation', async () => {
    const adapters = createAgentInteropAdapters(new MemoryTaskService(), configuration());
    await expect(adapters.mcpTasks.handle({
      method: 'tasks/create',
      objective: 'Publier les changements',
      requestedPermissions: ['external:mutate'],
    }, identity)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(adapters.audit.list().at(-1)?.outcome).toBe('denied');
  });

  test('maps cancellation, resume, and approval events across protocols', async () => {
    const service = new MemoryTaskService();
    const adapters = createAgentInteropAdapters(service, configuration());
    const task = await adapters.mcpTasks.handle({
      method: 'tasks/create',
      objective: 'Déployer',
    }, identity);
    expect((await adapters.mcpTasks.handle({ method: 'tasks/cancel', taskId: task.id }, identity)).status)
      .toBe('canceled');
    expect((await adapters.mcpTasks.handle({ method: 'tasks/resume', taskId: task.id }, identity)).status)
      .toBe('running');

    const events: string[] = [];
    const unsubscribe = adapters.agUi.subscribe(task.id, identity, (event) => events.push(event.type));
    service.emit({
      taskId: task.id,
      revision: 4,
      type: 'approval-requested',
      occurredAt: '2026-07-23T10:01:00.000Z',
      data: { reason: 'External mutation' },
    });
    unsubscribe();
    expect(events).toEqual(['CUSTOM']);
  });

  test('bounds headless protocol calls with a timeout', async () => {
    const service = new MemoryTaskService();
    service.get = async () => new Promise<AgentTaskSnapshot | null>(() => undefined);
    const adapters = createAgentInteropAdapters(service, configuration(true, 5));
    await expect(adapters.mcpTasks.handle({ method: 'tasks/get', taskId: 'slow' }, identity))
      .rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' });
  });
});
