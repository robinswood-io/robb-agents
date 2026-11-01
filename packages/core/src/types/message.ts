/** Message contracts: content, annotations, routing, persistence, errors and agent events. */
export type { MessageRole, CredentialInputMode, AuthRequestType, AuthStatus, ToolStatus, ToolExecutionCheckpoint, ObjectiveOutcomeState, ObjectiveOutcomeBlockerKind, ObjectiveOutcomeDeclaration, ToolDisplayMeta, TokenUsage, RecoveryAction, ErrorCode, TypedError, PermissionRequestType, PermissionRequest, InternalMessageOrigin } from './message/message-types.ts';
export { generateMessageId } from './message/message-types.ts';
export type { AttachmentType, MessageAttachment, ContentBadge, AnnotationAuthor, AnnotationBody, AnnotationIntent, AnnotationStatus, AnnotationBlockType, AnnotationSelector, AnnotationTarget, AnnotationV1, StoredAttachment } from './message/content-types.ts';
export type { RoutingCostSource, RoutingCostProvenance, RoutingMeta } from './message/routing.ts';
export type { Message, StoredMessage, ProviderDispatchWriteAhead } from './message/message-store.ts';
export type { AgentEventUsage, AgentModelProvenance, AgentEvent } from './message/agent-events.ts';
export { AGENT_RUNTIME_ACTIVITY, isAgentRuntimeActivity } from './message/agent-events.ts';
