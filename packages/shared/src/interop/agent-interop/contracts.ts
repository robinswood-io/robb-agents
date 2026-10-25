
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

export type McpTaskRequest =
  | { method: 'tasks/create'; objective: string; input?: Record<string, unknown>; requestedPermissions?: AgentInteropPermission[] }
  | { method: 'tasks/get'; taskId: string }
  | { method: 'tasks/cancel'; taskId: string }
  | { method: 'tasks/resume'; taskId: string };

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

export interface AgentInteropConfiguration {
  mcpTasks: AgentInteropAdapterConfig;
  a2a: AgentInteropAdapterConfig;
  agUi: AgentInteropAdapterConfig;
}
