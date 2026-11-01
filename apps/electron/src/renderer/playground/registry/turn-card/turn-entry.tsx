import type { ComponentEntry } from "../types";
import { TurnCard } from "@craft-agent/ui";
import { PaddedWrapper } from "./streaming";
import { runningGrepActivity, completedGrepActivity, runningReadActivity, pendingActivity, completedReadActivity1, completedReadActivity2, streamingResponse, emptyStreamingResponse, shortResponse, completedBashActivity, longResponse, errorActivity, manyActivities75, intermediateMessage1, intermediateMessage2, intermediateMessage3, intermediateMessageRunning, intermediateMessageStreaming, todosAllPending, todosInProgress, todosMixed, todosAlmostDone, todosAllCompleted, todosLong } from "./turn-fixtures";

// ============================================================================
// Component Entry
// ============================================================================

export const turnCardEntry: ComponentEntry = {
    id: 'turn-card',
    name: 'TurnCard',
    category: 'Turn Cards',
    description: 'Email-like batched display for one assistant turn with activities and response',
    component: TurnCard,
    wrapper: PaddedWrapper,
    layout: 'top',
    props: [
      {
        name: 'isStreaming',
        description: 'Whether content is still being received',
        control: { type: 'boolean' },
        defaultValue: false,
      },
      {
        name: 'isComplete',
        description: 'Whether this turn is fully complete',
        control: { type: 'boolean' },
        defaultValue: true,
      },
      {
        name: 'defaultExpanded',
        description: 'Start with activities expanded',
        control: { type: 'boolean' },
        defaultValue: false,
      },
      {
        name: 'intent',
        description: 'Primary intent/goal for preview text',
        control: { type: 'string', placeholder: 'e.g., Searching for auth handlers...' },
        defaultValue: '',
      },
    ],
    variants: [
      // Initial / Empty state
      {
        name: 'Initial (Starting)',
        description: 'No activities yet, just starting',
        props: {
          activities: [],
          response: undefined,
          isStreaming: true,
          isComplete: false,
        },
      },
      // Single tool running
      {
        name: 'Single Tool Running',
        description: 'One tool currently executing',
        props: {
          activities: [runningGrepActivity],
          response: undefined,
          isStreaming: true,
          isComplete: false,
          intent: 'Finding error handling patterns',
        },
      },
      // Multiple tools running
      {
        name: 'Multiple Tools Running',
        description: 'Several tools executing in parallel',
        props: {
          activities: [
            { ...completedGrepActivity, status: 'completed' },
            runningReadActivity,
            pendingActivity,
          ],
          response: undefined,
          isStreaming: true,
          isComplete: false,
        },
      },
      // All tools completed (collapsed)
      {
        name: 'Tools Completed (Collapsed)',
        description: 'Multiple tools finished, collapsed by default',
        props: {
          activities: [
            completedGrepActivity,
            completedReadActivity1,
            completedReadActivity2,
          ],
          response: undefined,
          isStreaming: false,
          isComplete: false,
        },
      },
      // Tools completed, now streaming response
      {
        name: 'Streaming Response',
        description: 'Tools done, response is streaming',
        props: {
          activities: [
            completedGrepActivity,
            completedReadActivity1,
          ],
          response: streamingResponse,
          isStreaming: true,
          isComplete: false,
        },
      },
      // Waiting for response (empty streaming)
      {
        name: 'Waiting for Response',
        description: 'Tools done, waiting for response to start',
        props: {
          activities: [
            completedGrepActivity,
            completedReadActivity1,
          ],
          response: emptyStreamingResponse,
          isStreaming: true,
          isComplete: false,
        },
      },
      // Complete turn with short response
      {
        name: 'Complete (Short)',
        description: 'Finished turn with brief response',
        props: {
          activities: [
            completedGrepActivity,
            completedReadActivity1,
            completedReadActivity2,
          ],
          response: shortResponse,
          isStreaming: false,
          isComplete: true,
        },
      },
      // Complete turn with long response
      {
        name: 'Complete (Long)',
        description: 'Finished turn with detailed response',
        props: {
          activities: [
            completedGrepActivity,
            completedReadActivity1,
            completedReadActivity2,
            completedBashActivity,
          ],
          response: longResponse,
          isStreaming: false,
          isComplete: true,
          intent: 'Analyzing authentication system',
        },
      },
      // Error state
      {
        name: 'Error State',
        description: 'A tool failed during execution',
        props: {
          activities: [
            completedGrepActivity,
            completedReadActivity1,
            errorActivity,
          ],
          response: undefined,
          isStreaming: false,
          isComplete: false,
          defaultExpanded: true,
        },
      },
      // Response only (no tools)
      {
        name: 'Response Only',
        description: 'Direct response without tool usage',
        props: {
          activities: [],
          response: shortResponse,
          isStreaming: false,
          isComplete: true,
        },
      },
      // Many tools
      {
        name: 'Many Tools (5+)',
        description: 'Large number of completed tools',
        props: {
          activities: [
            completedGrepActivity,
            completedReadActivity1,
            completedReadActivity2,
            completedBashActivity,
            { ...completedReadActivity1, id: 'tool-5', toolInput: { file_path: '/src/config.ts' } },
            { ...completedReadActivity1, id: 'tool-6', toolInput: { file_path: '/src/utils.ts' } },
          ],
          response: shortResponse,
          isStreaming: false,
          isComplete: true,
        },
      },
      // Extreme: 75 steps (real-world stress test)
      {
        name: 'Extreme: 75 Steps',
        description: 'Stress test with 75 activities - tests scrolling, animation limits, and performance',
        props: {
          activities: manyActivities75,
          response: longResponse,
          isStreaming: false,
          isComplete: true,
          defaultExpanded: true,
          intent: 'Comprehensive codebase analysis',
        },
      },
      // Expanded by default
      {
        name: 'Expanded (Default)',
        description: 'Activities shown expanded initially',
        props: {
          activities: [
            completedGrepActivity,
            completedReadActivity1,
            completedReadActivity2,
          ],
          response: shortResponse,
          isStreaming: false,
          isComplete: true,
          defaultExpanded: true,
        },
      },
      // Mixed: Tools with intermediate messages (completed)
      {
        name: 'Mixed: Tools + Commentary',
        description: 'Tools interleaved with LLM intermediate messages',
        props: {
          activities: [
            intermediateMessage1,
            completedGrepActivity,
            intermediateMessage2,
            completedReadActivity1,
            intermediateMessage3,
            completedReadActivity2,
          ],
          response: shortResponse,
          isStreaming: false,
          isComplete: true,
          defaultExpanded: true,
        },
      },
      // Mixed: In progress with commentary
      {
        name: 'Mixed: In Progress',
        description: 'Tool running after intermediate message',
        props: {
          activities: [
            intermediateMessage1,
            completedGrepActivity,
            intermediateMessage2,
            completedReadActivity1,
            intermediateMessageRunning,
            runningReadActivity,
          ],
          response: undefined,
          isStreaming: true,
          isComplete: false,
        },
      },
      // Mixed: Many steps
      {
        name: 'Mixed: Long Chain',
        description: 'Extended conversation with multiple tool/message pairs',
        props: {
          activities: [
            intermediateMessage1,
            completedGrepActivity,
            intermediateMessage2,
            completedReadActivity1,
            intermediateMessage3,
            completedReadActivity2,
            intermediateMessageRunning,
            completedBashActivity,
          ],
          response: longResponse,
          isStreaming: false,
          isComplete: true,
          defaultExpanded: true,
        },
      },
      // Mixed: Commentary only (no tools yet)
      {
        name: 'Mixed: Thinking Start',
        description: 'LLM thinking before first tool call',
        props: {
          activities: [
            intermediateMessage1,
          ],
          response: undefined,
          isStreaming: true,
          isComplete: false,
        },
      },
      // Mixed: Currently thinking (streaming intermediate)
      {
        name: 'Mixed: Currently Thinking',
        description: 'LLM is streaming an intermediate message',
        props: {
          activities: [
            intermediateMessage1,
            completedGrepActivity,
            intermediateMessage2,
            completedReadActivity1,
            intermediateMessageStreaming,
          ],
          response: undefined,
          isStreaming: true,
          isComplete: false,
          defaultExpanded: true,
        },
      },
      // ========== TodoWrite Variants ==========
      // Todo: Just started (all pending)
      {
        name: 'Todo: Just Started',
        description: 'TodoWrite with all items pending - just created the plan',
        props: {
          activities: [completedGrepActivity],
          response: undefined,
          isStreaming: false,
          isComplete: false,
          defaultExpanded: true,
          todos: todosAllPending,
        },
      },
      // Todo: In progress
      {
        name: 'Todo: In Progress',
        description: 'TodoWrite with one item in progress',
        props: {
          activities: [completedGrepActivity, completedReadActivity1],
          response: undefined,
          isStreaming: true,
          isComplete: false,
          defaultExpanded: true,
          todos: todosInProgress,
        },
      },
      // Todo: Mixed progress
      {
        name: 'Todo: Mixed Progress',
        description: 'TodoWrite with mixed completed/in_progress/pending items',
        props: {
          activities: [completedGrepActivity, completedReadActivity1, completedBashActivity],
          response: shortResponse,
          isStreaming: false,
          isComplete: true,
          defaultExpanded: true,
          todos: todosMixed,
        },
      },
      // Todo: Almost done
      {
        name: 'Todo: Almost Done',
        description: 'TodoWrite with most items completed, one in progress',
        props: {
          activities: [completedGrepActivity, completedReadActivity1],
          response: undefined,
          isStreaming: true,
          isComplete: false,
          defaultExpanded: true,
          todos: todosAlmostDone,
        },
      },
      // Todo: All completed
      {
        name: 'Todo: All Completed',
        description: 'TodoWrite with all items done - task complete',
        props: {
          activities: [completedGrepActivity, completedReadActivity1, completedBashActivity],
          response: longResponse,
          isStreaming: false,
          isComplete: true,
          defaultExpanded: true,
          todos: todosAllCompleted,
        },
      },
      // Todo: Long list (stress test)
      {
        name: 'Todo: Long List (12 items)',
        description: 'TodoWrite stress test with many items',
        props: {
          activities: [completedGrepActivity, completedReadActivity1],
          response: shortResponse,
          isStreaming: false,
          isComplete: true,
          defaultExpanded: true,
          todos: todosLong,
        },
      },
      // Todo: Only (no activities/response)
      {
        name: 'Todo: Standalone',
        description: 'TodoWrite without activities or response - planning phase only',
        props: {
          activities: [],
          response: undefined,
          isStreaming: false,
          isComplete: false,
          defaultExpanded: true,
          todos: todosMixed,
        },
      },
    ],
    mockData: () => ({
      activities: [
        completedGrepActivity,
        completedReadActivity1,
        completedReadActivity2,
      ],
      response: shortResponse,
      onOpenFile: (path: string) => console.log('[Playground] Open file:', path),
      onOpenUrl: (url: string) => console.log('[Playground] Open URL:', url),
    }),
  };
