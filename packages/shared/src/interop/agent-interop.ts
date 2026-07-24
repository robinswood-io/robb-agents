import { createHash } from 'node:crypto';

export type AgentInteropProtocol = 'mcp-tasks' | 'a2a' | 'ag-ui';

export type AgentInteropPermission =
  | 'task:create'
  | 'task:read'
  | 'task:cancel'
  | 'task:resume'
  | 'task:subscribe'
  | 'workspace:read'
  | 'workspace:write'
  | 'external:mutate';

export type AgentTaskStatus =
  | 'queued'
  | 'running'
  | 'waiting-approval'
  | 'completed'
  | 'failed'
  | 'canceled';

export interface AgentInteropIdentity {
  subjectId: string;
  spaceId: string;
  allowedPermissions: AgentInteropPermission[];
}

export interface AgentTaskCreateInput {
  objective: string;
  input?: Record<string, unknown>;
  requestedPermissions: AgentInteropPermission[];
  source: {
    protocol: AgentInteropProtocol;
    protocolVersion: string;
    subjectId: string;
    spaceId: string;
  };
}

export interface AgentTaskSnapshot {
  id: string;
  status: AgentTaskStatus;
  revision: number;
  updatedAt: string;
  output?: Record<string, unknown>;
  error?: string;
}

export interface AgentTaskEvent {
  taskId: string;
  revision: number;
  type: 'status' | 'progress' | 'approval-requested' | 'output' | 'error';
  occurredAt: string;
  data: Record<string, unknown>;
}

export interface AgentTaskService {
  create(input: AgentTaskCreateInput): Promise<AgentTaskSnapshot>;
  get(taskId: string): Promise<AgentTaskSnapshot | null>;
  cancel(taskId: string): Promise<AgentTaskSnapshot>;
  resume(taskId: string): Promise<AgentTaskSnapshot>;
  subscribe(taskId: string, listener: (event: AgentTaskEvent) => void): () => void;
}

export interface AgentInteropAdapterConfig {
  enabled: boolean;
  protocolVersion: string;
  requestTimeoutMs: number;
}

export interface AgentInteropAuditEvent {
  sequence: number;
  occurredAt: string;
  protocol: AgentInteropProtocol;
  protocolVersion: string;
  operation: string;
  subjectId: string;
  spaceId: string;
  taskId?: string;
  outcome: 'accepted' | 'denied' | 'failed';
  reason?: string;
  previousHash: string;
  hash: string;
}

export class AgentInteropError extends Error {
  constructor(
    public readonly code:
      | 'ADAPTER_DISABLED'
      | 'PERMISSION_DENIED'
      | 'TASK_NOT_FOUND'
      | 'REQUEST_TIMEOUT',
    message: string,
  ) {
    super(message);
    this.name = 'AgentInteropError';
  }
}

function auditHash(event: Omit<AgentInteropAuditEvent, 'hash'>): string {
  return createHash('sha256').update(JSON.stringify(event), 'utf8').digest('hex');
}

export class AgentInteropAuditLog {
  private readonly events: AgentInteropAuditEvent[] = [];

  append(input: Omit<AgentInteropAuditEvent, 'sequence' | 'occurredAt' | 'previousHash' | 'hash'>): AgentInteropAuditEvent {
    const previousHash = this.events.at(-1)?.hash ?? 'GENESIS';
    const unsigned: Omit<AgentInteropAuditEvent, 'hash'> = {
      sequence: this.events.length + 1,
      occurredAt: new Date().toISOString(),
      previousHash,
      ...input,
    };
    const event: AgentInteropAuditEvent = { ...unsigned, hash: auditHash(unsigned) };
    this.events.push(event);
    return event;
  }

  list(): AgentInteropAuditEvent[] {
    return this.events.map((event) => ({ ...event }));
  }

  verify(): boolean {
    let previousHash = 'GENESIS';
    return this.events.every((event, index) => {
      const { hash, ...unsigned } = event;
      const valid = event.sequence === index + 1
        && event.previousHash === previousHash
        && hash === auditHash(unsigned);
      previousHash = event.hash;
      return valid;
    });
  }
}

