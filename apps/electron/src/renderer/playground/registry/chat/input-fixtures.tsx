import type { AppShellContextType } from '@/context/AppShellContext';
import type { BackgroundTask } from "@/components/app-shell/ActiveTasksBar";
import { Circle } from "lucide-react";
import type { LabelConfig } from "@craft-agent/shared/labels";
import type { SessionStatus } from "@/config/session-status-config";
import type { FileAttachment,PermissionRequest } from "../../../../shared/types";

export const sampleCodeAttachment: FileAttachment = {
  type: 'text',
  path: '/Users/test/app.tsx',
  name: 'App.tsx',
  mimeType: 'text/typescript',
  size: 8500,
}

export const samplePermissionRequest: PermissionRequest = {
  requestId: 'perm-1',
  sessionId: 'session-1',
  toolName: 'bash',
  description: 'Run shell command',
  command: 'npm install --save-dev typescript @types/react',
}


export const veryLongPermissionRequest: PermissionRequest = {
  requestId: 'perm-3',
  sessionId: 'session-1',
  toolName: 'bash',
  description: 'Run complex deployment script',
  command: `#!/bin/bash
set -e

echo "Starting deployment..."
cd /Users/project/app

# Build the application
npm run build
npm run test

# Docker operations
docker build -t myapp:latest .
docker tag myapp:latest registry.example.com/myapp:latest
docker push registry.example.com/myapp:latest

# Deploy to kubernetes
kubectl apply -f k8s/deployment.yaml
kubectl rollout status deployment/myapp`,
}

// Sample background tasks
export const sampleBackgroundTasks: BackgroundTask[] = [
  {
    id: 'task-abc123',
    type: 'agent',
    toolUseId: 'tool-1',
    startTime: Date.now() - 45000, // 45 seconds ago
    elapsedSeconds: 45,
    intent: 'Explore codebase structure',
    status: 'running',
  },
  {
    id: 'shell-xyz456',
    type: 'shell',
    toolUseId: 'tool-2',
    startTime: Date.now() - 154000, // 2m 34s ago
    elapsedSeconds: 154,
    status: 'running',
  },
]

export const singleBackgroundTask: BackgroundTask[] = [
  {
    id: 'task-123456',
    type: 'agent',
    toolUseId: 'tool-single',
    startTime: Date.now() - 23000,
    elapsedSeconds: 23,
    intent: 'Search for TypeScript files',
    status: 'running',
  },
]

export const longRunningTasks: BackgroundTask[] = [
  {
    id: 'task-long-1',
    type: 'agent',
    toolUseId: 'tool-long-1',
    startTime: Date.now() - 3723000, // 1h 2m 3s
    elapsedSeconds: 3723,
    intent: 'Refactor authentication system',
    status: 'running',
  },
  {
    id: 'shell-long-2',
    type: 'shell',
    toolUseId: 'tool-long-2',
    startTime: Date.now() - 245000, // 4m 5s
    elapsedSeconds: 245,
    status: 'orphaned',
    completedAt: Date.now() - 5000,
  },
  {
    id: 'task-long-3',
    type: 'agent',
    toolUseId: 'tool-long-3',
    startTime: Date.now() - 12000, // 12s
    elapsedSeconds: 12,
    intent: 'Run tests',
    status: 'completed',
    completedAt: Date.now() - 2000,
  },
]

export const inputContainerSampleLabels: LabelConfig[] = [
  { id: 'bug', name: 'Bug', color: { light: '#EF4444', dark: '#F87171' } },
  { id: 'priority', name: 'Priority', color: { light: '#F59E0B', dark: '#FBBF24' }, valueType: 'number' },
  { id: 'due-date', name: 'Due Date', color: { light: '#3B82F6', dark: '#60A5FA' }, valueType: 'date' },
  { id: 'sprint', name: 'Sprint', color: { light: '#8B5CF6', dark: '#A78BFA' }, valueType: 'string' },
]

export const inputContainerSampleStatuses: SessionStatus[] = [
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

export const playgroundAppShellContext: AppShellContextType = {
  workspaces: [{ id: 'playground-workspace', name: 'Playground', slug: 'playground-workspace', rootPath: '/playground', createdAt: 0 }],
  activeWorkspaceId: 'playground-workspace',
  activeWorkspaceSlug: 'playground-workspace',
  llmConnections: [],

  refreshLlmConnections: async () => {},
  pendingPermissions: new Map(),
  pendingCredentials: new Map(),
  getDraft: () => '',
  getDraftAttachmentRefs: () => [],
  hydrateDraftAttachments: async () => [],
  sessionOptions: new Map(),
  onCreateSession: async () => ({
    id: 'playground-session',
    workspaceId: 'playground-workspace',
    workspaceName: 'Playground',
    messages: [],
    isProcessing: false,
    lastMessageAt: Date.now(),
  }),
  onSendMessage: () => {},
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
  onOpenFile: () => {},
  onOpenUrl: () => {},
  onSelectWorkspace: () => {},
  onRefreshWorkspaces: () => {},
  onOpenSettings: () => {},
  onOpenKeyboardShortcuts: () => {},
  onOpenStoredUserPreferences: () => {},
  onReset: () => {},
  onSessionOptionsChange: () => {},
  onInputChange: () => {},
  onAttachmentsChange: () => {},
}
