/**
 * Spawn Session Tool (spawn_session)
 *
 * Session-scoped tool that enables the main agent to create independent sessions
 * with inherited provider scope, adaptive model selection, sources, and an initial prompt.
 *
 * Two modes:
 * - help=true: Optionally returns available sources and role guidance
 * - Default: Creates a session and sends the prompt (fire-and-forget)
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { SpawnSessionSchema, parseSpawnSessionInput, SpawnSessionInputError } from '@craft-agent/session-tools-core';
import type { SpawnSessionResult, SpawnSessionHelpResult } from './base-agent.ts';

export type SpawnSessionFn = (input: Record<string, unknown>) => Promise<SpawnSessionResult | SpawnSessionHelpResult>;

// Tool result type - matches what the SDK expects
type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

function errorResponse(message: string): ToolResult {
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
  };
}

export interface SpawnSessionToolOptions {
  sessionId: string;
  /**
   * Lazy resolver for the spawn session callback.
   * Called at execution time to get the current callback from the session registry.
   */
  getSpawnSessionFn: () => SpawnSessionFn | undefined;
}

export function createSpawnSessionTool(options: SpawnSessionToolOptions) {
  return tool(
    'spawn_session',
    `Create a new session that runs independently with its own prompt and sources.

Use this to delegate tasks to parallel sessions — research, analysis, drafts, or any work that benefits from separate context.

The input schema is sufficient for normal delegation. Use help=true only when you need to inspect optional sources or role guidance.
When spawning, the 'prompt' parameter is required.

For an independent review, set role:"reviewer" explicitly. Reviewers are read-only, cannot delegate, and receive the exact parent review contract. Omitted role defaults to worker; labels are not a substitute for selecting the role.

Optional overrides: role, permissionMode, enabledSourceSlugs, labels, workingDirectory. The provider always remains the parent's provider. A manually selected parent model remains authoritative; otherwise the host selects the child model and reasoning from the assignment difficulty.

The spawned session appears in the session list and runs fire-and-forget.
Only use 'attachments' for existing file paths on disk — the tool reads them automatically.`,
    SpawnSessionSchema.shape,
    async (args) => {
      const spawnFn = options.getSpawnSessionFn();
      if (!spawnFn) {
        return errorResponse('spawn_session is not available in this context.');
      }

      try {
        const result = await spawnFn(parseSpawnSessionInput(args));
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        if (error instanceof SpawnSessionInputError) {
          return { content: [{ type: 'text' as const, text: JSON.stringify(error) }], isError: true };
        }
        if (error instanceof Error) {
          return errorResponse(`spawn_session failed: ${error.message}`);
        }
        throw error;
      }
    }
  );
}
