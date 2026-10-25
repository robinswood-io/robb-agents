/** Playground entries; scenario data and preview components are kept in adjacent sections. */
import "react";
import type { ComponentEntry } from "./types";
import "@/components/automations/AutomationsListPanel";
import "@/components/automations/AutomationInfoPage";
import "@/components/automations/AutomationCard";
import "@/components/automations/AutomationAvatar";
import "@/components/automations/CronBuilder";
import { AutomationTestPanel } from "@/components/automations/AutomationTestPanel";
import { AutomationEventTimeline } from "@/components/automations/AutomationEventTimeline";
import "@/components/automations/types";
import { AutomationsListPanelPlayground, AutomationInfoPagePlayground, AutomationCardPlayground, PaddedWrapper, CronBuilderPlayground, AutomationAvatarGallery } from "./automations/previews";
import { mockAutomations, mockExecutions, testResultRunning, testResultSuccess, testResultError, mockWebhookExecutions } from "./automations/fixtures";

// ============================================================================
// Registry Entries
// ============================================================================

export const automationComponents: ComponentEntry[] = [
  // ==========================================================================
  // AutomationsListPanel
  // ==========================================================================
  {
    id: 'automations-list-panel',
    name: 'AutomationsListPanel',
    category: 'Automations',
    description: 'Navigator panel with automation list, filters, and contextual actions',
    component: AutomationsListPanelPlayground,
    layout: 'full',
    props: [
      {
        name: 'selectedAutomationId',
        description: 'Currently selected automation ID',
        control: { type: 'string', placeholder: 'e.g., automation-1' },
        defaultValue: null,
      },
    ],
    variants: [
      {
        name: 'Default (All)',
        description: '8 automations with mixed states',
        props: { automations: mockAutomations, selectedAutomationId: 'automation-1' },
      },
      {
        name: 'Empty State',
        description: 'No automations configured',
        props: { automations: [], selectedAutomationId: null },
      },
      {
        name: 'Few Items (3)',
        description: 'Small list without scrolling',
        props: { automations: mockAutomations.slice(0, 3), selectedAutomationId: null },
      },
      {
        name: 'With Selection',
        description: 'Second automation selected',
        props: { automations: mockAutomations, selectedAutomationId: 'automation-2' },
      },
      {
        name: 'Mixed Enabled/Disabled',
        description: 'Shows disabled automations dimmed',
        props: {
          automations: mockAutomations.map((h, i) => ({ ...h, enabled: i % 2 === 0 })),
          selectedAutomationId: null,
        },
      },
    ],
    mockData: () => ({
      automations: mockAutomations,
    }),
  },

  // ==========================================================================
  // AutomationInfoPage
  // ==========================================================================
  {
    id: 'automation-info-page',
    name: 'AutomationInfoPage',
    category: 'Automations',
    description: 'Detail view using Info_Page with When/Then/Settings sections',
    component: AutomationInfoPagePlayground,
    layout: 'full',
    props: [],
    variants: [
      {
        name: 'Scheduled',
        description: 'Recurring schedule with timezone and upcoming runs',
        props: { automation: mockAutomations[0], executions: mockExecutions.filter(e => e.automationId === 'automation-1') },
      },
      {
        name: 'Label Event',
        description: 'Triggered when a label is added, with filter and prompt',
        props: { automation: mockAutomations[1], executions: mockExecutions.filter(e => e.automationId === 'automation-2') },
      },
      {
        name: 'Before Tool Runs (Disabled)',
        description: 'Pre-tool automation with filter, showing disabled state warning',
        props: { automation: mockAutomations[2], executions: mockExecutions.filter(e => e.automationId === 'automation-3') },
      },
      {
        name: 'Multiple Prompts',
        description: 'Automation with multiple prompt actions',
        props: { automation: mockAutomations[4], executions: mockExecutions.filter(e => e.automationId === 'automation-5') },
      },
      {
        name: 'Session Start',
        description: 'Prompt automation with @mentions and labels',
        props: { automation: mockAutomations[6], executions: [] },
      },
      {
        name: 'Error Handler',
        description: 'Runs when a tool fails',
        props: { automation: mockAutomations[7], executions: [] },
      },
      {
        name: 'With Conditions (Status + State)',
        description: 'SessionStatusChange with time and state conditions (If section visible)',
        props: { automation: mockAutomations[8], executions: [] },
      },
      {
        name: 'With Conditions (Weekday)',
        description: 'SchedulerTick with weekday time condition (If section visible)',
        props: { automation: mockAutomations[9], executions: [] },
      },
      {
        name: 'With Full History',
        description: 'All 6 execution entries visible',
        props: { automation: mockAutomations[0], executions: mockExecutions },
      },
    ],
    mockData: () => ({
      automation: mockAutomations[0],
      executions: mockExecutions,
    }),
  },

  // ==========================================================================
  // AutomationCard
  // ==========================================================================
  {
    id: 'automation-card',
    name: 'AutomationCard',
    category: 'Automations',
    description: 'Expandable inline row with trigger/action preview',
    component: AutomationCardPlayground,
    wrapper: PaddedWrapper,
    layout: 'top',
    props: [
      {
        name: 'defaultExpanded',
        description: 'Start expanded',
        control: { type: 'boolean' },
        defaultValue: false,
      },
    ],
    variants: [
      {
        name: 'Collapsed',
        description: 'Default collapsed state',
        props: { automation: mockAutomations[0], defaultExpanded: false },
      },
      {
        name: 'Expanded',
        description: 'Expanded with trigger and action details',
        props: { automation: mockAutomations[0], defaultExpanded: true },
      },
      {
        name: 'Disabled',
        description: 'Disabled automation (dimmed)',
        props: { automation: mockAutomations[2], defaultExpanded: true },
      },
      {
        name: 'Event-triggered',
        description: 'Automation triggered by an event',
        props: { automation: mockAutomations[1], defaultExpanded: true },
      },
      {
        name: 'Multiple Prompts',
        description: 'Automation with multiple prompt actions',
        props: { automation: mockAutomations[4], defaultExpanded: true },
      },
    ],
    mockData: () => ({
      automation: mockAutomations[0],
    }),
  },

  // ==========================================================================
  // CronBuilder
  // ==========================================================================
  {
    id: 'cron-builder',
    name: 'CronBuilder',
    category: 'Automations',
    description: 'Visual schedule builder with common presets and custom timing',
    component: CronBuilderPlayground,
    wrapper: PaddedWrapper,
    layout: 'top',
    props: [
      {
        name: 'timezone',
        description: 'IANA timezone',
        control: { type: 'string', placeholder: 'e.g., Europe/Budapest' },
        defaultValue: 'Europe/Budapest',
      },
    ],
    variants: [
      {
        name: 'Weekdays at 9am',
        description: 'Common work schedule',
        props: { initialValue: '0 9 * * 1-5', timezone: 'Europe/Budapest' },
      },
      {
        name: 'Every 15 Minutes',
        description: 'High-frequency schedule',
        props: { initialValue: '*/15 * * * *', timezone: 'UTC' },
      },
      {
        name: 'Daily at Midnight',
        description: 'Nightly batch job',
        props: { initialValue: '0 0 * * *', timezone: 'America/New_York' },
      },
      {
        name: 'Monthly on 1st',
        description: 'Monthly report schedule',
        props: { initialValue: '30 14 1 * *', timezone: 'Europe/London' },
      },
      {
        name: 'Every Minute',
        description: 'Maximum frequency',
        props: { initialValue: '* * * * *' },
      },
    ],
    mockData: () => ({
      initialValue: '0 9 * * 1-5',
      timezone: 'Europe/Budapest',
    }),
  },

  // ==========================================================================
  // AutomationAvatar Gallery
  // ==========================================================================
  {
    id: 'automation-avatar',
    name: 'AutomationAvatar',
    category: 'Automations',
    description: 'Event-categorized icons with size and color variants',
    component: AutomationAvatarGallery,
    wrapper: PaddedWrapper,
    layout: 'top',
    props: [],
    variants: [],
    mockData: () => ({}),
  },

  // ==========================================================================
  // AutomationTestPanel
  // ==========================================================================
  {
    id: 'automation-test-panel',
    name: 'AutomationTestPanel',
    category: 'Automations',
    description: 'Test execution result states (success, error, running)',
    component: AutomationTestPanel,
    wrapper: PaddedWrapper,
    layout: 'top',
    props: [],
    variants: [
      {
        name: 'Running',
        description: 'Test in progress with spinner',
        props: { result: testResultRunning },
      },
      {
        name: 'Success',
        description: 'Successful test with duration',
        props: { result: testResultSuccess },
      },
      {
        name: 'Error',
        description: 'Failed test with stderr',
        props: { result: testResultError },
      },
    ],
    mockData: () => ({
      result: testResultSuccess,
    }),
  },

  // ==========================================================================
  // AutomationEventTimeline
  // ==========================================================================
  {
    id: 'automation-event-timeline',
    name: 'AutomationEventTimeline',
    category: 'Automations',
    description: 'Execution history with status, time, event, and duration',
    component: AutomationEventTimeline,
    wrapper: PaddedWrapper,
    layout: 'top',
    props: [],
    variants: [
      {
        name: 'Mixed Results',
        description: 'Success, error, and blocked entries (prompt + webhook)',
        props: { entries: mockExecutions },
      },
      {
        name: 'Webhook Only',
        description: 'Webhook entries with expandable details (click to expand)',
        props: { entries: mockWebhookExecutions },
      },
      {
        name: 'Webhook Error with Retry',
        description: 'Failed webhook with retry button and expandable details',
        props: {
          entries: mockWebhookExecutions.filter(e => e.status === 'error'),
          onReplay: (automationId: string, event: string) => console.log('[Playground] Replay:', automationId, event),
        },
      },
      {
        name: 'All Success',
        description: 'All executions successful',
        props: {
          entries: mockExecutions
            .filter(e => e.status === 'success')
            .map((e, i) => ({ ...e, id: `success-${i}` })),
        },
      },
      {
        name: 'Empty',
        description: 'No executions yet',
        props: { entries: [] },
      },
    ],
    mockData: () => ({
      entries: mockExecutions,
    }),
  },
]
