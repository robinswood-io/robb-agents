/**
 * Exhaustive channel routing table for hybrid local/remote transport.
 *
 * Every RPC channel must belong to exactly one of two sets:
 * - LOCAL_ONLY: Always runs on the local Electron server, never proxied.
 * - REMOTE_ELIGIBLE: Runs on whichever server owns the workspace.
 *
 * An exhaustiveness test ensures new channels fail CI until classified.
 */
import { RPC_CHANNELS } from "../channels";

// ---------------------------------------------------------------------------
// REMOTE_ELIGIBLE — runs on whichever server owns the workspace
// ---------------------------------------------------------------------------

export const REMOTE_ELIGIBLE_CHANNELS = new Set<string>([
  // server — server-level operations (no workspace context needed)
  RPC_CHANNELS.server.GET_WORKSPACES,
  RPC_CHANNELS.server.CREATE_WORKSPACE,
  RPC_CHANNELS.server.GET_STATUS,
  RPC_CHANNELS.server.GET_HEALTH,
  RPC_CHANNELS.server.GET_ACTIVE_SESSIONS,
  RPC_CHANNELS.server.SHUTTING_DOWN,
  RPC_CHANNELS.server.STATUS_CHANGED,
  RPC_CHANNELS.server.HOME_DIR,

  // sessions — core session runtime
  RPC_CHANNELS.sessions.GET,
  RPC_CHANNELS.sessions.GET_UNREAD_SUMMARY,
  RPC_CHANNELS.sessions.MARK_ALL_READ,
  RPC_CHANNELS.sessions.UNREAD_SUMMARY_CHANGED,
  RPC_CHANNELS.sessions.CREATE,
  RPC_CHANNELS.sessions.DELETE,
  RPC_CHANNELS.sessions.GET_MESSAGES,
  RPC_CHANNELS.sessions.SEND_MESSAGE,
  RPC_CHANNELS.sessions.CANCEL,
  RPC_CHANNELS.sessions.KILL_SHELL,
  RPC_CHANNELS.sessions.RESPOND_TO_PERMISSION,
  RPC_CHANNELS.sessions.RESPOND_TO_CREDENTIAL,
  RPC_CHANNELS.sessions.RESPOND_TO_USER_INPUT,
  RPC_CHANNELS.sessions.COMMAND,
  RPC_CHANNELS.sessions.GET_PENDING_PLAN_EXECUTION,
  RPC_CHANNELS.sessions.GET_PERMISSION_MODE_STATE,
  RPC_CHANNELS.sessions.EVENT,
  RPC_CHANNELS.sessions.GET_MODEL,
  RPC_CHANNELS.sessions.SET_MODEL,
  RPC_CHANNELS.sessions.GET_FILES,
  RPC_CHANNELS.sessions.GET_NOTES,
  RPC_CHANNELS.sessions.SET_NOTES,
  RPC_CHANNELS.sessions.WATCH_FILES,
  RPC_CHANNELS.sessions.UNWATCH_FILES,
  RPC_CHANNELS.sessions.FILES_CHANGED,
  RPC_CHANNELS.sessions.SEARCH_CONTENT,
  RPC_CHANNELS.sessions.EXPORT,
  RPC_CHANNELS.sessions.IMPORT,
  RPC_CHANNELS.sessions.EXPORT_REMOTE_TRANSFER,
  RPC_CHANNELS.sessions.IMPORT_REMOTE_TRANSFER,

  // transfer — chunked large-payload import (sessions, resources)
  RPC_CHANNELS.transfer.START,
  RPC_CHANNELS.transfer.CHUNK,
  RPC_CHANNELS.transfer.COMMIT,
  RPC_CHANNELS.transfer.ABORT,

  // tasks — workspace content (Conductor DAG runs on the workspace server)
  RPC_CHANNELS.tasks.GET_OUTPUT,
  RPC_CHANNELS.tasks.VALIDATE,
  RPC_CHANNELS.tasks.CREATE,
  RPC_CHANNELS.tasks.GENERATE,
  RPC_CHANNELS.tasks.GENERATED,
  RPC_CHANNELS.tasks.RUN,
  RPC_CHANNELS.tasks.PAUSE,
  RPC_CHANNELS.tasks.RESUME,
  RPC_CHANNELS.tasks.STOP,
  RPC_CHANNELS.tasks.REPAIR,
  RPC_CHANNELS.tasks.LIST_APPROVALS,
  RPC_CHANNELS.tasks.RESOLVE_APPROVAL,
  RPC_CHANNELS.tasks.GET_KILL_SWITCHES,
  RPC_CHANNELS.tasks.SET_KILL_SWITCH,
  RPC_CHANNELS.tasks.GET,
  RPC_CHANNELS.tasks.LIST,
  RPC_CHANNELS.tasks.LIST_DURABLE,
  RPC_CHANNELS.tasks.UPDATE_METADATA,
  RPC_CHANNELS.tasks.GET_COCKPIT_PROJECTIONS,
  RPC_CHANNELS.tasks.GET_RESULTS,

  // missions v2 — durable autonomous mission control on the workspace server
  RPC_CHANNELS.missions.PLAN,
  RPC_CHANNELS.missions.GET_PLAN,
  RPC_CHANNELS.missions.PLANNED,
  RPC_CHANNELS.missions.CREATE_AND_START,
  RPC_CHANNELS.missions.PREFLIGHT,
  RPC_CHANNELS.missions.PREVIEW_REPLAN,
  RPC_CHANNELS.missions.REPLAN,
  RPC_CHANNELS.missions.GET,
  RPC_CHANNELS.missions.LIST,
  RPC_CHANNELS.missions.LIST_CONNECTOR_APPROVALS,
  RPC_CHANNELS.missions.RESOLVE_CONNECTOR_APPROVAL,
  RPC_CHANNELS.missions.REFRESH_CONNECTOR_APPROVAL,
  RPC_CHANNELS.missions.GET_PASSPORT,
  RPC_CHANNELS.missions.GET_PASSPORT_TRUST_ANCHOR,
  RPC_CHANNELS.missions.VERIFY_PASSPORT,
  RPC_CHANNELS.missions.PAUSE,
  RPC_CHANNELS.missions.RESUME,
  RPC_CHANNELS.missions.CANCEL,
  RPC_CHANNELS.missions.CHANGED,

  RPC_CHANNELS.operations.GET_STATUS,
  RPC_CHANNELS.operations.UPDATE_SETTINGS,
  RPC_CHANNELS.operations.RESOLVE_APPROVAL,

  // file — workspace files (not openDialog which is native)
  RPC_CHANNELS.file.READ,
  RPC_CHANNELS.file.READ_DATA_URL,
  RPC_CHANNELS.file.READ_PREVIEW_DATA_URL,
  RPC_CHANNELS.file.READ_BINARY,
  RPC_CHANNELS.file.READ_ATTACHMENT,
  RPC_CHANNELS.file.STORE_ATTACHMENT,
  RPC_CHANNELS.file.GENERATE_THUMBNAIL,

  // fs — workspace filesystem
  RPC_CHANNELS.fs.SEARCH,
  RPC_CHANNELS.fs.LIST_DIRECTORY,

  // credentials — remote server's credential state
  RPC_CHANNELS.credentials.HEALTH_CHECK,

  // llmConnections — LLM config lives on server running workspace
  RPC_CHANNELS.llmConnections.LIST,
  RPC_CHANNELS.llmConnections.LIST_WITH_STATUS,
  RPC_CHANNELS.llmConnections.GET,
  RPC_CHANNELS.llmConnections.GET_API_KEY,
  RPC_CHANNELS.llmConnections.SAVE,
  RPC_CHANNELS.llmConnections.DELETE,
  RPC_CHANNELS.llmConnections.TEST,
  RPC_CHANNELS.llmConnections.SET_DEFAULT,
  RPC_CHANNELS.llmConnections.SET_WORKSPACE_DEFAULT,
  RPC_CHANNELS.llmConnections.REFRESH_MODELS,
  RPC_CHANNELS.llmConnections.CHANGED,

  // chatgpt — OAuth via capability passthrough
  RPC_CHANNELS.chatgpt.START_OAUTH,
  RPC_CHANNELS.chatgpt.COMPLETE_OAUTH,
  RPC_CHANNELS.chatgpt.CANCEL_OAUTH,
  RPC_CHANNELS.chatgpt.GET_AUTH_STATUS,
  RPC_CHANNELS.chatgpt.LOGOUT,

  // copilot — OAuth via capability passthrough
  RPC_CHANNELS.copilot.START_OAUTH,
  RPC_CHANNELS.copilot.CANCEL_OAUTH,
  RPC_CHANNELS.copilot.GET_AUTH_STATUS,
  RPC_CHANNELS.copilot.LOGOUT,
  RPC_CHANNELS.copilot.DEVICE_CODE,

  // Claude OAuth — runs on workspace server so credentials and connection config
  // end up on the same server that will use them. Browser opening is client-side.
  // (ChatGPT OAuth stays LOCAL_ONLY — requires localhost callback server.)
  RPC_CHANNELS.onboarding.START_CLAUDE_OAUTH,
  RPC_CHANNELS.onboarding.EXCHANGE_CLAUDE_CODE,
  RPC_CHANNELS.onboarding.HAS_CLAUDE_OAUTH_STATE,
  RPC_CHANNELS.onboarding.CLEAR_CLAUDE_OAUTH_STATE,

  // settings — workspace-level settings
  RPC_CHANNELS.settings.SETUP_LLM_CONNECTION,
  RPC_CHANNELS.settings.TEST_LLM_CONNECTION_SETUP,
  RPC_CHANNELS.settings.GET_DEFAULT_THINKING_LEVEL,
  RPC_CHANNELS.settings.SET_DEFAULT_THINKING_LEVEL,

  // pi — provider config on workspace server
  RPC_CHANNELS.pi.GET_API_KEY_PROVIDERS,
  RPC_CHANNELS.pi.GET_PROVIDER_BASE_URL,
  RPC_CHANNELS.pi.GET_PROVIDER_MODELS,

  // preferences — workspace-level preferences
  RPC_CHANNELS.preferences.READ,
  RPC_CHANNELS.preferences.WRITE,

  // drafts — workspace content
  RPC_CHANNELS.drafts.GET,
  RPC_CHANNELS.drafts.SET,
  RPC_CHANNELS.drafts.DELETE,
  RPC_CHANNELS.drafts.GET_ALL,

  // sources — source config per-workspace
  RPC_CHANNELS.sources.GET,
  RPC_CHANNELS.sources.CREATE,
  RPC_CHANNELS.sources.UPDATE_CONFIG,
  RPC_CHANNELS.sources.DELETE,
  RPC_CHANNELS.sources.START_OAUTH,
  RPC_CHANNELS.sources.SAVE_CREDENTIALS,
  RPC_CHANNELS.sources.CHANGED,
  RPC_CHANNELS.sources.GET_PERMISSIONS,
  RPC_CHANNELS.sources.GET_MCP_TOOLS,

  // oauth — OAuth state management
  RPC_CHANNELS.oauth.START,
  RPC_CHANNELS.oauth.COMPLETE,
  RPC_CHANNELS.oauth.CANCEL,
  RPC_CHANNELS.oauth.REVOKE,

  // workspace — workspace config + images (sharp on headless)
  RPC_CHANNELS.workspace.GET_PERMISSIONS,
  RPC_CHANNELS.workspace.READ_IMAGE,
  RPC_CHANNELS.workspace.WRITE_IMAGE,
  RPC_CHANNELS.workspace.SETTINGS_GET,
  RPC_CHANNELS.workspace.SETTINGS_UPDATE,
  RPC_CHANNELS.workspace.GOVERNANCE_UPDATE,
  RPC_CHANNELS.workspace.REMOTE_SUPERVISION_GRANT,
  RPC_CHANNELS.workspace.REMOTE_SUPERVISION_REVOKE,

  // permissions — workspace permissions
  RPC_CHANNELS.permissions.GET_DEFAULTS,
  RPC_CHANNELS.permissions.DEFAULTS_CHANGED,

  // skills — skill content per-workspace (not openEditor/openFinder which are local OS)
  RPC_CHANNELS.skills.GET,
  RPC_CHANNELS.skills.GET_FILES,
  RPC_CHANNELS.skills.DELETE,
  RPC_CHANNELS.skills.CHANGED,

  // statuses — workspace metadata
  RPC_CHANNELS.statuses.LIST,
  RPC_CHANNELS.statuses.REORDER,
  RPC_CHANNELS.statuses.CHANGED,

  // labels — workspace metadata
  RPC_CHANNELS.labels.LIST,
  RPC_CHANNELS.labels.CREATE,
  RPC_CHANNELS.labels.DELETE,
  RPC_CHANNELS.labels.CHANGED,

  // views — workspace UI views
  RPC_CHANNELS.views.LIST,
  RPC_CHANNELS.views.SAVE,

  // toolIcons — workspace config
  RPC_CHANNELS.toolIcons.GET_MAPPINGS,

  // logo — workspace config
  RPC_CHANNELS.logo.GET_URL,

  // automations — workspace automations
  RPC_CHANNELS.automations.GET,
  RPC_CHANNELS.automations.TEST,
  RPC_CHANNELS.automations.SET_ENABLED,
  RPC_CHANNELS.automations.DUPLICATE,
  RPC_CHANNELS.automations.DELETE,
  RPC_CHANNELS.automations.GET_HISTORY,
  RPC_CHANNELS.automations.GET_LAST_EXECUTED,
  RPC_CHANNELS.automations.REPLAY,
  RPC_CHANNELS.automations.CHANGED,

  // projects — workspace projects
  RPC_CHANNELS.projects.GET,
  RPC_CHANNELS.projects.GET_ONE,
  RPC_CHANNELS.projects.CREATE,
  RPC_CHANNELS.projects.UPDATE,
  RPC_CHANNELS.projects.DELETE,
  RPC_CHANNELS.projects.LIST_ASSETS,
  RPC_CHANNELS.projects.UPLOAD_ASSET,
  RPC_CHANNELS.projects.DELETE_ASSET,
  RPC_CHANNELS.projects.CHANGED,

  // git — workspace filesystem
  RPC_CHANNELS.git.GET_BRANCH,

  // resources — workspace resource export/import
  RPC_CHANNELS.resources.EXPORT,
  RPC_CHANNELS.resources.IMPORT,

  // messaging — gateway channels run on workspace server
  RPC_CHANNELS.messaging.WA_REGISTER,
  RPC_CHANNELS.messaging.WA_INCOMING,
  RPC_CHANNELS.messaging.WA_BUTTON_PRESS,
  RPC_CHANNELS.messaging.WA_STATUS,
  RPC_CHANNELS.messaging.WA_QR,
  RPC_CHANNELS.messaging.WA_SEND,
  RPC_CHANNELS.messaging.WA_SEND_BUTTONS,
  RPC_CHANNELS.messaging.WA_SEND_TYPING,
  RPC_CHANNELS.messaging.WA_SEND_FILE,
  RPC_CHANNELS.messaging.WA_CONNECT,
  RPC_CHANNELS.messaging.WA_DISCONNECT,
  RPC_CHANNELS.messaging.BINDING_CHANGED,
  RPC_CHANNELS.messaging.PLATFORM_STATUS,
  RPC_CHANNELS.messaging.PENDING_CHANGED,
  RPC_CHANNELS.messaging.GET_CONFIG,
  RPC_CHANNELS.messaging.UPDATE_CONFIG,
  RPC_CHANNELS.messaging.TEST_TELEGRAM,
  RPC_CHANNELS.messaging.SAVE_TELEGRAM,
  RPC_CHANNELS.messaging.TEST_LARK,
  RPC_CHANNELS.messaging.SAVE_LARK,
  RPC_CHANNELS.messaging.DISCONNECT,
  RPC_CHANNELS.messaging.FORGET,
  RPC_CHANNELS.messaging.GET_BINDINGS,
  RPC_CHANNELS.messaging.GENERATE_CODE,
  RPC_CHANNELS.messaging.GENERATE_SUPERGROUP_CODE,
  RPC_CHANNELS.messaging.GET_SUPERGROUP,
  RPC_CHANNELS.messaging.UNBIND_SUPERGROUP,
  RPC_CHANNELS.messaging.UNBIND,
  RPC_CHANNELS.messaging.UNBIND_BINDING,
  RPC_CHANNELS.messaging.WA_START_CONNECT,
  RPC_CHANNELS.messaging.WA_SUBMIT_PHONE,
  RPC_CHANNELS.messaging.WA_UI_EVENT,
  // messaging access control — UI ↔ Server, per-platform owners + per-binding allow-list
  RPC_CHANNELS.messaging.GET_PLATFORM_OWNERS,
  RPC_CHANNELS.messaging.SET_PLATFORM_OWNERS,
  RPC_CHANNELS.messaging.GET_PLATFORM_ACCESS_MODE,
  RPC_CHANNELS.messaging.SET_PLATFORM_ACCESS_MODE,
  RPC_CHANNELS.messaging.GET_PENDING_SENDERS,
  RPC_CHANNELS.messaging.DISMISS_PENDING_SENDER,
  RPC_CHANNELS.messaging.ALLOW_PENDING_SENDER,
  RPC_CHANNELS.messaging.SET_BINDING_ACCESS,
])

export function isRemoteEligible(channel: string): boolean {
  return REMOTE_ELIGIBLE_CHANNELS.has(channel)
}
