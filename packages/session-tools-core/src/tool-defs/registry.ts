import { SpawnSessionSchema } from "../spawn-session-schema.ts";
// Handlers
import { handleUpdatePlan, UpdatePlanSchema } from "../handlers/update-plan.ts";
import { handleSubmitPlan } from "../handlers/submit-plan.ts";
import { handleConfigValidate } from "../handlers/config-validate.ts";
import { handleSkillValidate } from "../handlers/skill-validate.ts";
import { handleMermaidValidate } from "../handlers/mermaid-validate.ts";
import { handleSourceTest } from "../handlers/source-test.ts";
import { handleSourceOAuthTrigger, handleGoogleOAuthTrigger, handleSlackOAuthTrigger, handleMicrosoftOAuthTrigger } from "../handlers/source-oauth.ts";
import { handleCredentialPrompt } from "../handlers/credential-prompt.ts";
import { handleUpdatePreferences } from "../handlers/update-preferences.ts";
import { handleTransformData } from "../handlers/transform-data.ts";
import { handleScriptSandbox } from "../handlers/script-sandbox.ts";
import { handleRenderTemplate } from "../handlers/render-template.ts";
import { handleSendDeveloperFeedback } from "../handlers/send-developer-feedback.ts";
import { handleSetSessionLabels } from "../handlers/set-session-labels.ts";
import { handleSetSessionStatus } from "../handlers/set-session-status.ts";
import { handleSetCompletionCriteria } from "../handlers/set-completion-criteria.ts";
import { handleRequestUserInput } from "../handlers/request-user-input.ts";
import { RequestUserInputSchema } from "../request-user-input-schema.ts";
import { SetCompletionCriteriaSchema, SET_COMPLETION_CRITERIA_FORMAT_HELP } from "../completion-criteria-schema.ts";
import { handleProjectLearning } from "../handlers/project-learning.ts";
import { handleGetSessionInfo } from "../handlers/get-session-info.ts";
import { handleListSessions } from "../handlers/list-sessions.ts";
import { handleWaitSessions } from "../handlers/wait-sessions.ts";
import { handleListBackgroundTasks } from "../handlers/list-background-tasks.ts";
import { handleSendAgentMessage } from "../handlers/send-agent-message.ts";
import { handleListMessagingChannels, handleUnbindMessagingChannel } from "../handlers/messaging.ts";
import type { SessionToolDef } from './contracts.ts';
import { defineRegistryTool } from './contracts.ts';
import { TOOL_DESCRIPTIONS } from './descriptions.ts';
import { BrowserToolSchema, CallLlmSchema, ConfigValidateSchema, CredentialPromptSchema, GetSessionInfoSchema, ListBackgroundTasksSchema, ListMessagingChannelsSchema, ListSessionsSchema, MermaidValidateSchema, ProjectLearningSchema, RenderTemplateSchema, ScriptSandboxSchema, SendAgentMessageSchema, SendDeveloperFeedbackSchema, SetSessionLabelsSchema, SetSessionStatusSchema, SkillValidateSchema, SourceOAuthTriggerSchema, SourceTestSchema, SubmitPlanSchema, TransformDataSchema, UnbindMessagingChannelSchema, UpdatePreferencesSchema, WaitSessionsSchema } from './schemas.ts';

// ============================================================
// Canonical Tool Registry
// ============================================================

