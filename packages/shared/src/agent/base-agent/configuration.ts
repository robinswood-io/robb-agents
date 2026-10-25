import type { ThinkingLevel } from "../thinking-levels.ts";
import type { PermissionMode } from "../mode-manager.ts";
import type { AuthRequest } from "../session-scoped-tools.ts";
import { ConfigWatcherManager, type ConfigWatcherManagerCallbacks } from "../core/config-watcher-manager.ts";
import type { AgentEvent as AutomationAgentEvent, SdkAutomationInput } from "../../automations/types.ts";
import type { BaseAgent } from '../base-agent.ts';

// ============================================================
  // Config Watcher Management
  // ============================================================

  /**
   * Start the config file watcher for hot-reloading changes.
   * Called by subclass constructor in non-headless mode.
   */
export function startConfigWatcher(transportOwner: BaseAgent): void {
    if (transportOwner["configWatcherManager"]) {
        return; // Already running
    }
    if (transportOwner["config"].skipConfigWatcher) {
        transportOwner["debug"]('Config watching skipped (managed by server)');
        return;
    }
    const callbacks: ConfigWatcherManagerCallbacks = {
        onSourceChange: (slug, source) => {
            transportOwner["debug"](`Source changed: ${slug} ${source ? 'updated' : 'deleted'}`);
            transportOwner["onSourceChange"]?.(slug, source);
        },
        onSourcesListChange: (sources) => {
            transportOwner["debug"](`Sources list changed: ${sources.length} sources`);
            transportOwner["onSourcesListChange"]?.(sources);
        },
        onValidationError: (file, errors) => {
            transportOwner["debug"](`Config validation error: ${file}`);
            transportOwner["onConfigValidationError"]?.(file, errors);
        },
    };
    transportOwner["configWatcherManager"] = new ConfigWatcherManager({
        workspaceRootPath: transportOwner["config"].workspace.rootPath,
        isHeadless: transportOwner["config"].isHeadless,
        onDebug: (msg) => transportOwner["debug"](msg),
    }, callbacks);
    transportOwner["configWatcherManager"].start();
    transportOwner["debug"]('Config watcher started');
}

/**
   * Stop the config file watcher.
   */
export function stopConfigWatcher(transportOwner: BaseAgent): void {
    if (transportOwner["configWatcherManager"]) {
        transportOwner["configWatcherManager"].stop();
        transportOwner["configWatcherManager"] = null;
        transportOwner["debug"]('Config watcher stopped');
    }
}

// ============================================================
  // Debug Logging (protected for subclass override)
  // ============================================================

  /**
   * Log a debug message. Override in subclass to add prefix.
   */
export function debug(transportOwner: BaseAgent, message: string): void {
    transportOwner["onDebug"]?.(message);
}

/**
   * Fire an automation agent event (from automations.json) via AutomationSystem.
   * Catches all errors — automations must never break the agent flow.
   *
   * Non-Claude backends call this directly. ClaudeAgent uses SDK's buildSdkHooks() instead.
   *
   * @param signal - Optional AbortSignal for cancelling automation execution on abort
   */
export async function emitAutomationEvent(transportOwner: BaseAgent, event: AutomationAgentEvent, input: SdkAutomationInput, signal?: AbortSignal): Promise<void> {
    try {
        await transportOwner["automationSystem"]?.executeAgentEvent(event, input, signal);
    }
    catch (err) {
        transportOwner["debug"](`Automation event ${event} failed: ${err}`);
    }
}

// ============================================================
  // Session MCP Tool Completion Handling
  // ============================================================

  /**
   * Handle successful completion of a session MCP tool (SubmitPlan, auth tools).
   *
   * WHY THIS IS ON BaseAgent:
   * -------------------------
   * Session-scoped tools (SubmitPlan, source_oauth_trigger, etc.) run in an
   * EXTERNAL MCP server subprocess (packages/session-mcp-server). That subprocess
   * has its own process memory, so when it calls getSessionScopedToolCallbacks(),
   * the callback registry is empty — it was populated in THIS process, not the subprocess.
   *
   * Instead, PiAgent detects session MCP tool completions from its own event
   * stream and calls THIS shared method to fire the appropriate callback.
   *
   * ClaudeAgent doesn't need this — its session-scoped tools run in-process
   * via Claude Agent SDK, so the callback registry works directly.
   *
   * CALLBACKS FIRED:
   * - SubmitPlan → this.onPlanSubmitted(planPath)
   *   → Electron reads plan file, shows plan card, calls interruptForHandoff(PlanSubmitted)
   * - Auth tools → this.onAuthRequest(authRequest)
   *   → Electron shows auth dialog, calls interruptForHandoff(AuthRequest)
   */
