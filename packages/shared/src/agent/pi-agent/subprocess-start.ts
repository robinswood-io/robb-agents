import { protectApplicationCommand } from "@craft-agent/session-tools-core";
/**
 * Pi Backend (Subprocess RPC Client)
 *
 * Thin subprocess client for the Pi coding agent. Spawns a pi-agent-server
 * subprocess and communicates via JSONL over stdin/stdout.
 *
 * The subprocess runs the Pi SDK (@earendil-works/pi-coding-agent) in-process,
 * handles tool wrapping, permission enforcement, and LLM queries.
 * This file manages subprocess lifecycle, JSONL protocol, event forwarding,
 * and proxy tool routing for MCP/API sources.
 *
 * Auth is API key based. Keys are retrieved from the credential manager
 * and passed to the subprocess during initialization.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { getProxyEnvVars } from "../../config/proxy-env.ts";
import { registerLongRunningProcess } from "../../processes/index.ts";
import { getBackendRuntime } from "../backend/internal/driver-types.ts";
// Credential manager for token storage
import { getCredentialManager } from "../../credentials/manager.ts";
// Session tool proxy definitions (for registering with subprocess)
import { getSessionToolProxyDefs } from "../backend/pi/session-tool-defs.ts";
// Session tool registry (for executing proxy tool calls)
import { SESSION_BACKEND_TOOL_NAMES } from "@craft-agent/session-tools-core";
// Path utilities
import { join } from "path";
// Session storage (plans folder path)
import { getSessionPath, getSessionPlansPath } from "../../sessions/storage.ts";
import { assertExistingWorkingDirectory } from "../spawn-helpers.ts";
import { getBrowserToolEnabled } from "../../config/storage.ts";
import type { PiAgent } from '../pi-agent.ts';
import { RUNTIME_DIAGNOSTIC_MAX_CHARS, PiRuntimeInterruptedError, resolvePiSubprocessStartupTimeoutMs, buildPiSubprocessEnvironment, shouldRefreshPiOAuthBeforeSpawn, redactRuntimeDiagnosticText, PI_BACKEND_SESSION_TOOL_NAMES } from './shared.ts';
import type { PiSubprocessRuntimeContext } from './shared.ts';

/**
   * Guardrail: ensure every backend-mode session tool from core is implemented here.
   * This fails fast in development/CI instead of surfacing as runtime "Unknown session tool".
   */
export function assertBackendSessionToolParity(transportOwner: PiAgent): void {
    const missing = [...SESSION_BACKEND_TOOL_NAMES].filter((name) => !PI_BACKEND_SESSION_TOOL_NAMES.has(name));
    if (missing.length > 0) {
        throw new Error(`PiAgent missing backend session tool implementations: ${missing.join(', ')}`);
    }
}

// ============================================================
  // Subprocess Management
  // ============================================================

  /**
   * Ensure the subprocess is spawned and ready.
   * Lazy initialization -- spawns on first use.
   */
export async function ensureSubprocess(transportOwner: PiAgent): Promise<void> {
    if (transportOwner["subprocess"] && transportOwner["subprocessReady"]) {
        await transportOwner["subprocessReady"];
        return;
    }
    if (transportOwner["subprocessSpawnInFlight"]) {
        await transportOwner["subprocessSpawnInFlight"];
        return;
    }
    const spawnAttempt = transportOwner["spawnSubprocess"]();
    transportOwner["subprocessSpawnInFlight"] = spawnAttempt;
    try {
        await spawnAttempt;
    }
    finally {
        if (transportOwner["subprocessSpawnInFlight"] === spawnAttempt) {
            transportOwner["subprocessSpawnInFlight"] = null;
        }
    }
}

/**
   * Spawn the pi-agent-server subprocess and set up JSONL communication.
   */