export const SESSION_TOOL_DEFS: SessionToolDef[] = [
  { name: 'update_plan', description: 'Publish an optional live checklist when it materially helps track work with several dependent steps. Send the full current state with pending, in_progress, and completed items, but update it only when scope or step status changes materially, not after every tool call. Skip it for simple tasks, direct answers, and bounded reviews. Include a concise explanation of observed progress. Mark completed only after doing the work; leave unfinished steps pending. This does not request approval and is not evidence of a verified outcome.', inputSchema: UpdatePlanSchema, executionMode: 'registry', safeMode: 'allow', readOnly: true, idempotent: true, handler: handleUpdatePlan },
  defineRegistryTool({ name: 'SubmitPlan', description: TOOL_DESCRIPTIONS.SubmitPlan, inputSchema: SubmitPlanSchema, executionMode: 'registry', safeMode: 'allow', handler: handleSubmitPlan }),
  defineRegistryTool({ name: 'config_validate', description: TOOL_DESCRIPTIONS.config_validate, inputSchema: ConfigValidateSchema, executionMode: 'registry', safeMode: 'allow', readOnly: true, idempotent: true, parallelSafe: true, handler: handleConfigValidate }),
  defineRegistryTool({ name: 'skill_validate', description: TOOL_DESCRIPTIONS.skill_validate, inputSchema: SkillValidateSchema, executionMode: 'registry', safeMode: 'allow', readOnly: true, idempotent: true, parallelSafe: true, handler: handleSkillValidate }),
  defineRegistryTool({ name: 'mermaid_validate', description: TOOL_DESCRIPTIONS.mermaid_validate, inputSchema: MermaidValidateSchema, executionMode: 'registry', safeMode: 'allow', readOnly: true, idempotent: true, parallelSafe: true, handler: handleMermaidValidate }),
  defineRegistryTool({ name: 'source_test', description: TOOL_DESCRIPTIONS.source_test, inputSchema: SourceTestSchema, executionMode: 'registry', safeMode: 'allow', handler: handleSourceTest }),
  defineRegistryTool({ name: 'source_oauth_trigger', description: TOOL_DESCRIPTIONS.source_oauth_trigger, inputSchema: SourceOAuthTriggerSchema, executionMode: 'registry', safeMode: 'block', handler: handleSourceOAuthTrigger }),
  defineRegistryTool({ name: 'source_google_oauth_trigger', description: TOOL_DESCRIPTIONS.source_google_oauth_trigger, inputSchema: SourceOAuthTriggerSchema, executionMode: 'registry', safeMode: 'block', handler: handleGoogleOAuthTrigger }),
  defineRegistryTool({ name: 'source_slack_oauth_trigger', description: TOOL_DESCRIPTIONS.source_slack_oauth_trigger, inputSchema: SourceOAuthTriggerSchema, executionMode: 'registry', safeMode: 'block', handler: handleSlackOAuthTrigger }),
  defineRegistryTool({ name: 'source_microsoft_oauth_trigger', description: TOOL_DESCRIPTIONS.source_microsoft_oauth_trigger, inputSchema: SourceOAuthTriggerSchema, executionMode: 'registry', safeMode: 'block', handler: handleMicrosoftOAuthTrigger }),
  defineRegistryTool({ name: 'source_credential_prompt', description: TOOL_DESCRIPTIONS.source_credential_prompt, inputSchema: CredentialPromptSchema, executionMode: 'registry', safeMode: 'block', handler: handleCredentialPrompt }),
  defineRegistryTool({ name: 'update_user_preferences', description: TOOL_DESCRIPTIONS.update_user_preferences, inputSchema: UpdatePreferencesSchema, executionMode: 'registry', safeMode: 'block', handler: handleUpdatePreferences }),
  defineRegistryTool({ name: 'transform_data', description: TOOL_DESCRIPTIONS.transform_data, inputSchema: TransformDataSchema, executionMode: 'registry', safeMode: 'allow', handler: handleTransformData }),
  defineRegistryTool({ name: 'script_sandbox', description: TOOL_DESCRIPTIONS.script_sandbox, inputSchema: ScriptSandboxSchema, executionMode: 'registry', safeMode: 'allow', handler: handleScriptSandbox }),
  defineRegistryTool({ name: 'render_template', description: TOOL_DESCRIPTIONS.render_template, inputSchema: RenderTemplateSchema, executionMode: 'registry', safeMode: 'allow', handler: handleRenderTemplate }),
  defineRegistryTool({ name: 'send_developer_feedback', description: TOOL_DESCRIPTIONS.send_developer_feedback, inputSchema: SendDeveloperFeedbackSchema, executionMode: 'registry', safeMode: 'allow', handler: handleSendDeveloperFeedback }),
  { name: 'call_llm', description: TOOL_DESCRIPTIONS.call_llm, inputSchema: CallLlmSchema, executionMode: 'backend', safeMode: 'allow', readOnly: true, idempotent: false, parallelSafe: true, handler: null },
  { name: 'spawn_session', description: TOOL_DESCRIPTIONS.spawn_session, inputSchema: SpawnSessionSchema, executionMode: 'backend', safeMode: 'block', handler: null },
  // Browser tool (backend-specific — requires BrowserPaneManager in Electron)
  // Single CLI-like tool that handles all browser actions via command string.
  { name: 'browser_tool', description: TOOL_DESCRIPTIONS.browser_tool, inputSchema: BrowserToolSchema, executionMode: 'backend', safeMode: 'allow', handler: null },
  // Session self-management tools (registry — use context callbacks to reach SessionManager)
  { name: 'request_user_input', description: 'Ask 1–3 concise questions when the user\'s answer would meaningfully refine the current work. Each question may offer up to 8 choices (multiSelect enables multiple choices); a free-text answer is always available. Use stable unique question and option IDs. This tool returns pending once the host registers the questions for display, without waiting for answers. Continue independent work while the user decides. Do not assume an answer, repeat the pending questions, or perform work that depends on an unanswered choice. An access, key, endpoint, or vendor response already established as pending from a named third party is not a missing user preference: finish independent safe work and report the exact external dependency instead of asking the user whether to wait. A substantive business alternative, such as replacing the blocked provider or integration, remains a valid short choice. You may end the turn while awaiting answers; do not claim a terminal objective result while input is pending. The response will be delivered into this same conversation and objective. This tool is for clarification, not permission to perform external actions or access credentials; it grants no permissions.', inputSchema: RequestUserInputSchema, executionMode: 'registry', safeMode: 'allow', handler: handleRequestUserInput },
  defineRegistryTool({ name: 'project_learning', description: 'Propose, list, validate or revoke a sourced project learning. Proposals are excluded from memory retrieval. Validate from a different session after independent replay and a call_llm JSON review receipt containing proposalId, contentSha256, sourceEvidenceSha256, verdict:PASS, findings:[], replayEvidenceIds:[actual toolUseIds]. Never store secrets or permissions; knowledge is historical data. Review is bound to the exact proposal and actual successful replay results.', inputSchema: ProjectLearningSchema, executionMode: 'registry', safeMode: 'block', handler: handleProjectLearning }),
  { name: 'set_completion_criteria', description: 'Register immutable observable success criteria for the current objective, preferably before acting. Each criteria item requires id, description, toolName, input and checks:[{path,equals}]. Selectors support only simple properties and nonnegative indexes: $.foo, $[0], or foo.0. Wildcards, filters, slices and expressions are rejected. Result checks may use $text for exact whole-output equality, ignoring only one final LF/CRLF terminator. Criteria using native or namespaced Bash, shell, exec_command or ssh_execute tools must use a read-only inspection, a named validate/verify/check/test script, a test/check command, or curl GET/HEAD; inline interpreter/eval/stdin programs and output-only commands are rejected before the immutable contract is stored. Equivalent selector syntax does not change the target, expected values or registered contract. Every criterion must cite a matching successful observation in the final outcome receipt. Prefer its toolUseId or messageId; an exact tool-name alias is accepted only when the host resolves it to one unique matching observation. Register known checks together. Repeating equivalent registration is idempotent. Never replace or re-register an already reviewed contract merely to cite alternate receipts or read-only observations; that changes its independent-review binding without changing the user requirement. Only an exact current negative observation permits the explicit next-version correction described below; the host archives its predecessor and changes the review binding. A matching successful observation from the current objective, or from its latest authenticated amendment, may be reused even when it preceded registration; a later relevant target mutation invalidates it. Adding checks strengthens the contract and changes the independent-review binding; this tool never authorizes actions. ' + SET_COMPLETION_CRITERIA_FORMAT_HELP, inputSchema: SetCompletionCriteriaSchema, executionMode: 'registry', safeMode: 'allow', handler: handleSetCompletionCriteria },
  defineRegistryTool({ name: 'set_session_labels', description: TOOL_DESCRIPTIONS.set_session_labels, inputSchema: SetSessionLabelsSchema, executionMode: 'registry', safeMode: 'block', handler: handleSetSessionLabels }),
  defineRegistryTool({ name: 'set_session_status', description: TOOL_DESCRIPTIONS.set_session_status, inputSchema: SetSessionStatusSchema, executionMode: 'registry', safeMode: 'block', handler: handleSetSessionStatus }),
  defineRegistryTool({ name: 'get_session_info', description: TOOL_DESCRIPTIONS.get_session_info, inputSchema: GetSessionInfoSchema, executionMode: 'registry', safeMode: 'allow', readOnly: true, idempotent: true, parallelSafe: true, handler: handleGetSessionInfo }),
  defineRegistryTool({ name: 'list_sessions', description: TOOL_DESCRIPTIONS.list_sessions, inputSchema: ListSessionsSchema, executionMode: 'registry', safeMode: 'allow', readOnly: true, idempotent: true, parallelSafe: true, handler: handleListSessions }),
  defineRegistryTool({ name: 'wait_sessions', description: TOOL_DESCRIPTIONS.wait_sessions, inputSchema: WaitSessionsSchema, executionMode: 'registry', safeMode: 'allow', readOnly: true, idempotent: false, handler: handleWaitSessions }),
  defineRegistryTool({ name: 'list_background_tasks', description: TOOL_DESCRIPTIONS.list_background_tasks, inputSchema: ListBackgroundTasksSchema, executionMode: 'registry', safeMode: 'allow', readOnly: true, idempotent: true, parallelSafe: true, handler: handleListBackgroundTasks }),
  // Inter-session messaging
  defineRegistryTool({ name: 'send_agent_message', description: TOOL_DESCRIPTIONS.send_agent_message, inputSchema: SendAgentMessageSchema, executionMode: 'registry', safeMode: 'block', handler: handleSendAgentMessage }),
  // Messaging gateway tools
  defineRegistryTool({ name: 'list_messaging_channels', description: TOOL_DESCRIPTIONS.list_messaging_channels, inputSchema: ListMessagingChannelsSchema, executionMode: 'registry', safeMode: 'allow', readOnly: true, idempotent: true, parallelSafe: true, handler: handleListMessagingChannels }),
  defineRegistryTool({ name: 'unbind_messaging_channel', description: TOOL_DESCRIPTIONS.unbind_messaging_channel, inputSchema: UnbindMessagingChannelSchema, executionMode: 'registry', safeMode: 'block', handler: handleUnbindMessagingChannel }),
];

