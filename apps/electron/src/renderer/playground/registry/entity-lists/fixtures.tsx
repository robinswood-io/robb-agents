/**
 * Playground registry for EntityRow and EntityList primitives.
 *
 * Demonstrates all three entity types (Sessions, Sources, Skills)
 * composed through the same EntityRow/EntityList building blocks.
 */
import * as React from "react";
import { Circle, Globe, HardDrive } from "lucide-react";
import type { SessionMeta } from "@/atoms/sessions";

// ============================================================================
// Sample Session Data
// ============================================================================

interface MockSessionStatus {
  id: string
  label: string
  color: string
  icon: React.ReactNode
}

const mockStatuses = [
  { id: 'todo', label: 'Todo', color: 'var(--muted-foreground)', icon: <Circle className="h-3.5 w-3.5" strokeWidth={1.5} /> },
  { id: 'in-progress', label: 'In Progress', color: 'var(--info)', icon: <Circle className="h-3.5 w-3.5" strokeWidth={1.5} /> },
  { id: 'done', label: 'Done', color: 'var(--success)', icon: <Circle className="h-3.5 w-3.5" strokeWidth={1.5} /> },
] as const satisfies readonly MockSessionStatus[]

export const sampleSessions: (SessionMeta & { _status: MockSessionStatus })[] = [
  {
    id: 'session-1',
    name: 'Fix authentication bug in login flow',
    workspaceId: 'ws-1',
    lastMessageAt: Date.now() - 1000 * 60 * 5,
    sessionStatus: 'in-progress',
    hasUnread: true,
    isFlagged: true,
    _status: mockStatuses[1],
  },
  {
    id: 'session-2',
    name: 'Implement search functionality across sessions',
    workspaceId: 'ws-1',
    lastMessageAt: Date.now() - 1000 * 60 * 30,
    sessionStatus: 'todo',
    labels: ['feature', 'priority::high'],
    _status: mockStatuses[0],
  },
  {
    id: 'session-3',
    name: 'Review pull request #42',
    workspaceId: 'ws-1',
    lastMessageAt: Date.now() - 1000 * 60 * 60,
    sessionStatus: 'done',
    isProcessing: true,
    _status: mockStatuses[2],
  },
  {
    id: 'session-4',
    name: 'Debug API response handling and error states',
    workspaceId: 'ws-1',
    lastMessageAt: Date.now() - 1000 * 60 * 60 * 2,
    sessionStatus: 'todo',
    _status: mockStatuses[0],
  },
]

// ============================================================================
// Sample Source Data
// ============================================================================

export interface MockSource {
  id: string
  name: string
  type: 'mcp' | 'api' | 'local'
  tagline: string
  status: 'connected' | 'needs_auth' | 'failed' | 'untested'
  icon: React.ComponentType<{ className?: string }>
}

export const sampleSources: MockSource[] = [
  { id: 'github', name: 'GitHub', type: 'mcp', tagline: 'Repositories, issues, and pull requests', status: 'connected', icon: Globe },
  { id: 'linear', name: 'Linear', type: 'api', tagline: 'Issue tracking and project management', status: 'connected', icon: Globe },
  { id: 'slack', name: 'Slack', type: 'mcp', tagline: 'Channels, messages, and search', status: 'needs_auth', icon: Globe },
  { id: 'local-files', name: 'Project Files', type: 'local', tagline: '~/Documents/projects', status: 'connected', icon: HardDrive },
  { id: 'stripe', name: 'Stripe', type: 'api', tagline: 'Payments and subscriptions', status: 'untested', icon: Globe },
]

// ============================================================================
// Sample Skill Data
// ============================================================================

export interface MockSkill {
  id: string
  name: string
  description: string
  icon?: string // emoji
}

export const sampleSkills: MockSkill[] = [
  { id: 'commit', name: 'Commit', description: 'Create well-structured git commits with conventional messages', icon: '📝' },
  { id: 'review-pr', name: 'Review PR', description: 'Thorough code review with security and performance analysis', icon: '🔍' },
  { id: 'refactor', name: 'Refactor', description: 'Safely restructure code while preserving behavior' },
  { id: 'test', name: 'Write Tests', description: 'Generate comprehensive unit and integration tests', icon: '🧪' },
]

// ============================================================================
// Source Type Badge Config
// ============================================================================

export const SOURCE_TYPE_CONFIG: Record<string, { label: string; colorClass: string }> = {
  mcp: { label: 'MCP', colorClass: 'bg-accent/10 text-accent' },
  api: { label: 'API', colorClass: 'bg-success/10 text-success' },
  local: { label: 'Local', colorClass: 'bg-info/10 text-info' },
}

export const SOURCE_STATUS_CONFIG: Record<string, { label: string; colorClass: string } | null> = {
  connected: null,
  needs_auth: { label: 'Auth Required', colorClass: 'bg-warning/10 text-warning' },
  failed: { label: 'Disconnected', colorClass: 'bg-destructive/10 text-destructive' },
  untested: { label: 'Not Tested', colorClass: 'bg-foreground/10 text-foreground/50' },
}

// ============================================================================
// Interactive Demo: keyboard nav + multi-select + search
// ============================================================================

export type AnyMockEntity =
  | { kind: 'session'; id: string; name: string; status: MockSessionStatus; hasUnread?: boolean; isFlagged?: boolean; lastMessageAt?: number }
  | { kind: 'source'; id: string; name: string; type: string; tagline: string; status: string; icon: React.ComponentType<{ className?: string }> }
  | { kind: 'skill'; id: string; name: string; description: string; emoji?: string }

export const interactiveItems: AnyMockEntity[] = [
  // Sessions
  ...sampleSessions.map(s => ({
    kind: 'session' as const,
    id: s.id,
    name: s.name || 'Untitled',
    status: s._status,
    ...(s.hasUnread !== undefined ? { hasUnread: s.hasUnread } : {}),
    ...(s.isFlagged !== undefined ? { isFlagged: s.isFlagged } : {}),
    ...(s.lastMessageAt !== undefined ? { lastMessageAt: s.lastMessageAt } : {}),
  })),
  // Sources
  ...sampleSources.map(s => ({
    kind: 'source' as const,
    id: s.id,
    name: s.name,
    type: s.type,
    tagline: s.tagline,
    status: s.status,
    icon: s.icon,
  })),
  // Skills
  ...sampleSkills.map(s => ({
    kind: 'skill' as const,
    id: s.id,
    name: s.name,
    description: s.description,
    ...(s.icon !== undefined ? { emoji: s.icon } : {}),
  })),
]
