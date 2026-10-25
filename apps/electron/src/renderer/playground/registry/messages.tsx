/** Playground entries; scenario data and preview components are kept in adjacent sections. */
import "react";
import type { ComponentEntry } from "./types";
import { UserMessageBubble, SystemMessage } from "@craft-agent/ui";
import "lucide-react";
import "motion/react";
import { AuthRequestCard } from "@/components/chat/AuthRequestCard";
import { AssistantMessage, StatusMessage, CompactionDivider, ProcessingIndicator } from "./messages/status";
import { MessageGallery, createAuthMessage } from "./messages/gallery";

// ============================================================================
// Component Registry Entries
// ============================================================================

export const messagesComponents: ComponentEntry[] = [
  {
    id: 'message-gallery',
    name: 'Message Gallery',
    category: 'Chat Messages',
    description: 'All message types displayed together for easy design comparison',
    component: MessageGallery,
    layout: 'top',
    props: [],
    variants: [],
    mockData: () => ({}),
  },
  {
    id: 'user-message-bubble',
    name: 'UserMessageBubble',
    category: 'Chat Messages',
    description: 'Right-aligned user message bubble (from @craft-agent/ui)',
    component: UserMessageBubble,
    props: [
      {
        name: 'content',
        description: 'Message text content',
        control: { type: 'textarea', placeholder: 'Enter message...', rows: 2 },
        defaultValue: 'How do I authenticate with the API?',
      },
    ],
    variants: [
      { name: 'Short', props: { content: 'Hello!' } },
      { name: 'Medium', props: { content: 'How do I authenticate with the API?' } },
      { name: 'Long', props: { content: 'Can you search for all files that contain "handleError" and show me how they work? I need to understand the error handling patterns in this codebase.' } },
    ],
    mockData: () => ({}),
  },
  {
    id: 'assistant-message',
    name: 'AssistantMessage',
    category: 'Chat Messages',
    description: 'Left-aligned assistant response with markdown support',
    component: AssistantMessage,
    props: [
      {
        name: 'content',
        description: 'Message text content (supports markdown)',
        control: { type: 'textarea', placeholder: 'Enter message...', rows: 4 },
        defaultValue: 'I found the authentication handlers in `src/auth/`. The main handler is `AuthHandler` which manages OAuth flows.',
      },
    ],
    variants: [
      { name: 'Short', props: { content: 'The file is located at `src/config.ts`.' } },
      { name: 'With Code', props: { content: 'Here\'s the code:\n\n```typescript\nconst x = 1;\n```' } },
      { name: 'With List', props: { content: '**Steps:**\n1. First step\n2. Second step\n3. Third step' } },
    ],
    mockData: () => ({}),
  },
  {
    id: 'status-message',
    name: 'StatusMessage',
    category: 'Chat Messages',
    description: 'System status with spinner (compaction, connecting, etc)',
    component: StatusMessage,
    props: [
      {
        name: 'content',
        description: 'Status message text',
        control: { type: 'string', placeholder: 'Status message...' },
        defaultValue: 'Compacting conversation...',
      },
    ],
    variants: [
      { name: 'Compacting', props: { content: 'Compacting conversation...' } },
      { name: 'Compacted', props: { content: 'Compacted conversation (was 180000 tokens)' } },
      { name: 'Connecting', props: { content: 'Connecting to server...' } },
    ],
    mockData: () => ({}),
  },
  {
    id: 'system-message',
    name: 'SystemMessage',
    category: 'Chat Messages',
    description: 'System/info/warning/error message (from @craft-agent/ui)',
    component: SystemMessage,
    props: [
      {
        name: 'content',
        description: 'Message text content',
        control: { type: 'textarea', placeholder: 'Message content...', rows: 2 },
        defaultValue: 'This is a system message.',
      },
      {
        name: 'type',
        description: 'Message type determining visual style',
        control: {
          type: 'select',
          options: [
            { label: 'System', value: 'system' },
            { label: 'Info', value: 'info' },
            { label: 'Warning', value: 'warning' },
            { label: 'Error', value: 'error' },
          ],
        },
        defaultValue: 'system',
      },
    ],
    variants: [
      { name: 'System', props: { content: 'Session restored from 5 minutes ago.', type: 'system' } },
      { name: 'Info', props: { content: 'Agent activated successfully.', type: 'info' } },
      { name: 'Warning', props: { content: 'Rate limit approaching.', type: 'warning' } },
      { name: 'Error', props: { content: 'Connection lost.', type: 'error' } },
    ],
    mockData: () => ({}),
  },
  {
    id: 'compaction-divider',
    name: 'CompactionDivider',
    category: 'Chat Messages',
    description: 'Horizontal rule with centered label shown after context compaction',
    component: CompactionDivider,
    props: [
      {
        name: 'label',
        description: 'Label text shown in the center',
        control: { type: 'string', placeholder: 'Label...' },
        defaultValue: 'Conversation Compacted',
      },
    ],
    variants: [
      { name: 'Default', props: { label: 'Conversation Compacted' } },
      { name: 'Custom Label', props: { label: 'Context Reset' } },
    ],
    mockData: () => ({}),
  },
  {
    id: 'processing-indicator',
    name: 'ProcessingIndicator',
    category: 'Chat Messages',
    description: 'Animated processing indicator with cycling messages and elapsed time counter',
    component: ProcessingIndicator,
    props: [
      {
        name: 'cycleMs',
        description: 'Message cycle interval in milliseconds',
        control: { type: 'number', min: 1000, max: 30000, step: 1000 },
        defaultValue: 10000,
      },
      {
        name: 'counting',
        description: 'Whether the elapsed counter auto-increments',
        control: { type: 'boolean' },
        defaultValue: true,
      },
      {
        name: 'elapsed',
        description: 'Initial elapsed time in seconds (only used when counting is false)',
        control: { type: 'number', min: 0, max: 120, step: 1 },
        defaultValue: 0,
      },
    ],
    variants: [
      { name: 'Default (10s cycle, counting)', props: { cycleMs: 10000, counting: true } },
      { name: 'Fast Cycle (3s)', props: { cycleMs: 3000, counting: true } },
      { name: 'Static at 5s', props: { cycleMs: 10000, counting: false, elapsed: 5 } },
      { name: 'Static at 30s', props: { cycleMs: 10000, counting: false, elapsed: 30 } },
    ],
    mockData: () => ({}),
  },
  {
    id: 'auth-request-card',
    name: 'AuthRequestCard',
    category: 'Chat Messages',
    description: 'Inline authentication request card for credentials or OAuth flows',
    component: ({ authType, authStatus, sourceName, mode, description, hint, error, email }) => (
      <div className="w-[80%]">
        <AuthRequestCard
          sessionId="playground-session"
          message={createAuthMessage({
            type: authType,
            status: authStatus,
            sourceSlug: sourceName.toLowerCase().replace(/\s+/g, '-'),
            sourceName,
            mode,
            description,
            hint,
            error,
            email,
          })}
          onRespondToCredential={(sessionId, requestId, response) =>
            console.log('Credential response:', { sessionId, requestId, response })
          }
        />
      </div>
    ),
    props: [
      {
        name: 'authType',
        description: 'Type of authentication',
        control: {
          type: 'select',
          options: [
            { label: 'Credential', value: 'credential' },
            { label: 'OAuth', value: 'oauth' },
            { label: 'Google OAuth', value: 'oauth-google' },
            { label: 'Slack OAuth', value: 'oauth-slack' },
            { label: 'Microsoft OAuth', value: 'oauth-microsoft' },
          ],
        },
        defaultValue: 'credential',
      },
      {
        name: 'authStatus',
        description: 'Current status of the auth request',
        control: {
          type: 'select',
          options: [
            { label: 'Pending', value: 'pending' },
            { label: 'Completed', value: 'completed' },
            { label: 'Cancelled', value: 'cancelled' },
            { label: 'Failed', value: 'failed' },
          ],
        },
        defaultValue: 'pending',
      },
      {
        name: 'sourceName',
        description: 'Name of the source',
        control: { type: 'string', placeholder: 'Source name...' },
        defaultValue: 'GitHub',
      },
      {
        name: 'mode',
        description: 'Credential mode (only for credential type)',
        control: {
          type: 'select',
          options: [
            { label: 'Bearer Token', value: 'bearer' },
            { label: 'Basic Auth', value: 'basic' },
            { label: 'Header', value: 'header' },
            { label: 'Query Param', value: 'query' },
          ],
        },
        defaultValue: 'bearer',
      },
      {
        name: 'description',
        description: 'Description shown to user',
        control: { type: 'string', placeholder: 'Description...' },
        defaultValue: 'Enter your personal access token to connect.',
      },
      {
        name: 'hint',
        description: 'Hint about where to find credentials',
        control: { type: 'string', placeholder: 'Hint...' },
        defaultValue: '',
      },
      {
        name: 'error',
        description: 'Error message (for failed status)',
        control: { type: 'string', placeholder: 'Error message...' },
        defaultValue: '',
      },
      {
        name: 'email',
        description: 'Email (for completed OAuth)',
        control: { type: 'string', placeholder: 'Email...' },
        defaultValue: '',
      },
    ],
    variants: [
      {
        name: 'Credential Pending',
        props: {
          authType: 'credential',
          authStatus: 'pending',
          sourceName: 'GitHub',
          mode: 'bearer',
          description: 'Enter your personal access token to connect.',
          hint: 'Generate at https://github.com/settings/tokens',
        },
      },
      {
        name: 'Basic Auth',
        props: {
          authType: 'credential',
          authStatus: 'pending',
          sourceName: 'Jira',
          mode: 'basic',
          description: 'Connect to your Atlassian account.',
        },
      },
      {
        name: 'OAuth Pending',
        props: {
          authType: 'oauth',
          authStatus: 'pending',
          sourceName: 'Linear',
        },
      },
      {
        name: 'Google OAuth',
        props: {
          authType: 'oauth-google',
          authStatus: 'pending',
          sourceName: 'Gmail',
        },
      },
      {
        name: 'Completed',
        props: {
          authType: 'oauth-google',
          authStatus: 'completed',
          sourceName: 'Gmail',
          email: 'user@example.com',
        },
      },
      {
        name: 'Cancelled',
        props: {
          authType: 'oauth',
          authStatus: 'cancelled',
          sourceName: 'Slack',
        },
      },
      {
        name: 'Failed',
        props: {
          authType: 'credential',
          authStatus: 'failed',
          sourceName: 'Sentry',
          error: 'Invalid API key. Please check and try again.',
        },
      },
    ],
    mockData: () => ({}),
  },
]