export interface SessionToolFilterOptions {
  /** Include the experimental send_developer_feedback tool. */
  includeDeveloperFeedback?: boolean;
}

/**
 * Return session tools with optional feature filtering.
 *
 * Callers should use this helper instead of filtering ad hoc so tool visibility
 * stays consistent across Claude, Pi, and session-mcp-server backends.
 */
export function getSessionToolDefs(options?: SessionToolFilterOptions): SessionToolDef[] {
  const includeDeveloperFeedback = options?.includeDeveloperFeedback ?? true;

  return SESSION_TOOL_DEFS.filter(def => {
    if (!includeDeveloperFeedback && def.name === 'send_developer_feedback') {
      return false;
    }
    return true;
  });
}

/**
 * Build a name->definition registry with optional feature filtering.
 */
export function getSessionToolRegistry(options?: SessionToolFilterOptions): Map<string, SessionToolDef> {
  return new Map(getSessionToolDefs(options).map(def => [def.name, def]));
}

/**
 * Return session tool names with optional feature filtering.
 */
export function getSessionToolNames(options?: SessionToolFilterOptions): Set<string> {
  return new Set(getSessionToolDefs(options).map(def => def.name));
}

/**
 * Return backend-executed tool names with optional feature filtering.
 */
export function getSessionBackendToolNames(options?: SessionToolFilterOptions): Set<string> {
  return new Set(getSessionToolDefs(options).filter(d => d.executionMode === 'backend').map(d => d.name));
}

