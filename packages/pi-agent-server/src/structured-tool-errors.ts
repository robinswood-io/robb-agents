import type { AgentSession } from '@earendil-works/pi-coding-agent';

type StructuredErrorAgent = Pick<AgentSession['agent'], 'afterToolCall'>;
const installedAgents = new WeakSet<StructuredErrorAgent>();
function hasErrorFlag(details: unknown): boolean {
  return !!details && typeof details === 'object' && 'isError' in details && details.isError === true;
}

/** Pi's normal execute() return path ignores details.isError. Preserve the
 * complete result while promoting that explicit flag before history/events. */
export function installStructuredToolErrors(session: { agent: StructuredErrorAgent }): void {
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