export async function spawnSubprocess(transportOwner: PiAgent, agentClass: typeof PiAgent): Promise<void> {
    // Diagnostics belong to one subprocess generation. Do not attribute a
    // previous runtime's stderr tail to a later failure after recreation.
    transportOwner["stderrBuffer"] = [];
    transportOwner["stderrBufferBytes"] = 0;
    const runtime = getBackendRuntime(transportOwner["config"]);
    const piServerPath = runtime.paths?.piServer;
    if (!piServerPath) {
        throw new Error('piServerPath not configured. Cannot spawn Pi subprocess.');
    }
    const nodePath = runtime.paths?.node || process.execPath;
    const cwd = transportOwner["resolvedCwd"]();
    // Node reports spawn(command) ENOENT for an invalid cwd, even when the
    // protected runtime executable exists. Surface the directory issue first.
    await assertExistingWorkingDirectory(cwd);
    transportOwner["debug"](`Spawning Pi subprocess: ${nodePath} ${piServerPath}`);
    transportOwner["resetSubprocessErrorDedup"]();
    // Build session ID and session dir path upfront (used for spawn env + init command)
    const sessionId = transportOwner["config"].session?.id || `agent-${Date.now()}`;
    const subprocessRuntimeContext: PiSubprocessRuntimeContext = {
        runtimeId: `pi-${randomUUID()}`,
        sessionId,
    };
    const sessionDir = transportOwner["config"].session
        ? join(transportOwner["config"].workspace.rootPath, 'sessions', sessionId)
        : undefined;
    // Build spawn args — optionally preload the network interceptor
    // for tool metadata injection/capture across all API formats.
    const args = [piServerPath];
    const interceptorPath = runtime.paths?.interceptor;
    if (interceptorPath) {
        args.unshift('--require', interceptorPath);
    }
    // Resolve credentials before spawning so we can derive AWS env vars
    // from the same fetch that produces piAuth (single source of truth).
    // For OAuth providers with short-lived access tokens: preemptively refresh
    // before fetching credentials, so getPiAuth() picks up a fresh token. Also
    // join a refresh started by the auth-failed runtime being replaced.
    // refreshAndPushTokens guards this.subprocess internally — safe to call pre-spawn.
    if (transportOwner["config"].authType === 'oauth' && runtime.piAuthProvider) {
        const slug = transportOwner["config"].connectionSlug || 'pi';
        const expectedBindingId = transportOwner["config"].expectedLlmCredentialBindingId;
        const stored = await getCredentialManager().getLlmOAuth(slug, expectedBindingId);
        if (shouldRefreshPiOAuthBeforeSpawn({
            authType: transportOwner["config"].authType,
            piAuthProvider: runtime.piAuthProvider,
            refreshToken: stored?.refreshToken,
            expiresAt: stored?.expiresAt,
            refreshInFlight: agentClass["globalRefreshMutex"].has(`${slug}\u0000${expectedBindingId ?? 'unsealed'}`),
        })) {
            transportOwner["debug"](`${runtime.piAuthProvider} token expired or expiring soon — refreshing before session start`);
            await transportOwner["refreshAndPushTokens"]();
        }
    }
    // Retrieve auth credentials for the subprocess.
    // Custom endpoint mode must NOT fall back to global API keys — keyless local endpoints
    // are valid, and non-local endpoints should fail explicitly instead of using unrelated creds.
    const piAuth = await transportOwner["getPiAuth"]();
    const isCustomEndpointMode = !!runtime.customEndpoint;
    const legacyApiKey = (!piAuth && !isCustomEndpointMode) ? await transportOwner["getApiKey"]() : undefined;
    if (isCustomEndpointMode && !piAuth) {
        transportOwner["debug"]('Custom endpoint mode: no provider credential configured, sending empty API key');
    }
    // Derive AWS env vars from the piAuth credential (single fetch, no race).
    const isStrictLocalEndpoint = Boolean(runtime.baseUrl
        && (() => {
            try {
                const h = new URL(runtime.baseUrl).hostname.replace(/^\[|\]$/g, '');
                return h === 'localhost' || h === '127.0.0.1' || h === '::1';
            }
            catch {
                return false;
            }
        })()
        && process.env.ROBB_ALLOW_LOCAL_MODEL_WEB_TOOLS !== '1');
    const awsEnv = isStrictLocalEndpoint ? {} : transportOwner["buildAwsEnv"](piAuth, runtime);
    const providerEnv = isStrictLocalEndpoint
        ? {
            CRAFT_STRICT_LOCAL_ENDPOINT: '1',
            NO_PROXY: 'localhost,127.0.0.1,::1',
            no_proxy: 'localhost,127.0.0.1,::1',
            HTTP_PROXY: '',
            HTTPS_PROXY: '',
            ALL_PROXY: '',
            http_proxy: '',
            https_proxy: '',
            all_proxy: '',
        }
        : transportOwner["buildProviderEnv"](runtime);
    const proxyEnv = isStrictLocalEndpoint ? {} : getProxyEnvVars();
    // Set up the handshake only after all pre-spawn async work succeeded. This
    // avoids leaving an unreachable pending promise when credential resolution
    // fails before a child process exists.
    transportOwner["subprocessReady"] = new Promise<void>((resolve, reject) => {
        transportOwner["subprocessReadyResolve"] = resolve;
        transportOwner["subprocessReadyReject"] = reject;
    });
    // Spawn the subprocess
    let child: ChildProcess;
    try {
        const protectedCommand = protectApplicationCommand(nodePath, args);
        child = spawn(protectedCommand.command, protectedCommand.args, {
            cwd,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: buildPiSubprocessEnvironment({
                proxyEnv,
                envOverrides: transportOwner["config"].envOverrides,
                providerEnv,
                awsEnv,
                // Pass session dir for cross-process toolMetadataStore.
                sessionDir,
                // Propagate debug mode without inheriting the rest of process.env.
                debugEnabled: process.argv.includes('--debug') || process.env.CRAFT_DEBUG === '1',
            }),
        });
    }
    catch (error) {
        // No consumer can be awaiting the private ready promise yet; discard it
        // and let spawnSubprocess's own rejection reach every deduplicated caller.
        transportOwner["subprocessReady"] = null;
        transportOwner["subprocessReadyResolve"] = null;
        transportOwner["subprocessReadyReject"] = null;
        throw error;
    }
    transportOwner["subprocess"] = child;
    transportOwner["subprocessRuntimeContext"] = subprocessRuntimeContext;
    transportOwner["subprocessRuntimeContexts"].set(child, subprocessRuntimeContext);
    const configuredIdleMs = Number(process.env.CRAFT_AGENT_PROCESS_IDLE_TIMEOUT_MS);
    transportOwner["subprocessSupervisorHandle"] = registerLongRunningProcess(child, {
        id: `pi-agent:${sessionId}:${child.pid ?? Date.now()}`,
        kind: 'agent-runtime',
        ownerId: sessionId,
        maxIdleMs: Number.isFinite(configuredIdleMs) && configuredIdleMs > 0
            ? configuredIdleMs
            : 30 * 60 * 1000,
        isBusy: () => transportOwner["hasPendingSubprocessWork"](),
        metadata: {
            ...(transportOwner["config"].providerType ? { provider: transportOwner["config"].providerType } : {}),
            workspaceId: transportOwner["config"].workspace.id,
        },
    });
    // Set up readline for JSONL parsing from stdout
    transportOwner["readline"] = createInterface({
        input: child.stdout!,
        crlfDelay: Infinity,
    });
    transportOwner["readline"].on('line', (line: string) => {
        transportOwner["handleLine"](line, child, subprocessRuntimeContext);
    });
    // Always capture stderr into a bounded ring buffer so callers (e.g. the
    // connection-test timeout path in factory.ts) can surface it on failure.
    // Keep the CRAFT_DEBUG-gated log for interactive dev work. Production
    // diagnostics are emitted once, on unexpected exit, from the bounded tail.
    child.stderr?.on('data', (data: Buffer) => {
        const text = data.toString();
        transportOwner["recordStderr"](text);
        const trimmed = text.trim();
        const debugEnabled = process.argv.includes('--debug') || process.env.CRAFT_DEBUG === '1';
        if (trimmed && debugEnabled) {
            const safeTail = redactRuntimeDiagnosticText(trimmed).slice(-RUNTIME_DIAGNOSTIC_MAX_CHARS);
            transportOwner["debug"](`[subprocess stderr] ${safeTail}`);
        }
    });
    child.stdin?.on('error', (error: NodeJS.ErrnoException) => {
        transportOwner["debug"](`Pi subprocess stdin closed while sending command: ${error.code || error.message}`);
    });
    // `error` does not prove process termination and Node may emit `close`
    // without `exit` after a spawn failure. Converge both terminal signals
    // exactly once while preserving the diagnostic captured below.
    let terminationHandled = false;
    const handleConfirmedTermination = (code: number | null, signal: NodeJS.Signals | null) => {
        if (terminationHandled)
            return;
        terminationHandled = true;
        transportOwner["handleSubprocessExit"](code, signal, child, undefined, subprocessRuntimeContext);
    };
    child.on('exit', handleConfirmedTermination);
    child.on('close', handleConfirmedTermination);
    child.on('error', (error) => {
        transportOwner["handleSubprocessError"](error, child, subprocessRuntimeContext);
    });
    const startupTimeoutMs = resolvePiSubprocessStartupTimeoutMs(process.env.CRAFT_AGENT_PROCESS_STARTUP_TIMEOUT_MS);
    transportOwner["subprocessReadyTimer"] = setTimeout(() => {
        if (transportOwner["subprocess"] !== child || !transportOwner["subprocessReadyReject"])
            return;
        const error = new PiRuntimeInterruptedError(`Pi subprocess did not become ready within ${startupTimeoutMs} ms`, 'startup_timeout');
        transportOwner["debug"](error.message);
        transportOwner["rejectSubprocessReady"](error);
        transportOwner["expectedSubprocessExits"].add(child);
        if (transportOwner["subprocessSupervisorHandle"]) {
            transportOwner["subprocessSupervisorHandle"].terminate('Pi agent startup timeout');
        }
        else {
            child.kill('SIGTERM');
        }
        transportOwner["scheduleSubprocessForceKill"](child, subprocessRuntimeContext);
    }, startupTimeoutMs);
    transportOwner["subprocessReadyTimer"].unref?.();
    const sessionPath = transportOwner["config"].session
        ? getSessionPath(transportOwner["config"].workspace.rootPath, sessionId)
        : '';
    const plansFolderPath = getSessionPlansPath(transportOwner["config"].workspace.rootPath, sessionId);
    const workingDirectory = transportOwner["config"].session?.workingDirectory || cwd;
    // Send init command (flat structure matching subprocess InboundMessage type)
    transportOwner["send"]({
        type: 'init',
        apiKey: legacyApiKey || '',
        model: transportOwner["_model"],
        modelRoutePinned: transportOwner["modelRoutePinned"](),
        cwd,
        thinkingLevel: transportOwner["_thinkingLevel"],
        workspaceRootPath: transportOwner["config"].workspace.rootPath,
        sessionId,
        // Provider session IDs are persisted conversation metadata, never auth
        // credentials. ACP-backed providers such as Mistral Vibe use this only
        // when they advertise official session restoration support.
        sdkSessionId: transportOwner["piSessionId"],
        sessionPath,
        workingDirectory,
        plansFolderPath,
        miniModel: transportOwner["config"].miniModel,
        providerType: transportOwner["config"].providerType,
        authType: transportOwner["config"].authType,
        workspaceId: transportOwner["config"].workspace.id,
        piAuth,
        baseUrl: runtime.baseUrl,
        customEndpoint: runtime.customEndpoint,
        customModels: runtime.customModels,
        // Branch params for Pi SDK session fork
        branchFromSdkSessionId: transportOwner["config"].session?.branchFromSdkSessionId,
        branchFromSessionPath: transportOwner["config"].session?.branchFromSessionPath,
        branchFromSdkTurnId: transportOwner["config"].session?.branchFromSdkTurnId,
    });
    // Wait for subprocess to report ready
    await transportOwner["subprocessReady"];
    transportOwner["debug"]('Pi subprocess is ready');
    // Ensure auto-compaction is explicitly enabled for embedded sessions.
    // PI defaults this to enabled, but we set it proactively for clarity and resilience.
    try {
        const enabled = await transportOwner["requestSetAutoCompaction"](true);
        transportOwner["debug"](`PI auto-compaction enabled: ${enabled}`);
    }
    catch (error) {
        transportOwner["debug"](`Failed to configure PI auto-compaction (continuing): ${error instanceof Error ? error.message : String(error)}`);
    }
    // Register session-scoped tools as proxy tools in the subprocess.
    // These tools (SubmitPlan, config_validate, source auth, call_llm, etc.)
    // are executed in the main process when the LLM calls them.
    transportOwner["assertBackendSessionToolParity"]();
    const sessionToolDefs = filterPiSessionToolDefs(
        getSessionToolProxyDefs(), getBrowserToolEnabled(), isStrictLocalEndpoint,
    );
    transportOwner["send"]({
        type: 'register_tools',
        tools: sessionToolDefs,
    });
    transportOwner["debug"](`Registered ${sessionToolDefs.length} session tools with subprocess`);
    // If pool has source tools, register them with the subprocess.
    transportOwner["registerPoolToolsWithSubprocess"]();
}