/**
 * Return registry-executed tool names with optional feature filtering.
 */
export function getSessionRegistryToolNames(options?: SessionToolFilterOptions): Set<string> {
  return new Set(getSessionToolDefs(options).filter(d => d.executionMode === 'registry').map(d => d.name));
}

export interface SessionToolNameOptions extends SessionToolFilterOptions {
  /** Optional name prefix for consumers (e.g. 'mcp__session__'). */
  prefix?: string;
}

/**
 * Return session tool names that are allowed in Explore/Safe mode.
 */
export function getSessionSafeAllowedToolNames(options?: SessionToolNameOptions): Set<string> {
  const prefix = options?.prefix ?? '';
  return new Set(
    getSessionToolDefs(options)
      .filter(def => def.safeMode === 'allow')
      .map(def => `${prefix}${def.name}`)
  );
}

/**
 * Return session tool names that are blocked in Explore/Safe mode.
 */
export function getSessionSafeBlockedToolNames(options?: SessionToolNameOptions): Set<string> {
  const prefix = options?.prefix ?? '';
  return new Set(
    getSessionToolDefs(options)
      .filter(def => def.safeMode === 'block')
      .map(def => `${prefix}${def.name}`)
  );
}

// ============================================================
// Derived Lookups
// ============================================================

/** Set of session tool names for quick membership checks. */
export const SESSION_TOOL_NAMES = new Set(SESSION_TOOL_DEFS.map(d => d.name));

/** Session tool names that must be handled by backend-specific adapters (Pi/Claude/session-mcp-server). */
export const SESSION_BACKEND_TOOL_NAMES = new Set(
  SESSION_TOOL_DEFS.filter(d => d.executionMode === 'backend').map(d => d.name)
);

/** Session tool names that are always executable from the canonical registry. */
export const SESSION_REGISTRY_TOOL_NAMES = new Set(
  SESSION_TOOL_DEFS.filter(d => d.executionMode === 'registry').map(d => d.name)
);

/** Session tool names allowed in Explore/Safe mode (unfiltered canonical set). */
export const SESSION_SAFE_ALLOWED_TOOL_NAMES = new Set(
  SESSION_TOOL_DEFS.filter(d => d.safeMode === 'allow').map(d => d.name)
);

/** Session tool names blocked in Explore/Safe mode (unfiltered canonical set). */
export const SESSION_SAFE_BLOCKED_TOOL_NAMES = new Set(
  SESSION_TOOL_DEFS.filter(d => d.safeMode === 'block').map(d => d.name)
);

/** Map from tool name → definition for O(1) lookup. */
export const SESSION_TOOL_REGISTRY = new Map(SESSION_TOOL_DEFS.map(d => [d.name, d]));
