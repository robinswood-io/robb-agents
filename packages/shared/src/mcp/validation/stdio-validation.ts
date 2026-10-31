import { protectApplicationCommand } from "@craft-agent/session-tools-core";
/**
 * MCP Connection Validation
 *
 * Validates HTTP/SSE MCP servers by connecting directly via CraftMcpClient
 * and listing tools. Avoids spawning a Claude Code subprocess (which is killed
 * by Electron's macOS sandbox — see issue #697).
 */
import { buildStdioMcpSubprocessEnvironment } from "../client.js";
import { debug } from "../../utils/debug.ts";
import type { StdioValidationConfig } from './connection-validation.ts';
import type { InvalidProperty, McpValidationResult } from './tool-validation.ts';
import { findInvalidProperties } from './tool-validation.ts';

/**
 * Connect-phase watchdog with two cooperating timers:
 *
 *  - **Idle timer** — fires after `idleMs` of *silence* on stderr. Reset every
 *    time `kick()` is called (typically from the stderr data handler). Catches
 *    "spawn loop has gone quiet, server is hung."
 *  - **Ceiling timer** — fires unconditionally after `ceilingMs` of wall-clock
 *    since creation. Hard cap so a server that floods stderr but never
 *    completes `initialize` can't hold the connect phase alive forever.
 *
 * `outcome()` returns which one fired (or null if connect resolved first).
 */
interface ConnectWatchdog {
  promise: Promise<never>;
  kick: () => void;
  stop: () => void;
  outcome: () => 'idle' | 'ceiling' | null;
}

function createConnectWatchdog(
  idleMs: number,
  ceilingMs: number,
): ConnectWatchdog {
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let ceilingTimer: ReturnType<typeof setTimeout> | null = null;
  let outcome: 'idle' | 'ceiling' | null = null;
  let stopped = false;
  let rejectFn: ((err: Error) => void) | null = null;

  const promise = new Promise<never>((_, reject) => {
    rejectFn = reject;
  });
  // Swallow unhandled rejection if the race winner is `client.connect()`.
  promise.catch(() => {});

  const fire = (kind: 'idle' | 'ceiling') => {
    if (outcome || stopped) return;
    outcome = kind;
    if (idleTimer) clearTimeout(idleTimer);
    if (ceilingTimer) clearTimeout(ceilingTimer);
    idleTimer = null;
    ceilingTimer = null;
    rejectFn?.(
      new Error(
        kind === 'idle'
          ? `Timeout: MCP initialize did not complete within ${idleMs}ms of stderr silence`
          : `Timeout: MCP initialize did not complete within the ${ceilingMs}ms ceiling`,
      ),
    );
  };

  const arm = () => {
    if (outcome || stopped) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => fire('idle'), idleMs);
  };

  ceilingTimer = setTimeout(() => fire('ceiling'), ceilingMs);
  arm();

  return {
    promise,
    kick: arm,
    stop: () => {
      stopped = true;
      if (idleTimer) clearTimeout(idleTimer);
      if (ceilingTimer) clearTimeout(ceilingTimer);
      idleTimer = null;
      ceilingTimer = null;
    },
    outcome: () => outcome,
  };
}

/**
 * Validates a stdio MCP connection by spawning the process and listing tools.
 *
 * Unlike HTTP validation, this actually spawns the MCP server process,
 * connects via stdio transport, and validates the available tools.
 *
 * Process lifecycle is owned exclusively by `StdioClientTransport` — we do
 * NOT spawn a second copy of the server. Earlier versions did, which caused
 * "Server startup timeout" symptoms because the unused first child held pipes
 * with no consumer (see #787).
 */
