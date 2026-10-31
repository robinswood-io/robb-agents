import type { ComponentEntry } from "../types";
import { AttachmentPreview } from "@/components/app-shell/AttachmentPreview";
import { SetupAuthBanner } from "@/components/app-shell/SetupAuthBanner";
import { TurnCard } from "@craft-agent/ui";
import { ActiveOptionBadges } from "@/components/app-shell/ActiveOptionBadges";
import { EmptyStateHint, getHintCount, getHintTemplate } from "@/components/chat/EmptyStateHint";
import { mockAttachmentCallbacks, sampleImageAttachment, samplePdfAttachment } from "../../mock-utils";
import { sampleCodeAttachment, singleBackgroundTask, sampleBackgroundTasks, longRunningTasks } from "./input-fixtures";
import { flatActivities, nestedActivitiesCompleted, nestedActivitiesInProgress, multipleNestedTasks, deepNestedActivities } from "./activity-fixtures";
import { PermissionInputToggle, ActiveTasksBarContext } from "./task-previews";

// Generate variants for all hints dynamically
const emptyStateHintVariants = Array.from({ length: getHintCount() }, (_, i) => ({
  name: `Hint ${i + 1}`,
  description: getHintTemplate(i).slice(0, 50) + '...',
  props: { hintIndex: i },
}))

export const emptyStateHintEntry: ComponentEntry = {
    id: 'empty-state-hint',
    name: 'EmptyStateHint',
    category: 'Chat',
    description: 'Rotating workflow suggestions for empty chat state with inline entity badges (sources, files, folders, skills)',
    component: EmptyStateHint,
    props: [
      {
        name: 'hintIndex',
        description: 'Specific hint to display (0-14). Leave empty for random.',
        control: { type: 'number', min: 0, max: 14, step: 1 },
        defaultValue: 0,
      },
    ],
    variants: emptyStateHintVariants,
    mockData: () => ({}),
  };

export const attachmentPreviewEntry: ComponentEntry = {
    id: 'attachment-preview',
    name: 'AttachmentPreview',
    category: 'Chat',
    description: 'ChatGPT-style attachment preview strip showing attached files as bubbles above textarea',
    component: AttachmentPreview,
    props: [
      {
        name: 'disabled',
        description: 'Disable remove buttons',
        control: { type: 'boolean' },
        defaultValue: false,
      },
      {
        name: 'loadingCount',
        description: 'Number of loading placeholders to show',
        control: { type: 'number', min: 0, max: 5, step: 1 },
        defaultValue: 0,
      },
    ],
    variants: [
      { name: 'Empty', props: { attachments: [], loadingCount: 0 } },
      { name: 'With Images', props: { attachments: [sampleImageAttachment, sampleImageAttachment] } },
      { name: 'With Documents', props: { attachments: [samplePdfAttachment, sampleCodeAttachment] } },
      { name: 'Mixed', props: { attachments: [sampleImageAttachment, samplePdfAttachment, sampleCodeAttachment] } },
      { name: 'Loading', props: { attachments: [], loadingCount: 3 } },
      { name: 'Disabled', props: { attachments: [sampleImageAttachment, samplePdfAttachment], disabled: true } },
    ],
    mockData: () => ({
      attachments: [sampleImageAttachment, samplePdfAttachment],
      onRemove: mockAttachmentCallbacks.onRemove,
    }),
  };

export const setupAuthBannerEntry: ComponentEntry = {
    id: 'setup-auth-banner',
    name: 'SetupAuthBanner',
    category: 'Chat',
    description: 'Shows when an agent needs activation or authentication',
    component: SetupAuthBanner,
    props: [
      {
        name: 'state',
        description: 'Banner state',
        control: {
          type: 'select',
          options: [
            { label: 'Hidden', value: 'hidden' },
            { label: 'MCP Auth', value: 'mcp_auth' },
            { label: 'API Auth', value: 'api_auth' },
            { label: 'Error', value: 'error' },
          ],
        },
        defaultValue: 'mcp_auth',
      },
      {
        name: 'reason',
        description: 'Custom reason message',
        control: { type: 'string', placeholder: 'Optional custom reason' },
        defaultValue: '',
      },
    ],
    variants: [
      { name: 'MCP Auth', props: { state: 'mcp_auth' } },
      { name: 'API Auth', props: { state: 'api_auth' } },
      { name: 'Custom Reason', props: { state: 'api_auth', reason: 'Your OAuth token has expired. Please re-authenticate to continue.' } },
      { name: 'Error', props: { state: 'error' } },
      { name: 'Hidden', props: { state: 'hidden' } },
    ],
    mockData: () => ({
      onAction: () => console.log('[Playground] Setup/Auth action clicked'),
    }),
  };

