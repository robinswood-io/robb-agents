/**
 * Host-side tool isolation for Conductor child sessions.
 *
 * This is intentionally a small allow-list. A task session may inspect files,
 * optionally write inside its declared workspace paths, load an application
 * skill, and update its local todo list. Shell, network, browser, nested-agent,
 * and direct MCP tools are denied so they cannot bypass the capability broker.
 */
import {
  authorizeWorkspacePath,
  validateSessionExecutionIsolation,
  type GuardDecision,
  type SessionExecutionIsolation,
} from '../../tasks/durable-execution.ts';

export interface TaskToolIsolationInput {
  toolName: string;
  input: Record<string, unknown>;
  workspaceRootPath: string;
  workingDirectory?: string;
  isolation: SessionExecutionIsolation;
}

const FILE_READ_TOOLS = new Set(['Read', 'Glob', 'Grep']);
const FILE_WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const LOCAL_STATE_TOOLS = new Set(['TodoWrite', 'Skill']);

function requiredString(
  input: Record<string, unknown>,
  key: 'file_path' | 'notebook_path',
): string | undefined {
  const value = input[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function authorizeReadTarget(ctx: TaskToolIsolationInput): GuardDecision {
  const { toolName, input, isolation, workingDirectory } = ctx;
  const candidate = toolName === 'Read'
    ? requiredString(input, 'file_path')
    : typeof input.path === 'string' && input.path.trim().length > 0
      ? input.path
      : workingDirectory ?? isolation.policy.workspaceRoot;

  if (!candidate) {
    return { allowed: false, reason: `${toolName} requires an explicit sandboxed path` };
  }

  const decision = authorizeWorkspacePath(
    isolation.policy.workspaceRoot,
    candidate,
    isolation.policy.allowedReadPaths,
  );
  return decision.allowed
    ? decision
    : { allowed: false, reason: `${toolName} read target rejected: ${decision.reason}` };
}

function authorizeWriteTarget(ctx: TaskToolIsolationInput): GuardDecision {
  const { toolName, input, isolation } = ctx;
  if (isolation.effect !== 'workspace-write') {
    return {
      allowed: false,
      reason: `${toolName} is forbidden for a ${isolation.effect} task node`,
    };
  }

  const candidate = toolName === 'NotebookEdit'
    ? requiredString(input, 'notebook_path')
    : requiredString(input, 'file_path');
  if (!candidate) {
    return { allowed: false, reason: `${toolName} requires an explicit sandboxed path` };
  }

  const decision = authorizeWorkspacePath(
    isolation.policy.workspaceRoot,
    candidate,
    isolation.policy.allowedWritePaths,
  );
  return decision.allowed
    ? decision
    : { allowed: false, reason: `${toolName} write target rejected: ${decision.reason}` };
}

/**
 * Enforce the persisted task envelope before a provider can invoke a tool.
 * Unknown tools are denied: adding a new tool requires an explicit review of
 * its side effects and path/network semantics.
 */
export function enforceTaskToolIsolation(ctx: TaskToolIsolationInput): GuardDecision {
  const isolationDecision = validateSessionExecutionIsolation(
    ctx.isolation,
    ctx.workspaceRootPath,
  );
  if (!isolationDecision.allowed) {
    return {
      allowed: false,
      reason: `Persisted execution isolation is invalid: ${isolationDecision.reason ?? 'blocked'}`,
    };
  }

  if (ctx.isolation.effect === 'external-mutation') {
    return {
      allowed: false,
      reason: 'External mutation must execute through the host capability broker, not a session tool',
    };
  }

  if (FILE_READ_TOOLS.has(ctx.toolName)) {
    return authorizeReadTarget(ctx);
  }
  if (FILE_WRITE_TOOLS.has(ctx.toolName)) {
    return authorizeWriteTarget(ctx);
  }
  if (LOCAL_STATE_TOOLS.has(ctx.toolName)) {
    return { allowed: true };
  }

  return {
    allowed: false,
    reason: `Tool ${ctx.toolName} is outside the task isolation allow-list; use a brokered connector or isolated worker`,
  };
}
