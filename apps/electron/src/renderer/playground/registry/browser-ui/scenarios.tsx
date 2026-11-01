import { type ActivityItem, type ResponseContent } from "@craft-agent/ui";
import { getBrowserLiveFxCornerRadii } from "../../../../shared/browser-live-fx";
import { isLinux, isMac, isWindows } from "@/lib/platform";

export interface BrowserTraceSidebarSampleProps {
  scenario: 'core' | 'all-native-tools' | 'browser-tool-wrapper' | 'full-matrix'
  runState: 'completed' | 'running' | 'failed'
  sidebarWidth: number
  hdrEffect: boolean
  cursorPulse: boolean
}

type RunState = BrowserTraceSidebarSampleProps['runState']

export type Scenario = BrowserTraceSidebarSampleProps['scenario']

export type AgentVisualState = 'idle' | 'active' | 'failed'

export type BrowserSurfaceMode = 'content' | 'empty-state'

const now = Date.now()

export const PLAYGROUND_LIVE_FX_CORNERS = getBrowserLiveFxCornerRadii(
  isMac
    ? 'darwin'
    : isWindows
      ? 'win32'
      : isLinux
        ? 'linux'
        : 'other',
)

const CORE_TURN: ActivityItem[] = [
  {
    id: 'browser-open-1',
    type: 'tool',
    status: 'completed',
    toolName: 'browser_open',
    toolInput: {},
    intent: 'Open in-app browser window',
    timestamp: now - 5000,
  },
  {
    id: 'browser-navigate-1',
    type: 'tool',
    status: 'completed',
    toolName: 'browser_navigate',
    toolInput: { url: 'https://news.ycombinator.com' },
    intent: 'Navigate to Hacker News',
    timestamp: now - 4200,
  },
  {
    id: 'browser-snapshot-1',
    type: 'tool',
    status: 'completed',
    toolName: 'browser_snapshot',
    toolInput: {},
    intent: 'Get accessibility refs for interactive elements',
    timestamp: now - 3500,
  },
  {
    id: 'browser-click-1',
    type: 'tool',
    status: 'completed',
    toolName: 'browser_click',
    toolInput: { ref: '@e12' },
    intent: 'Open top story',
    timestamp: now - 3000,
  },
  {
    id: 'browser-screenshot-1',
    type: 'tool',
    status: 'completed',
    toolName: 'browser_screenshot',
    toolInput: { mode: 'agent', refs: ['@e12'], includeMetadata: true },
    intent: 'Capture agent-mode screenshot with semantic annotation',
    timestamp: now - 2500,
  },
]

const ALL_NATIVE_TOOLS_TURN: ActivityItem[] = [
  { id: 'native-open', type: 'tool', status: 'completed', toolName: 'browser_open', toolInput: {}, intent: 'Open browser window', timestamp: now - 5200 },
  { id: 'native-navigate', type: 'tool', status: 'completed', toolName: 'browser_navigate', toolInput: { url: 'https://example.com' }, intent: 'Navigate to target URL', timestamp: now - 4900 },
  { id: 'native-snapshot', type: 'tool', status: 'completed', toolName: 'browser_snapshot', toolInput: {}, intent: 'Capture a11y tree refs', timestamp: now - 4600 },
  { id: 'native-click', type: 'tool', status: 'completed', toolName: 'browser_click', toolInput: { ref: '@e12' }, intent: 'Click interactive element', timestamp: now - 4300 },
  { id: 'native-fill', type: 'tool', status: 'completed', toolName: 'browser_fill', toolInput: { ref: '@e5', value: 'balint@example.com' }, intent: 'Fill input field', timestamp: now - 4000 },
  { id: 'native-select', type: 'tool', status: 'completed', toolName: 'browser_select', toolInput: { ref: '@e9', value: 'pro' }, intent: 'Select dropdown option', timestamp: now - 3700 },
  { id: 'native-scroll', type: 'tool', status: 'completed', toolName: 'browser_scroll', toolInput: { direction: 'down', amount: 800 }, intent: 'Scroll for more content', timestamp: now - 3400 },
  { id: 'native-back', type: 'tool', status: 'completed', toolName: 'browser_back', toolInput: {}, intent: 'Navigate back in history', timestamp: now - 3100 },
  { id: 'native-forward', type: 'tool', status: 'completed', toolName: 'browser_forward', toolInput: {}, intent: 'Navigate forward in history', timestamp: now - 2800 },
  { id: 'native-evaluate', type: 'tool', status: 'completed', toolName: 'browser_evaluate', toolInput: { expression: 'document.title' }, intent: 'Run JS extraction in page context', timestamp: now - 2500 },
  { id: 'native-screenshot', type: 'tool', status: 'completed', toolName: 'browser_screenshot', toolInput: { mode: 'agent', includeMetadata: true }, intent: 'Capture visual proof with metadata', timestamp: now - 2200 },
]

