/** Messaging adapter, binding and access configuration contracts. */
export type { PlatformType, MessagingLogContext, MessagingLogMeta, MessagingLogger, MessagingPlatformRuntimeState, MessagingPlatformRuntimeInfo, AdapterCapabilities, IncomingMessage, IncomingAttachment, SentMessage, InlineButton, ButtonPress, SendOptions, PlatformConfig, PlatformAdapter } from './types/platform.ts';
export type { ResponseMode, BindingAccessMode, BindingConfig, ChannelBinding } from './types/bindings.ts';
export { DEFAULT_BINDING_CONFIG, getDefaultBindingConfig, normalizeBindingConfig } from './types/bindings.ts';
export type { TelegramSupergroupConfig, PlatformAccessMode, PlatformOwner, PendingRejectReason, PendingSender, MessagingConfig } from './types/access-config.ts';
export { DEFAULT_MESSAGING_CONFIG } from './types/access-config.ts';
