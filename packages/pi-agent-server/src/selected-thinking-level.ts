import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { THINKING_TO_PI } from '../../shared/src/agent/backend/pi/constants.ts';

/** Store a manual choice even before the provider session has been created. */
export function applySelectedThinkingLevel(
  config: { thinkingLevel: string } | null,
  session: Pick<AgentSession, 'setThinkingLevel'> | null,
  level: string,
): void {
  if (!config) throw new Error('Reasoning selection received before init');
  if (!Object.hasOwn(THINKING_TO_PI, level)) throw new Error(`Unsupported reasoning level: ${level}`);
  const piLevel = THINKING_TO_PI[level as keyof typeof THINKING_TO_PI];
  config.thinkingLevel = level;
  session?.setThinkingLevel(piLevel);
}
