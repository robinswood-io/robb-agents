#!/usr/bin/env node
/**
 * Session MCP Server
 *
 * This MCP server provides session-scoped tools to Codex via stdio transport.
 * It uses the shared handlers from @craft-agent/session-tools-core to ensure
 * feature parity with Claude's session-scoped tools.
 *
 * Callback Communication:
 * Tools that need to communicate with the main Electron process (e.g., SubmitPlan
 * triggering a plan display, OAuth triggers pausing execution) send structured
 * JSON messages to stderr with a "__CALLBACK__" prefix. The main process monitors
 * stderr and handles these callbacks.
 *
 * Usage:
 *   node session-mcp-server.js --session-id <id> --workspace-root <path> --plans-folder <path>
 *
 * Arguments:
 *   --session-id: Unique session identifier
 *   --workspace-root: Path to workspace folder (~/.craft-agent/workspaces/{id})
 *   --plans-folder: Path to session's plans folder
 */

import { type SessionConfig, CALLBACK_TOOL_TIMEOUT_MS, isSafeSingleSegment, createCodexContext, createSessionTools } from "./session-context";
import { Server } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { Client, StreamableHTTPClientTransport, type Tool } from '@modelcontextprotocol/client';


import { isDeveloperFeedbackEnabled } from '@craft-agent/shared/feature-flags';
// Import from session-tools-core
// Import from session-tools-core
import {
// Registry
getSessionToolRegistry, errorResponse } from '@craft-agent/session-tools-core';

// ============================================================
// Craft Agents Docs Upstream Proxy
// ============================================================

const DOCS_MCP_URL = 'https://agents.craft.do/docs/mcp';

/** Cached upstream client + tool list */
let docsClient: Client | null = null;
let docsTools: Tool[] = [];

/**
 * Connect to the craft-agents-docs MCP server and fetch its tool definitions.
 * Falls back gracefully if the server is unreachable (tools will just be empty).
 */
