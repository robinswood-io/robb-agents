/**
 * Typed errors for better error handling and user-friendly messages.
 *
 * These error types map HTTP status codes and error patterns to
 * actionable error information that can be displayed to users.
 *
 * The `ErrorCode` union is owned by `@craft-agent/core` so the wire
 * format (which crosses package boundaries) stays in one place; this
 * file owns the user-facing text and recovery actions for each code.
 */
import type { ErrorCode } from "@craft-agent/core/types";

/** Provider info attached to errors for user-facing context */
export interface ProviderInfo {
  name: string;
  statusPageUrl?: string;
  dashboardUrl?: string;
}

export interface RecoveryAction {
  /** Keyboard shortcut (single letter) */
  key: string;
  /** Description of the action */
  label: string;
  /** Slash command to execute (e.g., '/settings') */
  command?: string;
  /** Custom action type for special handling */
  action?: 'retry' | 'settings' | 'reauth' | 'open_url' | 'reconnect_source' | 'reconnect_runtime';
  /** URL to open (for 'open_url' action) */
  url?: string;
  /** Source slug (for 'reconnect_source' action) */
  sourceSlug?: string;
}

export interface AgentError {
  /** Error code for programmatic handling */
  code: ErrorCode;
  /** User-friendly title */
  title: string;
  /** Detailed message explaining what went wrong */
  message: string;
  /** Suggested recovery actions */
  actions: RecoveryAction[];
  /** Whether auto-retry is possible */
  canRetry: boolean;
  /** Retry delay in ms (if canRetry is true) */
  retryDelayMs?: number;
  /** Original error message for debugging */
  originalError?: string;
  /** Diagnostic check results for debugging */
  details?: string[];
  /** Provider info for user-facing context */
  providerInfo?: ProviderInfo;
}

/**
 * Error definitions with user-friendly messages and recovery actions
 */