export function handleSessionMcpToolCompletion(transportOwner: BaseAgent, toolName: string, args: Record<string, unknown>): void {
    // SubmitPlan — trigger plan view in the UI.
    // The Electron SessionManager's onPlanSubmitted callback will:
    //   1. Read the plan file content
    //   2. Create a plan message (role: 'plan')
    //   3. Send plan_submitted event to renderer
    //   4. Call interruptForHandoff(AbortReason.PlanSubmitted) → turn terminates
    if (toolName === 'SubmitPlan' && args.planPath) {
        transportOwner["debug"](`SubmitPlan completed: ${args.planPath}`);
        transportOwner["onPlanSubmitted"]?.(args.planPath as string);
        return;
    }
    // Auth tools — trigger auth request in the UI.
    // Maps MCP tool names to auth request types.
    const authToolTypes: Record<string, string> = {
        'source_oauth_trigger': 'oauth',
        'source_google_oauth_trigger': 'oauth-google',
        'source_slack_oauth_trigger': 'oauth-slack',
        'source_microsoft_oauth_trigger': 'oauth-microsoft',
        'source_credential_prompt': 'credential',
    };
    const authType = authToolTypes[toolName];
    if (authType && args.sourceSlug && transportOwner["onAuthRequest"]) {
        const sourceSlug = args.sourceSlug as string;
        const source = transportOwner["sourceManager"].getAllSources().find(s => s.config.slug === sourceSlug);
        const sourceName = source?.config.name || sourceSlug;
        transportOwner["debug"](`Auth tool completed: ${toolName} for ${sourceSlug}`);
        transportOwner["onAuthRequest"]({
            type: authType,
            requestId: `${Date.now()}-auth`,
            sessionId: transportOwner["config"].session?.id || '',
            sourceSlug,
            sourceName,
            ...(authType === 'credential' && {
                mode: (args.mode as string) || 'bearer',
                labels: args.labels as Record<string, string> | undefined,
                description: args.description as string | undefined,
                hint: args.hint as string | undefined,
            }),
        } as AuthRequest);
    }
}

export function setModel(transportOwner: BaseAgent, model: string): void {
    transportOwner["_model"] = model;
}

export function getThinkingLevel(transportOwner: BaseAgent): ThinkingLevel {
    return transportOwner["_thinkingLevel"];
}

export function setThinkingLevel(transportOwner: BaseAgent, level: ThinkingLevel): void {
    transportOwner["_thinkingLevel"] = level;
    transportOwner["debug"](`Thinking level set to: ${level}`);
}

export function setPermissionMode(transportOwner: BaseAgent, mode: PermissionMode): void {
    transportOwner["permissionManager"].setPermissionMode(mode);
    transportOwner["onPermissionModeChange"]?.(mode);
}

export function setExternalActionPolicy(transportOwner: BaseAgent, policy: 'confirm' | 'allow-in-execute'): void {
    transportOwner["config"].externalActionPolicy = policy;
    transportOwner["promptBuilder"].setExternalActionPolicy(policy);
    transportOwner["debug"](`External action policy set to: ${policy}`);
}

export function cyclePermissionMode(transportOwner: BaseAgent): PermissionMode {
    const newMode = transportOwner["permissionManager"].cyclePermissionMode();
    transportOwner["onPermissionModeChange"]?.(newMode);
    return newMode;
}

/**
   * Check if currently in safe mode (read-only exploration).
   */
export function isInSafeMode(transportOwner: BaseAgent): boolean {
    return transportOwner["permissionManager"].getPermissionMode() === 'safe';
}
