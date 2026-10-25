/** Existing behavior separated into direct modules by responsibility, preserving the public entry point. */
export type { CompletedChatMemory, CompletedChatArchiveIntent, CompletedChatArchiveReconciliation } from './completed-chat-retention/contracts.ts';
export { COMPLETED_CHAT_RETENTION_MS, CompletedChatArchiveError } from './completed-chat-retention/contracts.ts';
export { canInjectCompletedChatContext, completedChatContext } from './completed-chat-retention/context-retrieval.ts';
export { readCompletedChatMemory, writeCompletedChatMemory } from './completed-chat-retention/memory.ts';
export { prepareCompletedChatArchive, abandonCompletedChatArchive, finalizeCompletedChatArchive, reconcileCompletedChatArchives, captureCompletedChatMemory, reopenCompletedChat, isCompletedChatDue, archiveCompletedChatDirectory, hasProtectedChatWorktree } from './completed-chat-retention/archive.ts';
