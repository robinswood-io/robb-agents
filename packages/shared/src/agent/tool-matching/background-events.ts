/**
 * Stateless tool matching for SDK message → AgentEvent conversion.
 *
 * This module extracts tool_start and tool_result events from SDK message
 * content blocks using DIRECT ID matching instead of FIFO queues.
 *
 * Key principle: Every output is derived from the current message + an
 * append-only tool index. No mutable queues, stacks, or order-dependent state.
 *
 * The SDK provides:
 * - `parent_tool_use_id` on every message — identifies the subagent context (Task ID or null)
 * - `tool_use_id` on each tool_result content block — directly identifies which tool the result is for
 *
 * Together these eliminate the need for FIFO matching, parent stacks, and orphan recovery.
 */
import type { AgentEvent } from "@craft-agent/core/types";
import { isParentTaskTool } from "../../utils/toolNames.ts";
import type { ToolEntry } from './transcript.ts';
import { parseWorkflowIdFromTranscriptPath } from './transcript.ts';

/** Detect background task/shell events from tool results */
export function detectBackgroundEvents(
  toolUseId: string,
  entry: ToolEntry,
  resultStr: string,
  isError: boolean,
  turnId?: string,
): AgentEvent[] {
  const events: AgentEvent[] = [];

  // Background Task detection — Task/Agent tool with agentId in result.
  //
  // Two launch shapes both produce a real background agent:
  //  1. Explicit `run_in_background: true` in the tool input.
  //  2. Async-by-default: the SDK backgrounds the Agent/Task automatically and
  //     returns a launch acknowledgement WITHOUT the caller ever setting
  //     `run_in_background`. That result has a distinctive signature — an
  //     `agentId:` plus "working in the background" / `output_file:` /
  //     "Async agent launched" — which lets us detect it safely.
  //
  // The signature requirement is what prevents false positives: a *foreground*
  // Agent whose result text merely mentions "agentId:" (e.g. quoting a value it
  // found) has neither the background phrasing nor an output_file, so it is not
  // marked backgrounded. This mirrors the renderer's signature check in
  // App.tsx (`isBackgroundingResult`). For both shapes a real task_completed
  // notification eventually arrives; the WS3 registry + turn-end orphan backstop
  // cover the case where it does not.
  const wasRunInBackground = entry.input?.["run_in_background"] === true;
  const looksAsyncLaunched =
    /agentId:\s*[a-zA-Z0-9_-]+/.test(resultStr) &&
    (/working in the background/i.test(resultStr) ||
      /output_file:/i.test(resultStr) ||
      /async agent launched/i.test(resultStr));
  if (isParentTaskTool(entry.name) && (wasRunInBackground || looksAsyncLaunched) && !isError && resultStr) {
    const agentIdMatch = resultStr.match(/agentId:\s*([a-zA-Z0-9_-]+)/);
    if (agentIdMatch?.[1]) {
      // Prefer explicit `_intent` metadata; the built-in Agent/Task tool doesn't
      // set it, so fall back to its concise `description` param (the "3-5 word
      // description of the task") — this is what the chip shows instead of the
      // opaque agent ID. Mirrors the Bash background-shell path below.
      const intentValue = (typeof entry.input["_intent"] === 'string' && entry.input["_intent"])
        || (typeof entry.input["description"] === 'string' && entry.input["description"])
        || undefined;
      events.push({
        type: 'task_backgrounded',
        toolUseId,
        taskId: agentIdMatch[1],
        ...(turnId !== undefined ? { turnId } : {}),
        ...(intentValue && { intent: intentValue }),
      });
    }
  }

  // Background Shell detection — Bash tool with shell_id or backgroundTaskId
  if (entry.name === 'Bash' && !isError && resultStr) {
    const shellIdMatch = resultStr.match(/shell_id:\s*([a-zA-Z0-9_-]+)/)
      || resultStr.match(/"backgroundTaskId":\s*"([a-zA-Z0-9_-]+)"/);
    if (shellIdMatch?.[1]) {
      const intentValue = (typeof entry.input["_intent"] === 'string' && entry.input["_intent"])
        || (typeof entry.input["description"] === 'string' && entry.input["description"])
        || undefined;
      const commandValue = typeof entry.input["command"] === 'string' ? entry.input["command"] : undefined;
      events.push({
        type: 'shell_backgrounded',
        toolUseId,
        shellId: shellIdMatch[1],
        ...(turnId !== undefined ? { turnId } : {}),
        ...(intentValue && { intent: intentValue }),
        ...(commandValue && { command: commandValue }),
      });
    }
  }

  // Background Workflow detection — the Workflow tool always launches in the
  // background and returns immediately. Its result has a distinct signature:
  //   "Workflow launched in background. Task ID: <id>\nSummary: <...>\nTranscript
  //    dir: .../workflows/wf_XXX"
  // It is NOT a parent-task tool and its result lacks the async-agent signature
  // (agentId/output_file), so it needs its own detector. We surface it as a
  // background task with kind 'workflow' + the workflow run id (wf_XXX, parsed
  // from the transcript dir) so SubagentStop events can attribute completed
  // agents to this chip (see parseWorkflowIdFromTranscriptPath).
  if (entry.name === 'Workflow' && !isError && resultStr) {
    const taskIdMatch = resultStr.match(/Workflow launched in background\.?\s*Task ID:\s*(\S+)/i);
    if (taskIdMatch?.[1]) {
      const summaryMatch = resultStr.match(/Summary:\s*(.+)/);
      const workflowId = parseWorkflowIdFromTranscriptPath(resultStr);
      const intentValue = (typeof entry.input["_intent"] === 'string' && entry.input["_intent"])
        || (summaryMatch?.[1]?.trim())
        || undefined;
      events.push({
        type: 'task_backgrounded',
        toolUseId,
        taskId: taskIdMatch[1],
        ...(turnId !== undefined ? { turnId } : {}),
        kind: 'workflow',
        ...(intentValue && { intent: intentValue }),
        ...(workflowId && { workflowId }),
      });
    }
  }

  // Shell killed detection — KillShell tool
  if (entry.name === 'KillShell') {
    const shellId = entry.input["shell_id"] as string;
    if (shellId) {
      events.push({
        type: 'shell_killed',
        shellId,
        ...(turnId !== undefined ? { turnId } : {}),
      });
    }
  }

  return events;
}