const WRAPPER_COMMANDS_TURN: ActivityItem[] = [
  { id: 'wrapper-open', type: 'tool', status: 'completed', toolName: 'browser_tool', toolInput: { command: 'open' }, intent: 'Wrapper: open browser', timestamp: now - 4200 },
  { id: 'wrapper-navigate', type: 'tool', status: 'completed', toolName: 'browser_tool', toolInput: { command: 'navigate https://example.com' }, intent: 'Wrapper: navigate to URL', timestamp: now - 3900 },
  { id: 'wrapper-snapshot', type: 'tool', status: 'completed', toolName: 'browser_tool', toolInput: { command: 'snapshot' }, intent: 'Wrapper: list refs', timestamp: now - 3600 },
  { id: 'wrapper-fill', type: 'tool', status: 'completed', toolName: 'browser_tool', toolInput: { command: 'fill @e5 hello@craft.do' }, intent: 'Wrapper: fill text field', timestamp: now - 3300 },
  { id: 'wrapper-click', type: 'tool', status: 'completed', toolName: 'browser_tool', toolInput: { command: 'click @e8' }, intent: 'Wrapper: click target', timestamp: now - 3000 },
  { id: 'wrapper-scroll', type: 'tool', status: 'completed', toolName: 'browser_tool', toolInput: { command: 'scroll down 600' }, intent: 'Wrapper: scroll viewport', timestamp: now - 2700 },
  { id: 'wrapper-evaluate', type: 'tool', status: 'completed', toolName: 'browser_tool', toolInput: { command: 'evaluate document.title' }, intent: 'Wrapper: evaluate expression', timestamp: now - 2400 },
]

export function applyRunState(activities: ActivityItem[], runState: RunState): ActivityItem[] {
  if (runState === 'completed') return activities

  return activities.map((activity, index) => {
    if (runState === 'running' && index === activities.length - 1) {
      return { ...activity, status: 'running' }
    }
    if (runState === 'failed' && index === activities.length - 1) {
      return { ...activity, status: 'error' }
    }
    return { ...activity, status: 'completed' }
  })
}

export function getScenarioTurns(scenario: Scenario): ActivityItem[][] {
  switch (scenario) {
    case 'core':
      return [CORE_TURN]
    case 'all-native-tools':
      return [ALL_NATIVE_TOOLS_TURN]
    case 'browser-tool-wrapper':
      return [WRAPPER_COMMANDS_TURN]
    case 'full-matrix':
      return [ALL_NATIVE_TOOLS_TURN, WRAPPER_COMMANDS_TURN]
    default:
      return [CORE_TURN]
  }
}

export function getScenarioResponse(scenario: Scenario, runState: RunState): ResponseContent {
  if (runState === 'failed') {
    return {
      text: 'One browser action failed in this turn. Verify refs/inputs and retry.',
      isStreaming: false,
    }
  }

  if (runState === 'running') {
    return {
      text: 'Browser action in progress… waiting for completion.',
      isStreaming: true,
    }
  }

  return {
    text: scenario === 'full-matrix'
      ? 'Rendered all native browser_* tools and browser_tool wrapper command flows.'
      : 'Rendered browser tool flow for this scenario.',
    isStreaming: false,
  }
}

function getLiveFxPayload(scenario: Scenario, runState: RunState): { active: boolean; label: string; cursor: { x: number; y: number } | null } {
  if (runState === 'failed') {
    return {
      active: true,
      label: 'Action failed — verify refs and retry',
      cursor: null,
    }
  }

  if (runState === 'running') {
    const cursorByScenario: Record<Scenario, { x: number; y: number } | null> = {
      core: { x: 296, y: 252 },
      'all-native-tools': { x: 426, y: 214 },
      'browser-tool-wrapper': { x: 342, y: 304 },
      'full-matrix': { x: 382, y: 246 },
    }

    return {
      active: true,
      label: 'Craft Agents are working…',
      cursor: cursorByScenario[scenario],
    }
  }

  return {
    active: false,
    label: '',
    cursor: null,
  }
}

export function getLiveFxPayloadFromAgentState(
  scenario: Scenario,
  agentState: AgentVisualState,
): { active: boolean; label: string; cursor: { x: number; y: number } | null } {
  switch (agentState) {
    case 'failed':
      return getLiveFxPayload(scenario, 'failed')
    case 'active':
      return getLiveFxPayload(scenario, 'running')
    case 'idle':
    default:
      return getLiveFxPayload(scenario, 'completed')
  }
}
