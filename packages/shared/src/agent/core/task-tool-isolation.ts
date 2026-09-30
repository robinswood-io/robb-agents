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
  canonicalExecutionIsolationToolInput,
  validateSessionExecutionIsolation,
  type GuardDecision,
  type SessionExecutionIsolation,
} from '../../tasks/durable-execution.ts';
import type { MissionCapabilityLock } from '../../sessions/types.ts';

export interface TaskToolIsolationInput {
  toolName: string;
  input: Record<string, unknown>;
  workspaceRootPath: string;
  workingDirectory?: string;
  isolation: SessionExecutionIsolation;
  missionCapabilityLock?: MissionCapabilityLock;
}

const FILE_READ_TOOLS = new Set(['Read', 'Glob', 'Grep']);
const FILE_WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const LOCAL_STATE_TOOLS = new Set(['TodoWrite', 'Skill', 'update_plan', 'mcp__session__update_plan', 'session__update_plan']);

function collectHttpUrls(value: unknown, depth = 0, seen = new Set<object>()): string[] {
  if (depth > 8) return [];
  if (typeof value === 'string') return /^https?:\/\//iu.test(value) ? [value] : [];
  if (!value || typeof value !== 'object' || seen.has(value)) return [];
  seen.add(value);
  if (Array.isArray(value)) {
    return value.flatMap(item => collectHttpUrls(item, depth + 1, seen));
  }
  return Object.values(value as Record<string, unknown>)
    .flatMap(item => collectHttpUrls(item, depth + 1, seen));
}

function exactSpecializedConnectorDecision(ctx: TaskToolIsolationInput): GuardDecision | undefined {
  const lock = ctx.missionCapabilityLock;
  if (!lock || !ctx.toolName.startsWith('mcp__') || LOCAL_STATE_TOOLS.has(ctx.toolName)) return undefined;
  const [, sourceSlug, ...toolParts] = ctx.toolName.split('__');
  if (!sourceSlug || toolParts.length === 0) {
    return { allowed: false, reason: 'Malformed MCP tool identity' };
  }
  const sourceDeclared = lock.capabilities.some(capability =>
    capability.kind === 'source' && capability.name === sourceSlug);
  const toolDeclared = lock.capabilities.some(capability =>
    capability.kind === 'tool' && capability.name === ctx.toolName);
  if (!sourceDeclared || !toolDeclared) {
    return {
      allowed: false,
      reason: `MCP tool ${ctx.toolName} is not sealed with its source in the specialized capability lease`,
    };
  }
  // A URL supplied by the model is a distinct network authority. The source
  // server URL itself is already covered by the source identity.
  for (const value of collectHttpUrls(ctx.input)) {
    let host: string;
    try {
      host = new URL(value).hostname.toLowerCase();
    } catch {
      return { allowed: false, reason: 'Connector URL is invalid' };
    }
    const allowedHosts = ctx.isolation.policy.allowedHosts.map(candidate => candidate.toLowerCase());
    if (!allowedHosts.includes(host)) {
      return { allowed: false, reason: `Connector host ${host} is outside the sealed network allow-list` };
    }
  }
  return { allowed: true };
}

function exactPreflightedReadToolDecision(ctx: TaskToolIsolationInput): GuardDecision | undefined {
  if (!ctx.toolName.startsWith('mcp__')) return undefined;
  const allowed = ctx.isolation.policy.allowedReadToolInvocations ?? [];
  if (allowed.length === 0) return undefined;
  const inputJson = canonicalExecutionIsolationToolInput(ctx.input);
  if (!inputJson) {
    return { allowed: false, reason: `Tool ${ctx.toolName} input cannot be canonically matched` };
  }
  return allowed.some(invocation => (
    invocation.toolName === ctx.toolName && invocation.inputJson === inputJson
  ))
    ? { allowed: true }
    : { allowed: false, reason: `Tool ${ctx.toolName} input is outside the exact Mission read allow-list` };
}

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

  const preflightedReadToolDecision = exactPreflightedReadToolDecision(ctx);
  if (preflightedReadToolDecision && !preflightedReadToolDecision.allowed) {
    return preflightedReadToolDecision;
  }

  // Specialized profiles must satisfy both their sealed source/tool lease and
  // the narrower exact-input allow-list produced by Mission preflight.
  const connectorDecision = exactSpecializedConnectorDecision(ctx);
  if (connectorDecision && !connectorDecision.allowed) return connectorDecision;
  if (preflightedReadToolDecision) return preflightedReadToolDecision;
  if (connectorDecision) return connectorDecision;

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
