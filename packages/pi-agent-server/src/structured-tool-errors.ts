import type { AgentSession } from '@earendil-works/pi-coding-agent';

const installedAgents = new WeakSet<AgentSession['agent']>();
function hasErrorFlag(details: unknown): boolean {
  return !!details && typeof details === 'object' && (details as { isError?: unknown }).isError === true;
}

/** Pi's normal execute() return path ignores details.isError. Preserve the
 * complete result while promoting that explicit flag before history/events. */
export function installStructuredToolErrors(session: Pick<AgentSession, 'agent'>): void {
  const agent = session.agent;
  if (installedAgents.has(agent)) return;
  installedAgents.add(agent);
  const previous = agent.afterToolCall;
  agent.afterToolCall = async (context, signal) => {
    const failed = context.isError || hasErrorFlag(context.result.details);
    const override = await previous?.(context, signal);
    if (failed || context.isError || hasErrorFlag(context.result.details)
      || override?.isError === true || hasErrorFlag(override?.details)) {
      // Override only the error flag: SDK merge semantics retain content,
      // details (including non-execution/blocker/checkpoint data) and terminate.
      return { ...override, isError: true };
    }
    return override;
  };
}