function requirePermissions(
  identity: AgentInteropIdentity,
  required: AgentInteropPermission[],
): void {
  const granted = new Set(identity.allowedPermissions);
  const denied = required.filter((permission) => !granted.has(permission));
  if (denied.length > 0) {
    throw new AgentInteropError(
      'PERMISSION_DENIED',
      `Permission ceiling exceeded: ${denied.join(', ')}`,
    );
  }
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new AgentInteropError('REQUEST_TIMEOUT', `Request exceeded ${timeoutMs} ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

abstract class AgentInteropAdapter {
  protected constructor(
    protected readonly protocol: AgentInteropProtocol,
    protected readonly service: AgentTaskService,
    protected readonly config: AgentInteropAdapterConfig,
    protected readonly audit: AgentInteropAuditLog,
  ) {}

  protected assertEnabled(): void {
    if (!this.config.enabled) {
      throw new AgentInteropError('ADAPTER_DISABLED', `${this.protocol} adapter is disabled`);
    }
  }

  protected async execute<T>(input: {
    operation: string;
    identity: AgentInteropIdentity;
    requiredPermissions: AgentInteropPermission[];
    taskId?: string;
    action: () => Promise<T>;
  }): Promise<T> {
    try {
      this.assertEnabled();
      requirePermissions(input.identity, input.requiredPermissions);
      const result = await withTimeout(input.action(), this.config.requestTimeoutMs);
      this.audit.append({
        protocol: this.protocol,
        protocolVersion: this.config.protocolVersion,
        operation: input.operation,
        subjectId: input.identity.subjectId,
        spaceId: input.identity.spaceId,
        ...(input.taskId ? { taskId: input.taskId } : {}),
        outcome: 'accepted',
      });
      return result;
    } catch (error) {
      this.audit.append({
        protocol: this.protocol,
        protocolVersion: this.config.protocolVersion,
        operation: input.operation,
        subjectId: input.identity.subjectId,
        spaceId: input.identity.spaceId,
        ...(input.taskId ? { taskId: input.taskId } : {}),
        outcome: error instanceof AgentInteropError && error.code === 'PERMISSION_DENIED' ? 'denied' : 'failed',
        reason: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}

export type McpTaskRequest =
  | { method: 'tasks/create'; objective: string; input?: Record<string, unknown>; requestedPermissions?: AgentInteropPermission[] }
  | { method: 'tasks/get'; taskId: string }
  | { method: 'tasks/cancel'; taskId: string }
  | { method: 'tasks/resume'; taskId: string };

export class McpTasksAdapter extends AgentInteropAdapter {
  constructor(service: AgentTaskService, config: AgentInteropAdapterConfig, audit: AgentInteropAuditLog) {
    super('mcp-tasks', service, config, audit);
  }

  handle(request: McpTaskRequest, identity: AgentInteropIdentity): Promise<AgentTaskSnapshot> {
    if (request.method === 'tasks/create') {
      const requestedPermissions = request.requestedPermissions ?? [];
      return this.execute({
        operation: request.method,
        identity,
        requiredPermissions: ['task:create', ...requestedPermissions],
        action: () => this.service.create({
          objective: request.objective,
          ...(request.input ? { input: request.input } : {}),
          requestedPermissions,
          source: {
            protocol: 'mcp-tasks',
            protocolVersion: this.config.protocolVersion,
            subjectId: identity.subjectId,
            spaceId: identity.spaceId,
          },
        }),
      });
    }

    const operation = request.method;
    const permission: AgentInteropPermission = operation === 'tasks/get'
      ? 'task:read'
      : operation === 'tasks/cancel'
        ? 'task:cancel'
        : 'task:resume';
    return this.execute({
      operation,
      identity,
      requiredPermissions: [permission],
      taskId: request.taskId,
      action: async () => {
        const result = operation === 'tasks/get'
          ? await this.service.get(request.taskId)
          : operation === 'tasks/cancel'
            ? await this.service.cancel(request.taskId)
            : await this.service.resume(request.taskId);
        if (!result) throw new AgentInteropError('TASK_NOT_FOUND', `Task ${request.taskId} not found`);
        return result;
      },
    });
  }
}

export interface A2AAgentCard {
  name: string;
  description: string;
  supportedInterfaces: Array<{
    url: string;
    protocolBinding: 'HTTP+JSON';
    protocolVersion: string;
  }>;
  capabilities: {
    streaming: boolean;
    pushNotifications: boolean;
  };
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: Array<{
    id: string;
    name: string;
    description: string;
    tags: string[];
  }>;
  securitySchemes: {
    hostIdentity: {
      type: 'http';
      scheme: 'bearer';
    };
  };
  security: Array<{ hostIdentity: string[] }>;
}

export class A2AAdapter extends AgentInteropAdapter {
  constructor(
    service: AgentTaskService,
    config: AgentInteropAdapterConfig,
    audit: AgentInteropAuditLog,
    private readonly agentName = 'Robb Agents',
    private readonly agentUrl = 'https://localhost.invalid/a2a',
  ) {
    super('a2a', service, config, audit);
  }

  discover(identity: AgentInteropIdentity): A2AAgentCard {
    this.assertEnabled();
    requirePermissions(identity, ['task:read']);
    this.audit.append({
      protocol: 'a2a',
      protocolVersion: this.config.protocolVersion,
      operation: 'agent-card/get',
      subjectId: identity.subjectId,
      spaceId: identity.spaceId,
      outcome: 'accepted',
    });
    return {
      name: this.agentName,
      description: 'Permission-bounded durable task delegation for Robb Agents',
      supportedInterfaces: [{
        url: this.agentUrl,
        protocolBinding: 'HTTP+JSON',
        protocolVersion: this.config.protocolVersion,
      }],
      capabilities: {
        streaming: true,
        pushNotifications: false,
      },
      defaultInputModes: ['text/plain', 'application/json'],
      defaultOutputModes: ['text/plain', 'application/json'],
      skills: [{
        id: 'durable-delegation',
        name: 'Durable task delegation',
        description: 'Delegate, observe and cancel permission-bounded Robb tasks',
        tags: ['tasks', 'delegation', 'human-approval'],
      }],
      securitySchemes: {
        hostIdentity: {
          type: 'http',
          scheme: 'bearer',
        },
      },
      security: [{ hostIdentity: [] }],
    };
  }

  delegate(
    input: Omit<AgentTaskCreateInput, 'source'>,
    identity: AgentInteropIdentity,
  ): Promise<AgentTaskSnapshot> {
    return this.execute({
      operation: 'message/send',
      identity,
      requiredPermissions: ['task:create', ...input.requestedPermissions],
      action: () => this.service.create({
        ...input,
        source: {
          protocol: 'a2a',
          protocolVersion: this.config.protocolVersion,
          subjectId: identity.subjectId,
          spaceId: identity.spaceId,
        },
      }),
    });
  }
}

export type AgUiEvent =
  | {
    type: 'RUN_STARTED';
    threadId: string;
    runId: string;
    timestamp: number;
  }
  | {
    type: 'RUN_FINISHED';
    threadId: string;
    runId: string;
    timestamp: number;
    result: Record<string, unknown>;
  }
  | {
    type: 'RUN_ERROR';
    timestamp: number;
    message: string;
    code?: string;
  }
  | {
    type: 'STATE_SNAPSHOT';
    timestamp: number;
    snapshot: Record<string, unknown>;
  }
  | {
    type: 'CUSTOM';
    timestamp: number;
    name: 'robb.progress' | 'robb.approval.required';
    value: Record<string, unknown>;
  };

function toAgUiEvent(event: AgentTaskEvent): AgUiEvent {
  const timestamp = Date.parse(event.occurredAt);
  if (event.type === 'progress') {
    return {
      type: 'CUSTOM',
      timestamp,
      name: 'robb.progress',
      value: event.data,
    };
  }
  if (event.type === 'approval-requested') {
    return {
      type: 'CUSTOM',
      timestamp,
      name: 'robb.approval.required',
      value: event.data,
    };
  }
  if (event.type === 'error') {
    return {
      type: 'RUN_ERROR',
      timestamp,
      message: typeof event.data.message === 'string'
        ? event.data.message
        : 'Agent run failed',
      code: typeof event.data.code === 'string' ? event.data.code : undefined,
    };
  }
  if (event.type === 'output') {
    return {
      type: 'RUN_FINISHED',
      threadId: event.taskId,
      runId: event.taskId,
      timestamp,
      result: event.data,
    };
  }
  if (event.data.status === 'running') {
    return {
      type: 'RUN_STARTED',
      threadId: event.taskId,
      runId: event.taskId,
      timestamp,
    };
  }
  return {
    type: 'STATE_SNAPSHOT',
    timestamp,
    snapshot: {
      taskId: event.taskId,
      revision: event.revision,
      ...event.data,
    },
  };
}

export class AgUiAdapter extends AgentInteropAdapter {
  constructor(service: AgentTaskService, config: AgentInteropAdapterConfig, audit: AgentInteropAuditLog) {
    super('ag-ui', service, config, audit);
  }

  subscribe(
    taskId: string,
    identity: AgentInteropIdentity,
    listener: (event: AgUiEvent) => void,
  ): () => void {
    try {
      this.assertEnabled();
      requirePermissions(identity, ['task:subscribe', 'task:read']);
      const unsubscribe = this.service.subscribe(taskId, (event) => listener(toAgUiEvent(event)));
      this.audit.append({
        protocol: 'ag-ui',
        protocolVersion: this.config.protocolVersion,
        operation: 'events/subscribe',
        subjectId: identity.subjectId,
        spaceId: identity.spaceId,
        taskId,
        outcome: 'accepted',
      });
      return unsubscribe;
    } catch (error) {
      this.audit.append({
        protocol: 'ag-ui',
        protocolVersion: this.config.protocolVersion,
        operation: 'events/subscribe',
        subjectId: identity.subjectId,
        spaceId: identity.spaceId,
        taskId,
        outcome: error instanceof AgentInteropError && error.code === 'PERMISSION_DENIED' ? 'denied' : 'failed',
        reason: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}

export interface AgentInteropConfiguration {
  mcpTasks: AgentInteropAdapterConfig;
  a2a: AgentInteropAdapterConfig;
  agUi: AgentInteropAdapterConfig;
}

export function createAgentInteropAdapters(
  service: AgentTaskService,
  configuration: AgentInteropConfiguration,
  audit = new AgentInteropAuditLog(),
): {
  mcpTasks: McpTasksAdapter;
  a2a: A2AAdapter;
  agUi: AgUiAdapter;
  audit: AgentInteropAuditLog;
} {
  return {
    mcpTasks: new McpTasksAdapter(service, configuration.mcpTasks, audit),
    a2a: new A2AAdapter(service, configuration.a2a, audit),
    agUi: new AgUiAdapter(service, configuration.agUi, audit),
    audit,
  };
}
