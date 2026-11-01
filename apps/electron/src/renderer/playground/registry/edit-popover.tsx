/** Playground entries; scenario data and preview components are kept in adjacent sections. */
import "react";
import "react";
import type { ComponentEntry } from "./types";
import "../../components/app-shell/ChatDisplay";
import "../../components/ui/EditPopover";
import "../../context/FocusContext";
import "../../context/EscapeInterruptContext";
import "../../context/AppShellContext";
import "../mock-utils";
import "lucide-react";
import "@/lib/utils";
import "@/components/ui/button";
import { emptyMessages, userMessageOnly, processingMessages, completedMessages, conversationMessages, errorMessages } from "./edit-popover/fixtures";
import { EditPopoverPreview, CompactChatPreview } from "./edit-popover/previews";

// ============================================================================
// Registry Entries
// ============================================================================

export const editPopoverComponents: ComponentEntry[] = [
  {
    id: 'edit-popover',
    name: 'EditPopover',
    category: 'Edit Popover',
    description: 'The actual EditPopover component with trigger button',
    component: EditPopoverPreview,
    props: [
      {
        name: 'inlineExecution',
        description: 'Use inline execution mode (compact ChatDisplay)',
        control: { type: 'boolean' },
        defaultValue: true,
      },
      {
        name: 'example',
        description: 'Example text shown in placeholder',
        control: { type: 'string', placeholder: 'Enter example...' },
        defaultValue: 'Add a "Bug" label with red color',
      },
      {
        name: 'triggerLabel',
        description: 'Label for the trigger button',
        control: { type: 'string', placeholder: 'Button label...' },
        defaultValue: "Edit",
      },
    ],
    variants: [
      {
        name: 'Inline Execution (Default)',
        description: 'Uses compact ChatDisplay for inline agent execution',
        props: {
          inlineExecution: true,
          example: 'Add a "Bug" label with red color',
          triggerLabel: "Edit with AI",
        },
      },
      {
        name: 'Legacy Mode',
        description: 'Opens new window instead of inline execution',
        props: {
          inlineExecution: false,
          example: 'Update the status colors',
          triggerLabel: "Quick Edit",
        },
      },
      {
        name: 'Add Source',
        description: 'Styled for adding a new source',
        props: {
          inlineExecution: true,
          example: 'Connect to my GitHub repo',
          triggerLabel: "Add Source",
        },
      },
      {
        name: 'Add Skill',
        description: 'Styled for adding a new skill',
        props: {
          inlineExecution: true,
          example: 'Review PRs following our code standards',
          triggerLabel: "Add Skill",
        },
      },
    ],
  },
  {
    id: 'compact-chat-display',
    name: 'Compact ChatDisplay',
    category: 'Edit Popover',
    description: 'Full chat experience in compact mode for inline editing in popovers',
    component: CompactChatPreview,
    props: [
      {
        name: 'isProcessing',
        description: 'Whether the agent is currently processing',
        control: { type: 'boolean' },
        defaultValue: false,
      },
      {
        name: 'placeholder',
        description: 'Placeholder text for the input',
        control: { type: 'string', placeholder: 'Enter placeholder...' },
        defaultValue: "Describe what you'd like to change...",
      },
    ],
    variants: [
      {
        name: 'Empty (Initial State)',
        description: 'No messages yet, ready for user input',
        props: {
          messages: emptyMessages,
          isProcessing: false,
          placeholder: "Describe what you'd like to change, e.g., \"Add a Blocked status\"",
        },
      },
      {
        name: 'User Message Sent',
        description: 'User just sent a message, waiting for response',
        props: {
          messages: userMessageOnly,
          isProcessing: true,
        },
      },
      {
        name: 'Processing (Thinking)',
        description: 'Agent is thinking with intermediate message',
        props: {
          messages: processingMessages,
          isProcessing: true,
        },
      },
      {
        name: 'Completed (Short)',
        description: 'Single turn completed successfully',
        props: {
          messages: completedMessages,
          isProcessing: false,
        },
      },
      {
        name: 'Conversation (Multi-turn)',
        description: 'Back-and-forth conversation with follow-ups',
        props: {
          messages: conversationMessages,
          isProcessing: false,
        },
      },
      {
        name: 'Error Response',
        description: 'Agent encountered an issue and is asking for clarification',
        props: {
          messages: errorMessages,
          isProcessing: false,
        },
      },
      {
        name: 'Add Source Context',
        description: 'Using "add source" placeholder style',
        props: {
          messages: emptyMessages,
          isProcessing: false,
          placeholder: 'What would you like to connect?',
        },
      },
      {
        name: 'Add Skill Context',
        description: 'Using "add skill" placeholder style',
        props: {
          messages: emptyMessages,
          isProcessing: false,
          placeholder: 'What should I learn to do?',
        },
      },
    ],
    mockData: () => ({
      messages: completedMessages,
    }),
  },
]