export const ERROR_DEFINITIONS: Record<ErrorCode, Omit<AgentError, 'code' | 'originalError' | 'details'>> = {
  objective_validation_failed: {
    title: 'Completion could not be verified',
    message: 'The completion contract could not be validated. Completed work and tool receipts were preserved; inspect the validation gaps before retrying.',
    actions: [],
    canRetry: true,
  },
  invalid_api_key: {
    title: 'Invalid API Key',
    message: 'Your API key was rejected. It may be invalid or expired.',
    actions: [
      { key: 's', label: 'Update API key', command: '/settings', action: 'settings' },
    ],
    canRetry: false,
  },
  invalid_credentials: {
    title: 'Invalid Credentials',
    message: 'Your API key or OAuth token is missing or invalid.',
    actions: [
      { key: 's', label: 'Update credentials', command: '/settings', action: 'settings' },
    ],
    canRetry: false,
  },
  // response_too_large is set by the UI tool-result handler; parseError
  // never produces it, but the union requires a definition entry.
  response_too_large: {
    title: 'Response Too Large',
    message: 'The tool response was too large to display inline. The full output has been saved to disk.',
    actions: [],
    canRetry: false,
  },
  expired_oauth_token: {
    title: 'Session Expired',
    message: 'Your session has expired. Please try signing in again.',
    actions: [
      { key: 'r', label: 'Re-authenticate', action: 'reauth' },
      { key: 's', label: 'Switch API setup', command: '/settings', action: 'settings' },
    ],
    canRetry: false,
  },
  token_expired: {
    title: 'Workspace Session Expired',
    message: 'Your workspace authentication has expired. Please re-authenticate the workspace.',
    actions: [
      { key: 'w', label: 'Open workspace menu', command: '/workspace' },
    ],
    canRetry: false,
  },
  rate_limited: {
    title: 'Rate Limited',
    message: 'Rate limit reached. Will auto-retry shortly.',
    actions: [
      { key: 'r', label: 'Retry', action: 'retry' },
    ],
    canRetry: true,
    retryDelayMs: 5000,
  },
  service_error: {
    title: 'Service Error',
    message: 'The AI service is temporarily unavailable. This usually resolves on its own.',
    actions: [
      { key: 'r', label: 'Retry', action: 'retry' },
    ],
    canRetry: true,
    retryDelayMs: 2000,
  },
  service_unavailable: {
    title: 'Service Unavailable',
    message: 'The AI service is experiencing issues. All credentials appear valid. Try again in a moment.',
    actions: [
      { key: 'r', label: 'Retry', action: 'retry' },
    ],
    canRetry: true,
    retryDelayMs: 2000,
  },
  network_error: {
    title: 'Connection Error',
    message: 'Could not reach the AI service. Check your internet connection or VPN settings.',
    actions: [
      { key: 'r', label: 'Retry', action: 'retry' },
    ],
    canRetry: true,
    retryDelayMs: 1000,
  },
  proxy_error: {
    title: 'Network Proxy Error',
    message: 'A proxy, firewall, or captive portal intercepted the API request and returned an HTML page instead of the expected response.',
    actions: [
      { key: 'r', label: 'Retry', action: 'retry' },
      { key: 's', label: 'Check proxy settings', command: '/settings', action: 'settings' },
    ],
    canRetry: true,
    retryDelayMs: 2000,
  },
  mcp_auth_required: {
    title: 'Workspace Authentication Required',
    message: 'Your workspace connection needs to be re-authenticated.',
    actions: [
      { key: 'w', label: 'Open workspace menu', command: '/workspace' },
    ],
    canRetry: false,
  },
  mcp_unreachable: {
    title: 'MCP Server Unreachable',
    message: 'Cannot connect to the Craft MCP server. Check your network connection.',
    actions: [
      { key: 'r', label: 'Retry', action: 'retry' },
    ],
    canRetry: true,
    retryDelayMs: 2000,
  },
  billing_error: {
    title: 'Payment Required',
    message: 'Your account has a billing issue. Check your provider account status.',
    actions: [
      { key: 's', label: 'Update credentials', command: '/settings', action: 'settings' },
    ],
    canRetry: false,
  },
  model_no_tool_support: {
    title: 'Model Does Not Support Tools',
    message: 'The selected model does not support tool/function calling, which is required for Robb Agents. Please choose a model with tool support (e.g., Claude, GPT-4, Gemini).',
    actions: [
      { key: 's', label: 'Change model', command: '/settings', action: 'settings' },
    ],
    canRetry: false,
  },
  invalid_model: {
    title: 'Invalid Model',
    message: 'The selected model was not found. Please check your model configuration in settings.',
    actions: [
      { key: 's', label: 'Change model', command: '/settings', action: 'settings' },
    ],
    canRetry: false,
  },
  data_policy_error: {
    title: 'Data Policy Restriction',
    message: 'OpenRouter blocked this request due to your data policy settings. Configure your privacy settings at openrouter.ai/settings/privacy to allow this model.',
    actions: [
      { key: 's', label: 'Open Settings', command: '/settings', action: 'settings' },
    ],
    canRetry: false,
  },
  invalid_request: {
    title: 'Invalid Request',
    message: 'The API rejected this request.',
    actions: [
      { key: 'r', label: 'Retry', action: 'retry' },
    ],
    canRetry: true,
  },
  image_too_large: {
    title: 'Image Too Large',
    message: 'The image exceeds API limits (max 8000px or 5MB). Please resize or use a smaller image.',
    actions: [],
    canRetry: false,
  },
  provider_error: {
    title: 'AI Provider Error',
    message: 'The AI provider is experiencing issues. This usually resolves on its own — retry in a moment.',
    actions: [
      { key: 'r', label: 'Retry', action: 'retry' },
    ],
    canRetry: true,
    retryDelayMs: 5000,
  },
  queued_message_replay_failed: {
    title: 'Queued message could not be sent',
    message: 'A message you sent while the agent was running could not be re-sent automatically. Tap retry to send it now.',
    actions: [
      { key: 'r', label: 'Retry', action: 'retry' },
    ],
    canRetry: true,
  },
  sdk_binary_missing: {
    title: 'Claude Code binary missing from app bundle',
    message:
      'The Claude Agent SDK binary expected on disk is not present. ' +
      'This usually means the app bundle is incomplete (interrupted download, partial update, ' +
      'or a security tool removed it). Reinstalling Robb Agents typically fixes this.',
    actions: [
      { key: 'r', label: 'Retry', action: 'retry' },
    ],
    canRetry: true,
    retryDelayMs: 1000,
  },
  sdk_cwd_missing: {
    title: 'Branch source unavailable on this machine',
    message:
      "The folder this branched session was forked from doesn't exist on this machine. " +
      'This typically happens after importing a session from another workspace. ' +
      'Retrying will start a fresh fork from a summary of the parent conversation.',
    actions: [
      { key: 'r', label: 'Retry', action: 'retry' },
    ],
    canRetry: true,
    retryDelayMs: 1000,
  },
  execution_bridge_unavailable: {
    title: 'Execution bridge unavailable',
    message:
      'The local runtime bridge used to execute tools is unavailable or out of sync. ' +
      'Reconnect the runtime, then retry. If reconnecting fails, prepare a structured handoff before starting a new task.',
    actions: [
      { key: 'c', label: 'Reconnect runtime', action: 'reconnect_runtime' },
      { key: 'r', label: 'Retry', action: 'retry' },
    ],
    canRetry: true,
    retryDelayMs: 1000,
  },
  unknown_error: {
    title: 'Error',
    message: 'Something went wrong. If this persists, check the provider status page or retry.',
    actions: [
      { key: 'r', label: 'Retry', action: 'retry' },
    ],
    canRetry: true,
  },
};
