import type { SessionMeta } from "@/atoms/sessions";
import type { SessionStatus } from "@/config/session-status-config";
import { Circle } from "lucide-react";
import { type SessionListContextValue } from "@/context/SessionListContext";

// ============================================================================
// Mock Todo States (minimal set for playground)
// ============================================================================

const mockSessionStatuses: SessionStatus[] = [
  {
    id: 'todo',
    label: 'Todo',
    resolvedColor: 'var(--muted-foreground)',
    icon: <Circle className="h-3.5 w-3.5" strokeWidth={1.5} />,
    iconColorable: true,
    category: 'open',
  },
  {
    id: 'in-progress',
    label: 'In Progress',
    resolvedColor: 'var(--info)',
    icon: <Circle className="h-3.5 w-3.5" strokeWidth={1.5} />,
    iconColorable: true,
    category: 'open',
  },
  {
    id: 'done',
    label: 'Done',
    resolvedColor: 'var(--success)',
    icon: <Circle className="h-3.5 w-3.5" strokeWidth={1.5} />,
    iconColorable: true,
    category: 'closed',
  },
]

// ============================================================================
// Sample Session Data
// ============================================================================

export const sampleSessions: SessionMeta[] = [
  {
    id: 'session-1',
    name: 'Fix authentication bug in login flow',
    workspaceId: 'workspace-1',
    lastMessageAt: Date.now() - 1000 * 60 * 5, // 5 min ago
    sessionStatus: 'in-progress',
    hasUnread: true,
    isFlagged: true,
  },
  {
    id: 'session-2',
    name: 'Implement search functionality',
    workspaceId: 'workspace-1',
    lastMessageAt: Date.now() - 1000 * 60 * 30, // 30 min ago
    sessionStatus: 'todo',
    isFlagged: true,
    labels: ['feature', 'priority::high'],
  },
  {
    id: 'session-3',
    name: 'Review pull request #42',
    workspaceId: 'workspace-1',
    lastMessageAt: Date.now() - 1000 * 60 * 60, // 1 hour ago
    sessionStatus: 'done',
    isFlagged: true,
    isProcessing: true,
  },
  {
    id: 'session-4',
    name: 'Debug API response handling',
    workspaceId: 'workspace-1',
    lastMessageAt: Date.now() - 1000 * 60 * 60 * 2, // 2 hours ago
    sessionStatus: 'todo',
    isFlagged: true,
  },
]

export function createMockContext(overrides: Partial<SessionListContextValue> = {}): SessionListContextValue {
  return {
    onRenameClick: () => {},
    onSessionStatusChange: () => {},
    onMarkUnread: () => {},
    onDelete: async () => true,
    onSelectSessionById: () => {},
    onOpenInNewWindow: () => {},
    onFocusZone: () => {},
    onKeyDown: () => {},
    sessionStatuses: mockSessionStatuses,
    flatLabels: [],
    labels: [],
    isMultiSelectActive: false,
    contentSearchResults: new Map(),
    ...overrides,
  }
}

export const noopKeyDown = () => {}
