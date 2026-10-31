/** Playground entries; scenario data and preview components are kept in adjacent sections. */
import "react";
import type { ComponentEntry } from "./types";
import "@craft-agent/ui";
import "motion/react";
import "@/components/browser/BrowserTabStrip";
import "@/components/browser/empty-state-prompts";
import "../../../shared/browser-live-fx";
import "../../../shared/routes";
import "@/lib/platform";
import "./browser-ui/scenarios";
import { BrowserFramePlayground, BrowserEmptyStatePlayground } from "./browser-ui/surface";
import "./browser-ui/tab-presets";
import { BrowserTabStripPlayground } from "./browser-ui/tabs";

export const browserUiComponents: ComponentEntry[] = [
  {
    id: 'browser-frame-playground',
    name: 'Browser Frame (Dedicated Controls)',
    category: 'Browser',
    description: 'Dedicated always-visible browser controls frame for iterating visual design before wiring to native window.',
    component: BrowserFramePlayground,
    layout: 'top',
    props: [
      {
        name: 'initialUrl',
        description: 'Initial URL value shown in the address field.',
        control: { type: 'string' },
        defaultValue: 'https://www.iana.org/help',
      },
      {
        name: 'loading',
        description: 'Website loading state only (URL bar spinner + Stop/Reload).',
        control: { type: 'boolean' },
        defaultValue: false,
      },


      {
        name: 'agentState',
        description: 'Agent activity state only (independent from website loading).',
        control: {
          type: 'select',
          options: [
            { label: 'Idle', value: 'idle' },
            { label: 'Active', value: 'active' },
            { label: 'Failed', value: 'failed' },
          ],
        },
        defaultValue: 'idle',
      },
      {
        name: 'themeColor',
        description: 'Website theme color (hex). Simulates <meta name="theme-color">.',
        control: {
          type: 'select',
          options: [
            { label: 'None', value: '' },
            { label: 'Google Blue (#4285f4)', value: '#4285f4' },
            { label: 'GitHub Dark (#24292e)', value: '#1e2327' },
            { label: 'Stripe Purple (#635bff)', value: '#635bff' },
            { label: 'Slack (#4a154b)', value: '#4a154b' },
            { label: 'Linear (#5e6ad2)', value: 'lch(96.667% 0 282.863 / 1)' },
            { label: 'Twitter/X (#15202b)', value: '#15202b' },
            { label: 'YouTube Red (#ff0000)', value: '#ff0000' },
            { label: 'Light Gray (#f5f5f5)', value: '#f5f5f5' },
            { label: 'White (#ffffff)', value: '#ffffff' },
          ],
        },
        defaultValue: '',
      },
      {
        name: 'surfaceMode',
        description: 'Switch between generic mock page content and the new browser onboarding empty state.',
        control: {
          type: 'select',
          options: [
            { label: 'Empty State', value: 'empty-state' },
            { label: 'Mock Content', value: 'content' },
          ],
        },
        defaultValue: 'empty-state',
      },
      {
        name: 'emptyStateTitle',
        description: 'Main heading shown in the browser empty state.',
        control: { type: 'string' },
        defaultValue: 'This browser is ready for your Agents - and you ;)',
      },
      {
        name: 'emptyStateDescription',
        description: 'Body copy describing how sessions can use this browser window.',
        control: { type: 'string' },
        defaultValue: 'Ask any session to use this browser (or open another one) to complete tasks like research, form filling, QA checks, or data extraction.',
      },
      {
        name: 'showExamplePrompts',
        description: 'Show quick prompt chips that demonstrate browser automation requests.',
        control: { type: 'boolean' },
        defaultValue: true,
      },
      {
        name: 'showSafetyHint',
        description: 'Show a small trust hint explaining that browser control is user-triggered.',
        control: { type: 'boolean' },
        defaultValue: true,
      },

    ],
  },
  {
    id: 'browser-empty-state-playground',
    name: 'Browser Empty State (Agent Guidance)',
    category: 'Browser',
    description: 'Focused preview of the first-load browser empty state message for copy and visual iteration.',
    component: BrowserEmptyStatePlayground,
    layout: 'top',
    props: [
      {
        name: 'title',
        description: 'Main heading for the empty state card.',
        control: { type: 'string' },
        defaultValue: 'This browser is ready for your Agents - and you ;)',
      },
      {
        name: 'description',
        description: 'Explanatory copy shown under the title.',
        control: { type: 'string' },
        defaultValue: 'Ask any session to use this browser (or open another one) to complete tasks like research, form filling, QA checks, or data extraction.',
      },
      {
        name: 'showExamplePrompts',
        description: 'Show quick prompt examples for common browser workflows.',
        control: { type: 'boolean' },
        defaultValue: true,
      },
      {
        name: 'showSafetyHint',
        description: 'Show a subtle note that browser control happens only when requested.',
        control: { type: 'boolean' },
        defaultValue: true,
      },
    ],
  },
  {
    id: 'browser-tab-strip-playground',
    name: 'Browser Tab Strip (Top Bar)',
    category: 'Browser',
    description: 'Live BrowserTabStrip used in the main top bar, including global registry and agent-control accent border.',
    component: BrowserTabStripPlayground,
    props: [
      {
        name: 'mode',
        description: 'Auto: use live in Electron and mock in plain browser. Live: force bridge usage. Mock: always show sample badges.',
        control: {
          type: 'select',
          options: [
            { label: 'Auto', value: 'auto' },
            { label: 'Live', value: 'live' },
            { label: 'Mock', value: 'mock' },
          ],
        },
        defaultValue: 'mock',
      },
      {
        name: 'mockPreset',
        description: 'Mock state bundle for visual QA: long names, multiple running tabs, hidden tabs, and agent-controlled accents.',
        control: {
          type: 'select',
          options: [
            { label: 'Default', value: 'default' },
            { label: 'Long Names', value: 'long-names' },
            { label: 'Many Running', value: 'many-running' },
            { label: 'Stress Mix', value: 'stress-mix' },
          ],
        },
        defaultValue: 'stress-mix',
      },
      {
        name: 'activeSessionId',
        description: 'Session used for ordering preference (session-local windows first) in both live and mock modes.',
        control: { type: 'string', placeholder: '260228-high-comet' },
        defaultValue: '260228-high-comet',
      },
    ],
  },

]