export const activeOptionBadgesEntry: ComponentEntry = {
    id: 'active-option-badges',
    name: 'ActiveOptionBadges',
    category: 'Chat',
    description: 'Shows active options (permission mode) and background tasks as badge pills above chat input',
    component: ActiveOptionBadges,
    props: [
      {
        name: 'permissionMode',
        description: 'Current permission mode',
        control: {
          type: 'select',
          options: [
            { label: 'Safe Mode', value: 'safe' },
            { label: 'Ask Permission', value: 'ask' },
            { label: 'Allow All', value: 'allow-all' },
          ],
        },
        defaultValue: 'ask',
      },
      {
        name: 'variant',
        description: 'Interaction variant',
        control: {
          type: 'select',
          options: [
            { label: 'Dropdown', value: 'dropdown' },
            { label: 'Cycle', value: 'cycle' },
          ],
        },
        defaultValue: 'dropdown',
      },
    ],
    variants: [
      { name: 'Permission Mode (Ask)', props: { permissionMode: 'ask', tasks: [], sessionId: 'session-1' } },
      { name: 'Permission Mode (Safe)', props: { permissionMode: 'safe', tasks: [], sessionId: 'session-1' } },
      { name: 'Permission Mode (Allow All)', props: { permissionMode: 'allow-all', tasks: [], sessionId: 'session-1' } },
      { name: 'Single Task', props: { permissionMode: 'ask', tasks: singleBackgroundTask, sessionId: 'session-1' } },
      { name: 'Multiple Tasks', props: { permissionMode: 'ask', tasks: sampleBackgroundTasks, sessionId: 'session-1' } },
      { name: 'Long Running Tasks', props: { permissionMode: 'ask', tasks: longRunningTasks, sessionId: 'session-1' } },
      { name: 'All Active (Everything)', props: { permissionMode: 'ask', tasks: sampleBackgroundTasks, sessionId: 'session-1' } },
      { name: 'Tasks in Safe Mode', props: { permissionMode: 'safe', tasks: sampleBackgroundTasks, sessionId: 'session-1' } },
      { name: 'Cycle Variant', props: { permissionMode: 'ask', tasks: sampleBackgroundTasks, variant: 'cycle', sessionId: 'session-1' } },
    ],
    mockData: () => ({
      tasks: sampleBackgroundTasks,
      sessionId: 'session-playground',
      onPermissionModeChange: (mode: string) => console.log('[Playground] Permission mode changed:', mode),
      onKillTask: (taskId: string) => console.log('[Playground] Kill task:', taskId),
    }),
  };

export const permissionInputToggleEntry: ComponentEntry = {
    id: 'permission-input-toggle',
    name: 'Permission ↔ Input Toggle',
    category: 'Chat',
    description: 'Interactive test for animating between Permission Banner and Input View. Click buttons to toggle states and inspect animations.',
    component: PermissionInputToggle,
    props: [
      {
        name: 'useLongCommand',
        description: 'Use a very long multi-line command',
        control: { type: 'boolean' },
        defaultValue: false,
      },
      {
        name: 'autoToggle',
        description: 'Automatically toggle between states',
        control: { type: 'boolean' },
        defaultValue: false,
      },
      {
        name: 'autoToggleInterval',
        description: 'Auto-toggle interval in milliseconds',
        control: { type: 'number', min: 1000, max: 10000, step: 500 },
        defaultValue: 3000,
      },
    ],
    variants: [
      { name: 'Short Command', props: { useLongCommand: false } },
      { name: 'Long Command (10+ lines)', props: { useLongCommand: true } },
      { name: 'Auto Toggle', props: { autoToggle: true, autoToggleInterval: 2000 } },
    ],
    mockData: () => ({}),
  };