export async function validateStdioMcpConnection(
  config: StdioValidationConfig
): Promise<McpValidationResult> {
  const { command, args = [], env = {}, cwd, timeout = 30000 } = config;

  // Two-watchdog connect phase. Most "MCP doesn't work" failures never
  // complete the `initialize` handshake, so we want fast diagnostics — but
  // legitimate cold-cache installs (`uv tool run`, `npx`, `pipx`) can take
  // 20+ seconds while emitting reassuring stderr noise. The idle timer
  // resets on every stderr event so cold installs aren't penalized; the
  // ceiling caps the worst-case to prevent a noisy-but-broken server from
  // holding the validation alive forever.
  const connectIdleMs = Math.min(8000, Math.max(1000, Math.floor(timeout / 2)));
  const listToolsFloor = 2000;
  const connectCeilingMs = Math.max(connectIdleMs, timeout - listToolsFloor);
  let listToolsTimeoutResolved = listToolsFloor;

  debug(`[stdio-validation] Spawning: ${command} ${args.join(' ')}`);

  const { Client } = await import('@modelcontextprotocol/client');
  const { StdioClientTransport } = await import('@modelcontextprotocol/client/stdio');

  let client: InstanceType<typeof Client> | null = null;
  let transport: InstanceType<typeof StdioClientTransport> | null = null;
  let stderrOutput = '';
  // Track which phase failed for richer diagnostics.
  let phase: 'connect' | 'list-tools' | 'unknown' = 'unknown';

  const cleanup = async () => {
    if (client) {
      try {
        await client.close();
      } catch {
        // Ignore close errors — best-effort.
      }
      client = null;
    }
    if (transport) {
      try {
        await transport.close();
      } catch {
        // Ignore close errors — SDK kills the subprocess internally.
      }
      transport = null;
    }
  };

  const withTimeout = <T>(p: Promise<T>, ms: number, label: string): Promise<T> => {
    return new Promise<T>((resolve, reject) => {
      const id = setTimeout(() => {
        reject(new Error(`Timeout: ${label} did not complete within ${ms}ms`));
      }, ms);
      p.then(
        (v) => {
          clearTimeout(id);
          resolve(v);
        },
        (e: unknown) => {
          clearTimeout(id);
          reject(e);
        },
      );
    });
  };

  try {
    transport = new StdioClientTransport({
      ...protectApplicationCommand(command, args),
      env: buildStdioMcpSubprocessEnvironment(env),
      ...(cwd !== undefined ? { cwd } : {}),
      stderr: 'pipe',
    });

    const watchdog = createConnectWatchdog(connectIdleMs, connectCeilingMs);

    // The SDK exposes a PassThrough _before_ `start()` is called, so this
    // listener catches early startup output too. Every stderr event resets
    // the idle watchdog — keeps cold-cache installs (`uv`/`uvx`/`npx`) from
    // timing out while they emit reassuring progress noise.
    transport.stderr?.on('data', (data: Buffer | string) => {
      stderrOutput += typeof data === 'string' ? data : data.toString();
      if (stderrOutput.length > 10000) {
        stderrOutput = stderrOutput.slice(-10000);
      }
      watchdog.kick();
    });

    client = new Client(
      { name: 'craft-agent-validator', version: '1.0.0' },
      {
        capabilities: {},
        versionNegotiation: {
          mode: 'auto',
          // The v2 SDK probes stdio on a disposable sibling. Keep that probe
          // bounded so the real child starts soon enough for this validator's
          // stderr-aware idle watchdog to observe cold-start activity. A
          // silent/unknown probe falls back to the unchanged 2025 handshake.
          probe: {
            timeoutMs: Math.max(500, Math.min(2000, Math.floor(connectIdleMs / 3))),
          },
        },
      }
    );

    phase = 'connect';
    const connectStart = Date.now();
    try {
      await Promise.race([client.connect(transport), watchdog.promise]);
    } finally {
      watchdog.stop();
    }
    const elapsedConnect = Date.now() - connectStart;
    listToolsTimeoutResolved = Math.max(listToolsFloor, timeout - elapsedConnect);

    phase = 'list-tools';
    const toolsResult = await withTimeout(
      client.listTools(),
      listToolsTimeoutResolved,
      'tools/list',
    );
    const tools = toolsResult.tools || [];
    const toolNames = tools.map((t: { name: string }) => t.name);

    debug(`[stdio-validation] Found ${tools.length} tools`);

    // Validate tool schemas for property naming
    const allInvalidProperties: InvalidProperty[] = [];
    for (const tool of tools) {
      if (tool.inputSchema && typeof tool.inputSchema === 'object') {
        const invalidProps = findInvalidProperties(
          tool.inputSchema as Record<string, unknown>
        );
        for (const prop of invalidProps) {
          allInvalidProperties.push({
            toolName: tool.name,
            propertyPath: prop.path,
            propertyKey: prop.key,
          });
        }
      }
    }

    if (allInvalidProperties.length > 0) {
      const toolsWithIssues = [
        ...new Set(allInvalidProperties.map((p) => p.toolName)),
      ];
      return {
        success: false,
        error: `Server has ${allInvalidProperties.length} invalid property name(s) in ${toolsWithIssues.length} tool(s): ${toolsWithIssues.join(', ')}. Property names must match ^[a-zA-Z0-9_.-]{1,64}$`,
        errorType: 'invalid-schema' as const,
        invalidProperties: allInvalidProperties,
        tools: toolNames,
      };
    }

    return {
      success: true,
      tools: toolNames,
      serverInfo: {
        name: command,
        version: args.join(' '),
      },
    };
  } catch (err) {
    const error = err as Error;
    debug(`[stdio-validation] Error in phase=${phase}: ${error.message}`);

    const stderrSnippet = stderrOutput.trim().slice(-500);
    const errorType: McpValidationResult['errorType'] = 'failed';
    let errorMessage: string;

    // Hint for any failure during the `initialize` handshake — by far the most
    // common cause for users porting code from other RPC conventions is wrong
    // framing on stdout. The MCP stdio spec mandates newline-delimited
    // JSON-RPC. LSP-style `Content-Length: …\r\n\r\n{json}` is the typical
    // misstep and reproducibly produces both timeouts and "Connection closed"
    // errors here depending on exactly how the buffer fragments.
    const framingHint =
      'Check that the server speaks newline-delimited JSON-RPC (MCP stdio spec) on stdout, not LSP-style Content-Length framing.';

    if (error.message.includes('ENOENT') || error.message.includes('not found')
      || /sandbox-exec: execvp\(\) of .*: No such file or directory/.test(stderrSnippet)) {
      errorMessage = `Command not found: "${command}". Install the required dependency and try again.`;
    } else if (error.message.includes('EACCES') || error.message.includes('permission denied')) {
      errorMessage = `Permission denied running "${command}". Check file permissions.`;
    } else if (error.message.includes('Timeout')) {
      // Phase split: connect timeouts are diagnostic, list-tools timeouts are not.
      if (phase === 'connect') {
        // Connect-phase timeouts come from the two-watchdog setup:
        //   - "stderr silence"  → server went quiet without completing init
        //                         (likely wrong framing / hung handshake)
        //   - "ceiling"         → server kept emitting stderr the whole time
        //                         but never completed init (stuck in a setup
        //                         loop, wrong entrypoint, etc.)
        if (error.message.includes('stderr silence')) {
          errorMessage = stderrSnippet
            ? `MCP initialize not acknowledged within ${connectIdleMs}ms of stderr silence. ${framingHint}\nstderr (tail):\n${stderrSnippet}`
            : `MCP initialize not acknowledged within ${connectIdleMs}ms of stderr silence and the server produced no stderr output. ${framingHint}`;
        } else if (error.message.includes('ceiling')) {
          errorMessage = stderrSnippet
            ? `MCP server kept emitting startup output for ${connectCeilingMs}ms but never completed the \`initialize\` handshake. Check that the command actually launches an MCP server (not just a package installer or build step).\nstderr (tail):\n${stderrSnippet}`
            : `MCP server hit the ${connectCeilingMs}ms connect ceiling without completing the \`initialize\` handshake. Check that the command actually launches an MCP server (not just a package installer or build step).`;
        } else {
          // Defensive fallback if some other Timeout-message shape sneaks in.
          errorMessage = stderrSnippet
            ? `MCP initialize did not complete within ${connectCeilingMs}ms.\nstderr (tail):\n${stderrSnippet}`
            : `MCP initialize did not complete within ${connectCeilingMs}ms.`;
        }
      } else if (phase === 'list-tools') {
        errorMessage = stderrSnippet
          ? `tools/list did not respond within ${listToolsTimeoutResolved}ms.\nstderr (tail):\n${stderrSnippet}`
          : `tools/list did not respond within ${listToolsTimeoutResolved}ms.`;
      } else {
        errorMessage = stderrSnippet
          ? `Server did not respond within ${timeout}ms.\nstderr (tail):\n${stderrSnippet}`
          : `Server did not respond within ${timeout}ms.`;
      }
    } else if (phase === 'connect') {
      // Anything else during connect (Connection closed, parse error, etc.)
      // → still a protocol problem. Lead with the framing hint.
      errorMessage = stderrSnippet
        ? `MCP initialize failed: ${error.message}. ${framingHint}\nstderr (tail):\n${stderrSnippet}`
        : `MCP initialize failed: ${error.message}. ${framingHint}`;
    } else if (stderrSnippet) {
      errorMessage = `${error.message}\nstderr (tail):\n${stderrSnippet}`;
    } else {
      errorMessage = error.message;
    }

    return {
      success: false,
      error: errorMessage,
      errorType,
    };
  } finally {
    await cleanup();
  }
}