async function connectDocsUpstream(): Promise<void> {
  if (process.env.ROBB_ENABLE_CRAFT_DOCS_MCP !== '1' || process.env.CRAFT_DISABLE_DOCS === '1') {
    docsClient = null;
    docsTools = [];
    return;
  }
  try {
    const client = new Client(
      { name: 'craft-agent-session-proxy', version: '1.0.0' },
      {
        capabilities: {},
        // Probe 2026-07-28 first and fall back byte-compatibly to the 2025
        // initialize flow when the upstream server is still legacy.
        versionNegotiation: { mode: 'auto' },
      }
    );

    const transport = new StreamableHTTPClientTransport(new URL(DOCS_MCP_URL));
    await client.connect(transport);

    const result = await client.listTools();
    docsTools = (result.tools || []) as Tool[];
    docsClient = client;

    console.error(`Craft Agents Docs proxy connected: ${docsTools.length} tools`);
  } catch (err) {
    console.error(`Craft Agents Docs proxy connection failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    docsClient = null;
    docsTools = [];
  }
}

/**
 * Route a tool call to the upstream docs client.
 */
async function callDocsUpstream(
  name: string,
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  if (!docsClient) {
    return errorResponse(`Craft Agents Docs server is not connected. Tool '${name}' unavailable.`);
  }

  try {
    const result = await docsClient.callTool({ name, arguments: args });
    // Convert MCP result to our format
    const textContent = (result.content as Array<{ type: string; text?: string }> || [])
      .filter(c => c.type === 'text' && c.text)
      .map(c => ({ type: 'text' as const, text: c.text! }));

    return {
      content: textContent.length > 0 ? textContent : [{ type: 'text', text: '(No response from docs server)' }],
      isError: result.isError as boolean | undefined,
    };
  } catch (err) {
    return errorResponse(`Docs tool '${name}' failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Check if a tool name belongs to the docs upstream */
function isDocsUpstreamTool(name: string): boolean {
  return docsTools.some(t => t.name === name);
}

// ============================================================
// call_llm Handler (backend-specific)
// ============================================================

async function handleCallLlm(
  args: Record<string, unknown>,
  config: SessionConfig,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  // Primary path: PreToolUse intercept injects _precomputedResult (works on Codex).
  const precomputed = args?._precomputedResult as string | undefined;

  if (precomputed) {
    try {
      const parsed = JSON.parse(precomputed);
      if (parsed.error) {
        return errorResponse(`call_llm failed: ${parsed.error}`);
      }
      if (parsed.text !== undefined) {
        return {
          content: [{ type: 'text' as const, text: parsed.text || '(Model returned empty response)' }],
        };
      }
      return errorResponse('call_llm: _precomputedResult has unexpected format (missing text field).');
    } catch {
      return errorResponse(`call_llm: Failed to parse _precomputedResult: ${precomputed.slice(0, 200)}`);
    }
  }

  // Fallback path: HTTP callback to agent (for Copilot where PreToolUse doesn't fire for MCP tools).
  // Uses callbackPort from CLI arg (--callback-port) or env var (CRAFT_LLM_CALLBACK_PORT).
  if (config.callbackPort) {
    try {
      const resp = await fetch(`http://127.0.0.1:${config.callbackPort}/call-llm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(CALLBACK_TOOL_TIMEOUT_MS),
      });
      const result = await resp.json() as { text?: string; model?: string; error?: string };
      if (result.error) {
        return errorResponse(`call_llm failed: ${result.error}`);
      }
      return {
        content: [{ type: 'text' as const, text: result.text || '(Model returned empty response)' }],
      };
    } catch (err) {
      return errorResponse(`call_llm callback failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return errorResponse(
    'call_llm requires either PreToolUse intercept (_precomputedResult) or ' +
    'HTTP callback (CRAFT_LLM_CALLBACK_PORT). Neither is available.'
  );
}

// ============================================================
// spawn_session Handler (backend-specific)
// ============================================================

async function handleSpawnSession(
  args: Record<string, unknown>,
  config: SessionConfig,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  // Primary path: PreToolUse intercept injects _precomputedResult (works on Codex).
  const precomputed = args?._precomputedResult as string | undefined;

  if (precomputed) {
    try {
      const parsed = JSON.parse(precomputed);
      if (parsed.error) {
        return errorResponse(`spawn_session failed: ${parsed.error}`);
      }
      // Return the full result (could be help info or spawn result)
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(parsed, null, 2) }],
      };
    } catch {
      return errorResponse(`spawn_session: Failed to parse _precomputedResult: ${precomputed.slice(0, 200)}`);
    }
  }

  // Fallback path: HTTP callback to agent (for Copilot where PreToolUse doesn't fire for MCP tools).
  if (config.callbackPort) {
    try {
      const resp = await fetch(`http://127.0.0.1:${config.callbackPort}/spawn-session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(CALLBACK_TOOL_TIMEOUT_MS),
      });
      const result = await resp.json() as Record<string, unknown>;
      if (result.error) {
        return errorResponse(`spawn_session failed: ${result.error}`);
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return errorResponse(`spawn_session callback failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return errorResponse(
    'spawn_session requires either PreToolUse intercept (_precomputedResult) or ' +
    'HTTP callback (CRAFT_LLM_CALLBACK_PORT). Neither is available.'
  );
}

// ============================================================
// MCP Server Setup
// ============================================================

function setupSignalHandlers(): void {
  const shutdown = (signal: string) => {
    console.error(`Session MCP Server received ${signal}, shutting down gracefully`);
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled promise rejection in session MCP server:', reason);
  });
}

async function main() {
  setupSignalHandlers();

  // Parse command line arguments
  const args = process.argv.slice(2);
  let sessionId: string | undefined;
  let workspaceRootPath: string | undefined;
  let plansFolderPath: string | undefined;
  let callbackPort: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--session-id' && args[i + 1]) {
      sessionId = args[i + 1];
      i++;
    } else if (args[i] === '--workspace-root' && args[i + 1]) {
      workspaceRootPath = args[i + 1];
      i++;
    } else if (args[i] === '--plans-folder' && args[i + 1]) {
      plansFolderPath = args[i + 1];
      i++;
    } else if (args[i] === '--callback-port' && args[i + 1]) {
      callbackPort = args[i + 1];
      i++;
    }
  }

  if (!sessionId || !workspaceRootPath || !plansFolderPath) {
    console.error('Usage: session-mcp-server --session-id <id> --workspace-root <path> --plans-folder <path>');
    process.exit(1);
  }

  if (!isSafeSingleSegment(sessionId)) {
    console.error('Invalid --session-id: must be a single path segment');
    process.exit(1);
  }

  const rawCallbackPort = callbackPort || process.env.CRAFT_LLM_CALLBACK_PORT;
  let validatedCallbackPort: string | undefined;
  if (rawCallbackPort !== undefined && rawCallbackPort !== '') {
    const portNum = Number(rawCallbackPort);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535 || String(portNum) !== rawCallbackPort.trim()) {
      console.error(`Invalid callback port: "${rawCallbackPort}"`);
      process.exit(1);
    }
    validatedCallbackPort = String(portNum);
  }

  const config: SessionConfig = {
    sessionId,
    workspaceRootPath,
    plansFolderPath,
    // CLI arg takes priority, env var as fallback (Copilot CLI may not forward env to subprocesses)
    callbackPort: validatedCallbackPort,
  };

  // Create the Codex context
  const ctx = createCodexContext(config);

  const includeDeveloperFeedback = isDeveloperFeedbackEnabled();
  const sessionToolRegistry = getSessionToolRegistry({ includeDeveloperFeedback });

  // Connect to upstream docs server (non-blocking, best-effort)
  await connectDocsUpstream();

  const createServer = (): Server => {
    const server = new Server(
      {
        name: 'craft-agent-session',
        version: '0.3.1',
      },
      {
        capabilities: {
          tools: {},
        },
      },
    );

    // Handle tool listing — session tools + docs upstream tools
    server.setRequestHandler('tools/list', async () => ({
      tools: [...createSessionTools(includeDeveloperFeedback), ...docsTools],
    }));

    // Handle tool calls — route via canonical registry, call_llm, or docs upstream
    server.setRequestHandler('tools/call', async (request) => {
      const { name, arguments: toolArgs } = request.params;

      try {
        // call_llm has backend-specific execution (precomputed result / HTTP callback)
        if (name === 'call_llm') {
          return await handleCallLlm(toolArgs as Record<string, unknown>, config);
        }

        // spawn_session has backend-specific execution (precomputed result / HTTP callback)
        if (name === 'spawn_session') {
          return await handleSpawnSession(toolArgs as Record<string, unknown>, config);
        }

        // Check canonical session tool registry first (feature-filtered)
        const def = sessionToolRegistry.get(name);
        if (def?.handler) {
          return await def.handler(ctx, toolArgs);
        }

        // Route to docs upstream if it's a docs tool
        if (isDocsUpstreamTool(name)) {
          return await callDocsUpstream(name, toolArgs as Record<string, unknown>);
        }

        return errorResponse(`Unknown tool: ${name}`);
      } catch (error) {
        return errorResponse(
          `Tool '${name}' failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    });

    return server;
  };

  // `serveStdio` owns era negotiation. A `server/discover` opening selects
  // 2026-07-28; an `initialize` opening keeps the established 2025 behavior.
  serveStdio(() => createServer(), {
    legacy: 'serve',
    onerror: (error) => console.error(`Session MCP protocol error: ${error.message}`),
  });

  console.error(`Session MCP Server started for session ${sessionId} (MCP 2025/2026, developerFeedback=${includeDeveloperFeedback})`);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
