/** Stable messaging RPC channel names. */
export const MESSAGING_CHANNELS = {
  // WhatsApp subprocess → Gateway (subprocess invokes on server)
  WA_REGISTER: 'messaging:wa:register',
  WA_INCOMING: 'messaging:wa:incoming',
  WA_BUTTON_PRESS: 'messaging:wa:buttonPress',
  WA_STATUS: 'messaging:wa:status',
  WA_QR: 'messaging:wa:qr',
  // Gateway → WhatsApp subprocess (server invokes on client)
  WA_SEND: 'messaging:wa:send',
  WA_SEND_BUTTONS: 'messaging:wa:sendButtons',
  WA_SEND_TYPING: 'messaging:wa:sendTyping',
  WA_SEND_FILE: 'messaging:wa:sendFile',
  WA_CONNECT: 'messaging:wa:connect',
  WA_DISCONNECT: 'messaging:wa:disconnect',
  // Gateway → UI clients (broadcast)
  BINDING_CHANGED: 'messaging:bindingChanged',
  PLATFORM_STATUS: 'messaging:platformStatus',
  /** Broadcast when the workspace's pending-senders list mutates. */
  PENDING_CHANGED: 'messaging:pendingChanged',
  // UI ↔ Server (config/binding CRUD)
  GET_CONFIG: 'messaging:getConfig',
  UPDATE_CONFIG: 'messaging:updateConfig',
  TEST_TELEGRAM: 'messaging:testTelegram',
  SAVE_TELEGRAM: 'messaging:saveTelegram',
  TEST_LARK: 'messaging:testLark',
  SAVE_LARK: 'messaging:saveLark',
  DISCONNECT: 'messaging:disconnect',
  FORGET: 'messaging:forget',
  GET_BINDINGS: 'messaging:getBindings',
  GENERATE_CODE: 'messaging:generateCode',
  UNBIND: 'messaging:unbind',
  UNBIND_BINDING: 'messaging:unbindBinding',
  /** Workspace-supergroup pairing (Telegram forum support). UI ↔ Server. */
  GENERATE_SUPERGROUP_CODE: 'messaging:generateSupergroupCode',
  GET_SUPERGROUP: 'messaging:getSupergroup',
  UNBIND_SUPERGROUP: 'messaging:unbindSupergroup',
  // UI ↔ Server — WhatsApp pairing/connection flow (Baileys subprocess adapter)
  WA_START_CONNECT: 'messaging:wa:startConnect',
  WA_SUBMIT_PHONE: 'messaging:wa:submitPhone',
  /** Broadcast to UI clients: QR string, pairing code, status, unavailable, error. */
  WA_UI_EVENT: 'messaging:wa:uiEvent',
  // UI ↔ Server — Access control (per-platform owners + per-binding allow-list)
  GET_PLATFORM_OWNERS: 'messaging:access:getOwners',
  SET_PLATFORM_OWNERS: 'messaging:access:setOwners',
  GET_PLATFORM_ACCESS_MODE: 'messaging:access:getMode',
  SET_PLATFORM_ACCESS_MODE: 'messaging:access:setMode',
  GET_PENDING_SENDERS: 'messaging:access:getPending',
  DISMISS_PENDING_SENDER: 'messaging:access:dismissPending',
  ALLOW_PENDING_SENDER: 'messaging:access:allowPending',
  SET_BINDING_ACCESS: 'messaging:access:setBindingAccess',
} as const