export const turnCardFlatEntry: ComponentEntry = {
    id: 'turn-card-flat',
    name: 'TurnCard (Flat Tools)',
    category: 'Turn Cards',
    description: 'TurnCard with flat tool hierarchy - no nesting, all tools at root level',
    component: TurnCard,
    props: [],
    variants: [
      { name: 'Default', props: {} },
    ],
    mockData: () => ({
      activities: flatActivities,
      response: { text: 'I found the pattern across the codebase and made the necessary edits.', isStreaming: false },
      isStreaming: false,
      isComplete: true,
    }),
  };

export const turnCardNestedCompleteEntry: ComponentEntry = {
    id: 'turn-card-nested-complete',
    name: 'TurnCard (Nested - Complete)',
    category: 'Turn Cards',
    description: 'TurnCard showing Task subagent with completed child tools - vertical line tree view',
    component: TurnCard,
    props: [],
    variants: [
      { name: 'Default', props: {} },
    ],
    mockData: () => ({
      activities: nestedActivitiesCompleted,
      response: { text: 'Exploration complete. I found 24 React components with 156 exported functions. The codebase follows a modular pattern.', isStreaming: false },
      isStreaming: false,
      isComplete: true,
    }),
  };

export const turnCardNestedProgressEntry: ComponentEntry = {
    id: 'turn-card-nested-progress',
    name: 'TurnCard (Nested - In Progress)',
    category: 'Turn Cards',
    description: 'TurnCard showing Task subagent with child tools still running',
    component: TurnCard,
    props: [],
    variants: [
      { name: 'Default', props: {} },
    ],
    mockData: () => ({
      activities: nestedActivitiesInProgress,
      isStreaming: true,
      isComplete: false,
    }),
  };

export const turnCardMultiTaskEntry: ComponentEntry = {
    id: 'turn-card-multi-task',
    name: 'TurnCard (Multiple Tasks)',
    category: 'Turn Cards',
    description: 'TurnCard showing multiple sequential Task subagents, each with their own child tools',
    component: TurnCard,
    props: [],
    variants: [
      { name: 'Default', props: {} },
    ],
    mockData: () => ({
      activities: multipleNestedTasks,
      response: { text: 'Analysis and fixes complete. I found 23 TODO/FIXME issues, removed deprecated code, and created a modern replacement component.', isStreaming: false },
      isStreaming: false,
      isComplete: true,
    }),
  };

export const turnCardDeepNestedEntry: ComponentEntry = {
    id: 'turn-card-deep-nested',
    name: 'TurnCard (Deep Nesting)',
    category: 'Turn Cards',
    description: 'TurnCard showing 2+ levels of nesting - Task containing another Task with tools',
    component: TurnCard,
    props: [],
    variants: [
      { name: 'Default', props: {} },
    ],
    mockData: () => ({
      activities: deepNestedActivities,
      response: { text: 'Authentication refactoring complete. I implemented OAuth with PKCE, created a callback handler, and all tests pass.', isStreaming: false },
      isStreaming: false,
      isComplete: true,
    }),
  };

export const activeTasksBarContextEntry: ComponentEntry = {
    id: 'active-tasks-bar-context',
    name: 'Active Tasks & Badges',
    category: 'Chat',
    description: 'Integrated display of option badges (permission mode) and background tasks in a horizontally scrollable row. Shows full chat context with messages above and input below.',
    component: ActiveTasksBarContext,
    layout: 'full',
    props: [],
    variants: [
      { name: 'With Multiple Tasks', props: { tasks: sampleBackgroundTasks } },
      { name: 'With Single Task', props: { tasks: singleBackgroundTask } },
      { name: 'With Long Running Tasks', props: { tasks: longRunningTasks } },
      { name: 'Empty (Hidden)', props: { tasks: [] } },
    ],
    mockData: () => ({
      tasks: sampleBackgroundTasks,
    }),
  };