/**
   * Send pool's proxy tool defs to subprocess for model visibility.
   */
export function registerPoolToolsWithSubprocess(transportOwner: PiAgent): void {
    if (!transportOwner["mcpPool"])
        return;
    const proxyDefs = transportOwner["mcpPool"].getProxyToolDefs();
    if (proxyDefs.length > 0) {
        transportOwner["send"]({
            type: 'register_tools',
            tools: proxyDefs,
        });
        transportOwner["debug"](`Registered ${proxyDefs.length} MCP source tools from pool with subprocess`);
    }
}

export function filterPiSessionToolDefs(
    sessionToolDefs: ReturnType<typeof getSessionToolProxyDefs>,
    browserToolEnabled: boolean,
    isStrictLocalEndpoint: boolean,
): ReturnType<typeof getSessionToolProxyDefs> {
    if (!browserToolEnabled) {
        sessionToolDefs = sessionToolDefs.filter(d => d.name !== 'mcp__session__browser_tool');
    }
    if (isStrictLocalEndpoint) {
        const blockedLocalSessionTools = new Set([
            'mcp__session__send_developer_feedback',
            'mcp__session__source_oauth_trigger',
            'mcp__session__source_google_oauth_trigger',
            'mcp__session__source_slack_oauth_trigger',
            'mcp__session__source_microsoft_oauth_trigger',
        ]);
        sessionToolDefs = sessionToolDefs.filter(d => !blockedLocalSessionTools.has(d.name));
    }
    return sessionToolDefs;
}
