import { type Options } from "@anthropic-ai/claude-agent-sdk";
import { getDefaultOptions } from "../options.ts";
import { getSystemPromptAsync } from "../../prompts/system.ts";
import { type MiniAgentConfig, MINI_AGENT_TOOLS, MINI_AGENT_MCP_KEYS } from "../base-agent.ts";
import { debug } from "../../utils/debug.ts";
import { type SdkAutomationCallbackMatcher } from "../../automations/index.ts";
// Stateless tool matching — pure functions for SDK message → AgentEvent conversion
// Stateless tool matching — pure functions for SDK message → AgentEvent conversion
import { parseWorkflowIdFromTranscriptPath } from "../tool-matching.ts";
import type { ClaudeAgent } from '../claude-agent.ts';
import type { ClaudeQueryPreparation } from './shared.ts';

export function buildClaudeHooks(transportOwner: ClaudeAgent, sessionId: string, gmailRuntimeId: string): Options['hooks'] {
    // Build user-defined hooks from automations.json using the workspace-level AutomationSystem
    const userHooks: Partial<Record<string, SdkAutomationCallbackMatcher[]>> = transportOwner["automationSystem"]?.buildSdkHooks() ?? {};
    if (Object.keys(userHooks).length > 0) {
        debug('[CraftAgent] User SDK hooks loaded:', Object.keys(userHooks).join(', '));
    }
    // Internal hooks for permission handling and logging
    const internalHooks: Record<string, SdkAutomationCallbackMatcher[]> = {
        PreToolUse: [{
                hooks: [transportOwner["createPreToolUseHook"](sessionId, gmailRuntimeId)],
            }],
        // Observe successful reads only; this hook does not modify SDK tool output.
        PostToolUse: [{
                hooks: [async (input) => {
                        if (input.hook_event_name === 'PostToolUse' && input.tool_use_id) {
                            transportOwner["settleAdmittedToolExecution"](input.tool_use_id);
                            transportOwner["prerequisiteManager"].trackToolCompletion(input.tool_use_id, input.tool_response, false);
                        }
                        return { continue: true };
                    }],
            }],
        PostToolUseFailure: [{
                hooks: [async (input) => {
                        if (input.tool_use_id) {
                            transportOwner["settleAdmittedToolExecution"](input.tool_use_id);
                            transportOwner["prerequisiteManager"].trackToolCompletion(input.tool_use_id, undefined, true);
                        }
                        return { continue: true };
                    }],
            }],
        // For API tools (api_*), summarization happens in api-tools.ts.
        // For external MCP servers (stdio/HTTP), we cannot modify their output - they're responsible
        // for their own size management via pagination or filtering.
        // ═══════════════════════════════════════════════════════════════════════════
        // SUBAGENT HOOKS: Logging only - parent tracking uses SDK's parent_tool_use_id
        // ═══════════════════════════════════════════════════════════════════════════
        SubagentStart: [{
                hooks: [async (input, _hookToolUseID) => {
                        const typedInput = input as {
                            agent_id?: string;
                            agent_type?: string;
                        };
                        debug(`[ClaudeAgent] SubagentStart: agent_id=${typedInput.agent_id}, type=${typedInput.agent_type}`);
                        return { continue: true };
                    }],
            }],
        SubagentStop: [{
                hooks: [async (input, _toolUseID) => {
                        const typedInput = input as {
                            agent_id?: string;
                            agent_transcript_path?: string;
                        };
                        debug(`[ClaudeAgent] SubagentStop: agent_id=${typedInput.agent_id}, transcript=${typedInput.agent_transcript_path ?? 'none'}`);
                        // If this sub-agent belongs to a running Workflow (its transcript
                        // lives under .../workflows/wf_XXX/), attribute its completion to the
                        // owning workflow chip so the user sees live fan-out progress. The
                        // transcript path is the only place the wf_ id is exposed to us;
                        // ordinary sub-agents live under .../subagents/agent-* and return null.
                        const workflowId = parseWorkflowIdFromTranscriptPath(typedInput.agent_transcript_path);
                        if (workflowId && transportOwner["onBackgroundEvent"]) {
                            transportOwner["onBackgroundEvent"]({
                                type: 'workflow_agent_completed',
                                workflowId,
                                agentId: typedInput.agent_id ?? '',
                            });
                        }
                        return { continue: true };
                    }],
            }],
    };
    // Merge internal hooks with user hooks from automations.json
    // Internal hooks run first (permissions), then user hooks
    const mergedHooks: Record<string, SdkAutomationCallbackMatcher[]> = { ...internalHooks };
    for (const [event, matchers] of Object.entries(userHooks) as [
        string,
        SdkAutomationCallbackMatcher[]
    ][]) {
        if (!matchers)
            continue;
        if (mergedHooks[event]) {
            // Append user hooks after internal hooks
            mergedHooks[event] = [...mergedHooks[event]!, ...matchers];
        }
        else {
            // Add new event hooks
            mergedHooks[event] = matchers;
        }
    }
    return mergedHooks;
}

