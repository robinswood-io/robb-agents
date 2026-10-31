import { AgentInteropAdapter, AgentInteropAuditLog, requirePermissions } from './adapter-base.ts';
import type { A2AAgentCard, AgUiEvent, AgentInteropAdapterConfig, AgentInteropConfiguration, AgentInteropIdentity, AgentInteropPermission, AgentTaskCreateInput, AgentTaskEvent, AgentTaskService, AgentTaskSnapshot, McpTaskRequest } from './contracts.ts';
import { AgentInteropError } from './contracts.ts';

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
      message: typeof event.data["message"] === 'string'
        ? event.data["message"]
        : 'Agent run failed',
      ...(typeof event.data["code"] === 'string' ? { code: event.data["code"] } : {}),
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
  if (event.data["status"] === 'running') {
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
