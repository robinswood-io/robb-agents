import type { ComponentEntry } from "../types";
import { InputContainerPlayground } from "./input-preview";

export const inputContainerEntry: ComponentEntry = {
    id: 'input-container',
    name: 'InputContainer',
    category: 'Chat Inputs',
    description: 'App-like input zone with max-width layout, active option badges, labels, statuses, tasks, and full InputContainer behavior',
    component: InputContainerPlayground,
    layout: 'full',
    previewOverflow: 'visible',
    props: [
      {
        name: 'inputMode',
        description: 'Input mode rendered by InputContainer',
        control: {
          type: 'select',
          options: [
            { label: 'Freeform', value: 'freeform' },
            { label: 'Permission', value: 'permission' },
            { label: 'Admin Approval', value: 'admin_approval' },
          ],
        },
        defaultValue: 'freeform',
      },
      {
        name: 'disabled',
        description: 'Disable all inputs',
        control: { type: 'boolean' },
        defaultValue: false,
      },
      {
        name: 'isProcessing',
        description: 'Show processing state (disables send, shows stop)',
        control: { type: 'boolean' },
        defaultValue: false,
      },
      {
        name: 'compactMode',
        description: 'Compact mode used by embedded editors/popovers',
        control: { type: 'boolean' },
        defaultValue: false,
      },
      {
        name: 'placeholder',
        description: 'Textarea placeholder text',
        control: { type: 'string', placeholder: 'Message...' },
        defaultValue: 'Message Craft Agent...',
      },
      {
        name: 'currentModel',
        description: 'Current selected model',
        control: {
          type: 'select',
          options: [
            { label: 'Opus 4.8', value: 'claude-opus-4-8' },
            { label: 'Opus 4.7', value: 'claude-opus-4-7' },
            { label: 'Sonnet 4.6', value: 'claude-sonnet-4-6' },
            { label: 'Haiku 3.5', value: 'claude-3-5-haiku-20241022' },
          ],
        },
        defaultValue: 'claude-sonnet-4-6',
      },
      {
        name: 'permissionMode',
        description: 'Permission mode badge',
        control: {
          type: 'select',
          options: [
            { label: 'Safe (read-only)', value: 'safe' },
            { label: 'Ask (prompt)', value: 'ask' },
            { label: 'Allow All', value: 'allow-all' },
          ],
        },
        defaultValue: 'ask',
      },
      {
        name: 'showOptionBadges',
        description: 'Show the ActiveOptionBadges row above input',
        control: { type: 'boolean' },
        defaultValue: true,
      },
      {
        name: 'showTasks',
        description: 'Include background tasks in badges row',
        control: { type: 'boolean' },
        defaultValue: true,
      },
      {
        name: 'showLabels',
        description: 'Include label badges and value editing',
        control: { type: 'boolean' },
        defaultValue: true,
      },
      {
        name: 'labelCount',
        description: 'Number of label configs to show',
        control: { type: 'number', min: 1, max: 4, step: 1 },
        defaultValue: 3,
      },
      {
        name: 'showStatuses',
        description: 'Include session status badge and menu',
        control: { type: 'boolean' },
        defaultValue: true,
      },
      {
        name: 'showWorkingDirectory',
        description: 'Show working directory context badge',
        control: { type: 'boolean' },
        defaultValue: true,
      },
      {
        name: 'workingDirectory',
        description: 'Current working directory',
        control: { type: 'string', placeholder: '/path/to/project' },
        defaultValue: '/Users/demo/projects/craft-agent',
      },
      {
        name: 'seedRecentDirs',
        description: 'Seed recent working directory history in playground local storage',
        control: { type: 'boolean' },
        defaultValue: true,
      },
      {
        name: 'recentDirScenario',
        description: 'Fixture set used for recent working directory history',
        control: {
          type: 'select',
          options: [
            { label: 'Few (3 items)', value: 'few' },
            { label: 'Many (9 items + filter)', value: 'many' },
            { label: 'None (empty)', value: 'none' },
          ],
        },
        defaultValue: 'few',
      },
      {
        name: 'showAttachments',
        description: 'Show preloaded attachment chips above editor',
        control: { type: 'boolean' },
        defaultValue: false,
      },
      {
        name: 'attachmentCount',
        description: 'Number of preloaded attachments to preview',
        control: { type: 'number', min: 1, max: 3, step: 1 },
        defaultValue: 2,
      },
      {
        name: 'showFollowUps',
        description: 'Show follow-up annotation chips above editor',
        control: { type: 'boolean' },
        defaultValue: false,
      },
      {
        name: 'followUpCount',
        description: 'Number of follow-up chips to preview',
        control: { type: 'number', min: 1, max: 4, step: 1 },
        defaultValue: 2,
      },
    ],
    mockData: () => ({}),
    variants: [
      {
        name: 'Default (Comprehensive)',
        description: 'App-like full setup with badges, labels, statuses, and working directory',
        props: {},
      },
      {
        name: 'Working Dir History (Few)',
        description: 'Recent working directory list with a few entries (remove button testing)',
        props: {
          showWorkingDirectory: true,
          seedRecentDirs: true,
          recentDirScenario: 'few',
        },
      },
      {
        name: 'Working Dir History (Many + Filter)',
        description: 'Recent working directory list with many entries to trigger filter input path',
        props: {
          showWorkingDirectory: true,
          seedRecentDirs: true,
          recentDirScenario: 'many',
        },
      },
      {
        name: 'Working Dir History (Empty)',
        description: 'No recent directory history (empty state)',
        props: {
          showWorkingDirectory: true,
          seedRecentDirs: true,
          recentDirScenario: 'none',
        },
      },
      {
        name: 'Minimal',
        description: 'Input only — no badges or working-directory badge',
        props: {
          showOptionBadges: false,
          showWorkingDirectory: false,
        },
      },
      {
        name: 'Processing + Tasks',
        description: 'Streaming/processing state with background task badges',
        props: {
          isProcessing: true,
          showTasks: true,
          showOptionBadges: true,
        },
      },
      {
        name: 'Safe + Compact',
        description: 'Explore mode style in compact embedding',
        props: {
          permissionMode: 'safe',
          compactMode: true,
          showTasks: false,
        },
      },
      {
        name: 'Permission Mode UI',
        description: 'Structured permission request replaces freeform input',
        props: {
          inputMode: 'permission',
          showFollowUps: false,
        },
      },
      {
        name: 'Admin Approval UI',
        description: 'Structured admin approval request state',
        props: {
          inputMode: 'admin_approval',
          showFollowUps: false,
        },
      },
      {
        name: 'Label-heavy Review',
        description: 'Many labels + status for metadata density checks',
        props: {
          showLabels: true,
          labelCount: 4,
          showStatuses: true,
          showTasks: false,
        },
      },
      {
        name: 'Follow-up Review',
        description: 'Follow-up annotation chips visible in input',
        props: {
          showFollowUps: true,
          followUpCount: 3,
        },
      },
      {
        name: 'Attachments + Follow-ups',
        description: 'Preloaded attachments with follow-up annotation chips visible together',
        props: {
          showAttachments: true,
          attachmentCount: 2,
          showFollowUps: true,
          followUpCount: 3,
        },
      },
      {
        name: 'Disabled',
        description: 'Fully disabled state',
        props: {
          disabled: true,
        },
      },
    ],
  };
