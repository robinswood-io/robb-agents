import type { AppShellContextType } from '@/context/AppShellContext';
import type { Session } from "../../../../shared/types";
import type { Message } from "@craft-agent/core/types";
import { type EditContext } from "../../../components/ui/EditPopover";
import { ensureMockElectronAPI } from "../../mock-utils";

// Ensure mock electronAPI is available before any component renders
ensureMockElectronAPI()

// ============================================================================
// Sample Message Data
// ============================================================================

const createMessage = (
  id: string,
  role: 'user' | 'assistant',
  content: string,
  isIntermediate = false
): Message => ({
  id,
  role: role,
  content,
  isIntermediate,
  timestamp: Date.now(),
})

// Empty session - initial state before any messages
export const emptyMessages: Message[] = []

// User just sent a message
export const userMessageOnly: Message[] = [
  createMessage('msg-1', 'user', 'Add a "Blocked" status with orange color'),
]

// Agent is thinking/processing
export const processingMessages: Message[] = [
  createMessage('msg-1', 'user', 'Add a "Blocked" status with orange color'),
  createMessage('msg-2', 'assistant', 'I\'ll add a "Blocked" status to your statuses configuration...', true),
]

// Short conversation - completed
export const completedMessages: Message[] = [
  createMessage('msg-1', 'user', 'Add a "Bug" label with red color'),
  createMessage('msg-2', 'assistant', 'Added the **Bug** label with red color to your labels configuration.\n\nThe label is now available in the # menu and will appear as a red circle badge on sessions.'),
]

// Longer conversation with follow-up
export const conversationMessages: Message[] = [
  createMessage('msg-1', 'user', 'Add a "Blocked" status'),
  createMessage('msg-2', 'assistant', 'I\'ve added a "Blocked" status to your configuration. What color would you like for it?'),
  createMessage('msg-3', 'user', 'Make it orange'),
  createMessage('msg-4', 'assistant', 'Updated the **Blocked** status with orange color. It will now appear in your status menu with an orange indicator.'),
]

// Error scenario
export const errorMessages: Message[] = [
  createMessage('msg-1', 'user', 'Add a label called "bug"'),
  createMessage('msg-2', 'assistant', 'I attempted to add the label, but encountered an error:\n\n**Label ID "bug" already exists**\n\nWould you like me to use a different ID like "bug-report" instead?'),
]

// ============================================================================
// Helper to create Session from messages
// ============================================================================

export const createSession = (messages: Message[], isProcessing = false): Session => ({
  id: 'playground-session',
  workspaceId: 'playground-workspace',
  workspaceName: 'Playground',
  messages,
  isProcessing,
  lastMessageAt: Date.now(),
})

// ============================================================================
// EditPopover Preview Wrapper
// ============================================================================

// Mock AppShell context for playground
export const mockAppShellContext: AppShellContextType = {
  workspaces: [{ id: 'playground-workspace', name: 'Playground', slug: 'playground-workspace', rootPath: '/playground', createdAt: 0 }],
  activeWorkspaceId: 'playground-workspace',
  activeWorkspaceSlug: 'playground-workspace',
  llmConnections: [],
  refreshLlmConnections: async () => {},
  pendingPermissions: new Map(),
  pendingCredentials: new Map(),
  sessionOptions: new Map(),
  getDraft: () => '',
  getDraftAttachmentRefs: () => [],
  hydrateDraftAttachments: async () => [],
  onSelectWorkspace: () => {},
  onOpenSettings: () => {},
  onOpenKeyboardShortcuts: () => {},
  onOpenStoredUserPreferences: () => {},
  onReset: () => {},
  onSessionOptionsChange: () => {},
  onInputChange: () => {},
  onAttachmentsChange: () => {},
  onOpenFile: () => {},
  onOpenUrl: () => {},
  onRefreshWorkspaces: () => {},
  // Session callbacks required by EditPopover
  onCreateSession: async (workspaceId: string) => ({
    id: 'mock-session-' + Date.now(),
    workspaceId,
    workspaceName: 'Playground',
    messages: [],
    isProcessing: false,
    lastMessageAt: Date.now(),
  }),
  onSendMessage: (sessionId: string, message: string) => {
    console.log('[Playground] Send message to session:', sessionId, message)
  },
  onRenameSession: () => {},
  onFlagSession: () => {},
  onUnflagSession: () => {},
  onArchiveSession: () => {},
  onUnarchiveSession: () => {},
  onMarkSessionRead: () => {},
  onMarkSessionUnread: () => {},
  onSetActiveViewingSession: () => {},
  onSessionStatusChange: () => {},
  onDeleteSession: async () => true,
}

// Sample edit context for playground
export const sampleEditContext: EditContext = {
  label: 'Label Configuration',
  filePath: '/playground/labels/config.json',
  context: 'Playground demo of EditPopover component.',
}
