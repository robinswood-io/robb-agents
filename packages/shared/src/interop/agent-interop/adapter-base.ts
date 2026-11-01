import { createHash } from "node:crypto";
import type { AgentInteropAdapterConfig, AgentInteropAuditEvent, AgentInteropIdentity, AgentInteropPermission, AgentInteropProtocol, AgentTaskService } from './contracts.ts';
import { AgentInteropError } from './contracts.ts';

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

export function requirePermissions(
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

export abstract class AgentInteropAdapter {
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