export async function buildClaudeQueryOptions(transportOwner: ClaudeAgent, sessionId: string, gmailRuntimeId: string, _isRetry: boolean, prepared: ClaudeQueryPreparation): Promise<Options> {
    const { effectiveModel, thinkingOptions, miniConfig, resolvedCwd, mcpServers, disallowedTools } = prepared;
    return {
        ...getDefaultOptions({ ...transportOwner["config"].envOverrides, ANTHROPIC_DEFAULT_HAIKU_MODEL: transportOwner["getModel"]() }),
        model: effectiveModel,
        // Capture stderr from SDK subprocess for error diagnostics
        // This helps identify why sessions fail with "process exited with code 1"
        stderr: (data: string) => {
            // The SDK dumps its ENTIRE minified source whenever a hook callback
            // throws. The common (benign) case is a background sub-agent whose
            // PreToolUse hook fires *after* the turn's input stream has closed at
            // turn-end teardown — "Error in hook callback hook_N: … Stream closed"
            // (a can_use_tool control request on a closed stream). That is the
            // WS2 background-agent-dies-at-turn-end race: expected until keep-alive
            // lands, and not actionable. Collapse it to a one-line warning instead
            // of flooding the log/console with kilobytes of minified bundle.
            const isHookStreamClosedNoise = data.includes('Error in hook callback') &&
                (data.includes('Stream closed') ||
                    data.includes('stream closed before response'));
            if (isHookStreamClosedNoise) {
                const concise = '[SDK stderr] hook callback raced turn-end teardown (stream closed): a background tool call was cut off when the turn ended. Expected until background keep-alive lands.';
                debug(concise);
                console.error(concise);
                transportOwner["lastStderrOutput"].push('hook callback: Stream closed (turn-end teardown)');
                if (transportOwner["lastStderrOutput"].length > 20) {
                    transportOwner["lastStderrOutput"].shift();
                }
                return;
            }
            // Log to both debug file AND console for visibility
            debug('[SDK stderr]', data);
            console.error('[SDK stderr]', data);
            // Keep last 20 lines to avoid unbounded memory growth
            transportOwner["lastStderrOutput"].push(data);
            if (transportOwner["lastStderrOutput"].length > 20) {
                transportOwner["lastStderrOutput"].shift();
            }
        },
        // Thinking config is provider-aware:
        // - true Anthropic backends use adaptive thinking + effort
        // - anthropic_compat/custom endpoints fall back to token budgets
        // - non-Claude models disable thinking entirely
        ...thinkingOptions,
        // System prompt configuration:
        // - Mini agents: Use custom (lean) system prompt without Claude Code preset
        // - Normal agents: Append to Claude Code's system prompt (recommended by docs)
        systemPrompt: miniConfig.enabled
            ? transportOwner["getMiniSystemPrompt"]()
            : {
                type: 'preset' as const,
                preset: 'claude_code' as const,
                // Working directory included for monorepo context file discovery
                append: await getSystemPromptAsync(transportOwner["pinnedPreferencesPrompt"] ?? undefined, transportOwner["config"].debugMode, transportOwner["workspaceRootPath"], transportOwner["config"].session?.workingDirectory, undefined, // preset
                undefined, // backendName
                transportOwner["pinnedIncludeCoAuthoredBy"] ?? undefined, transportOwner["pinnedProjectContext"] ?? undefined),
            },
        // Use sdkCwd for SDK session storage - this is set once at session creation and never changes.
        // This ensures SDK can always find session transcripts regardless of workingDirectory changes.
        // Note: workingDirectory is still used for context injection and shown to the agent.
        // For fork attempts: use the parent's sdkCwd so the SDK subprocess can find the parent's
        // session file (stored under ~/.claude/projects/{cwd-hash}/). Without this, cross-CWD
        // branches (e.g., worktree ↔ main repo) fail with "No conversation found".
        cwd: resolvedCwd,
        includePartialMessages: true,
        // Tools configuration:
        // - Mini agents: minimal set for quick config edits (reduces token count ~70%)
        // - Regular agents: full Claude Code toolset
        tools: (() => {
            const toolsValue = miniConfig.enabled
                ? [...miniConfig.tools] // Use centralized tool list
                : { type: 'preset' as const, preset: 'claude_code' as const };
            debug('[ClaudeAgent] 🔧 Tools configuration:', JSON.stringify(toolsValue));
            return toolsValue;
        })(),
        // Bypass SDK's built-in permission system - we handle all permissions via PreToolUse hook
        // This allows Safe Mode to properly allow read-only bash commands without SDK interference
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        // User hooks from automations.json are merged with internal hooks
        hooks: transportOwner["buildClaudeHooks"](sessionId, gmailRuntimeId),
        // Continue from previous session if we have one (enables conversation history & auto compaction)
        // Skip resume on retry (after session expiry) to start fresh
        // For branched sessions: fork the parent session so the agent has full conversation context
        ...(!_isRetry && transportOwner["sessionId"]
            ? { resume: transportOwner["sessionId"] }
            : !_isRetry && transportOwner["branchFromSdkSessionId"]
                ? {
                    resume: transportOwner["branchFromSdkSessionId"],
                    forkSession: true,
                    // Trim the forked conversation at the branch point so the model
                    // only sees messages up to where the user branched, not the full parent.
                    ...(transportOwner["branchFromSdkTurnId"] ? { resumeSessionAt: transportOwner["branchFromSdkTurnId"] } : {}),
                }
                : {}),
        mcpServers,
        // NOTE: This callback is NOT called by the SDK because we set `permissionMode: 'bypassPermissions'` above.
        // All permission logic is handled via the PreToolUse hook instead (see hooks.PreToolUse above).
        // Bash permission logic is in PreToolUse where it actually executes.
        canUseTool: async (_toolName, input) => {
            return { behavior: 'allow' as const, updatedInput: input as Record<string, unknown> };
        },
        // Selectively disable tools - file tools are disabled (use MCP), web/code controlled by settings
        disallowedTools,
        // No plugins — skills are handled by BaseAgent.chat() via read-before-execute
        // (the model reads SKILL.md files directly, enforced by PrerequisiteManager)
        plugins: [],
    };
}

export function getModel(transportOwner: ClaudeAgent): string {
    return transportOwner["_model"];
}

/**
   * Get the list of SDK tools (captured from init message)
   */
export function getSdkTools(transportOwner: ClaudeAgent): string[] {
    return transportOwner["eventAdapter"].sdkTools;
}

// ============================================================
  // Mini Agent Mode (uses centralized constants from BaseAgent)
  // ============================================================

  /**
   * Check if running in mini agent mode.
   * Uses the centralized `systemPromptPreset` flag from BaseAgent.
   */
export function isMiniAgent(transportOwner: ClaudeAgent): boolean {
    return transportOwner["config"].systemPromptPreset === 'mini';
}

/**
   * Get mini agent configuration for provider-specific application.
   * Returns centralized config from BaseAgent constants.
   */
export function getMiniAgentConfig(transportOwner: ClaudeAgent): MiniAgentConfig {
    const enabled = transportOwner["isMiniAgent"]();
    return {
        enabled,
        tools: enabled ? MINI_AGENT_TOOLS : [],
        mcpServerKeys: enabled ? MINI_AGENT_MCP_KEYS : [],
        minimizeThinking: enabled,
    };
}
