import { omitUndefined } from '@craft-agent/shared/utils/json';


import { backgroundTasksAtomFamily, type BackgroundTask } from '@/atoms/sessions';

import { getDefaultStore } from 'jotai';

export type AppState = 'loading' | 'onboarding' | 'reauth' | 'workspace-picker' | 'ready'

export type JotaiStore = ReturnType<typeof getDefaultStore>

export type SessionListRefreshOptions = {
  removeMissing?: boolean
  reason?: string
  selectedSessionId?: string | null
}

export const SESSION_REFRESH_LOG_ID_LIMIT = 25

export function summarizeIds(ids: Iterable<string>, limit = SESSION_REFRESH_LOG_ID_LIMIT) {
  const all = Array.from(ids)
  return {
    count: all.length,
    ids: all.slice(0, limit),
    truncated: all.length > limit,
  }
}

export function workspaceDistribution(sessions: Iterable<{ workspaceId?: string }>): Record<string, number> {
  const distribution: Record<string, number> = {}
  for (const session of sessions) {
    const key = session.workspaceId || '(missing)'
    distribution[key] = (distribution[key] ?? 0) + 1
  }
  return distribution
}

export function handleBackgroundTaskEvent(
  store: JotaiStore,
  sessionId: string,
  event: { type: string },
  agentEvent: unknown
): void {
  // Type guard for accessing properties
  const evt = agentEvent as Record<string, unknown>
  const backgroundTasksAtom = backgroundTasksAtomFamily(sessionId)

  if (event.type === 'task_backgrounded' && 'taskId' in evt && 'toolUseId' in evt) {
    const currentTasks = store.get(backgroundTasksAtom)
    const exists = currentTasks.some(t => t.toolUseId === evt["toolUseId"])
    if (!exists) {
      const isWorkflow = evt["kind"] === 'workflow'
      store.set(backgroundTasksAtom, [
        ...currentTasks,
        omitUndefined<BackgroundTask>({
          id: evt["taskId"] as string,
          type: isWorkflow ? ('workflow' as const) : ('agent' as const),
          toolUseId: evt["toolUseId"] as string,
          startTime: Date.now(),
          elapsedSeconds: 0,
          intent: evt["intent"] as string | undefined,
          status: 'running' as const,
          ...(isWorkflow ? { workflowId: evt["workflowId"] as string | undefined, agentsCompleted: 0 } : {}),
        }),
      ])
    }
  } else if (event.type === 'workflow_agent_completed' && 'workflowId' in evt) {
    // One sub-agent of a running Workflow finished — bump the owning chip's count.
    const currentTasks = store.get(backgroundTasksAtom)
    store.set(backgroundTasksAtom, currentTasks.map(t =>
      t.type === 'workflow' && t.workflowId === evt["workflowId"]
        ? { ...t, agentsCompleted: (t.agentsCompleted ?? 0) + 1 }
        : t
    ))
  } else if (event.type === 'shell_backgrounded' && 'shellId' in evt && 'toolUseId' in evt) {
    const currentTasks = store.get(backgroundTasksAtom)
    const exists = currentTasks.some(t => t.toolUseId === evt["toolUseId"])
    if (!exists) {
      store.set(backgroundTasksAtom, [
        ...currentTasks,
        omitUndefined<BackgroundTask>({
          id: evt["shellId"] as string,
          type: 'shell' as const,
          toolUseId: evt["toolUseId"] as string,
          startTime: Date.now(),
          elapsedSeconds: 0,
          intent: evt["intent"] as string | undefined,
          status: 'running' as const,
        }),
      ])
    }
  } else if (event.type === 'task_progress' && 'toolUseId' in evt && 'elapsedSeconds' in evt) {
    const currentTasks = store.get(backgroundTasksAtom)
    store.set(backgroundTasksAtom, currentTasks.map(t =>
      t.toolUseId === evt["toolUseId"]
        ? { ...t, elapsedSeconds: evt["elapsedSeconds"] as number }
        : t
    ))
  } else if (event.type === 'task_completed' && 'taskId' in evt) {
    // Transition the chip to a terminal status (keep it visible with a terminal
    // icon + click-through to output). The ActiveTasksBar auto-expiry ticker
    // prunes it after a short linger — we no longer remove it instantly, so the
    // user sees that the task finished rather than the chip just vanishing.
    const status = (evt["status"] as BackgroundTask['status']) ?? 'completed'
    const currentTasks = store.get(backgroundTasksAtom)
    store.set(backgroundTasksAtom, currentTasks.map(t =>
      t.id === evt["taskId"]
        ? omitUndefined({
            ...t,
            status,
            completedAt: Date.now(),
            outputFile: (evt["outputFile"] as string | undefined) ?? t.outputFile,
            summary: (evt["summary"] as string | undefined) ?? t.summary,
          })
        : t
    ))
  } else if (event.type === 'shell_killed' && 'shellId' in evt) {
    // Mark shell stopped (lingers briefly, then auto-expires) instead of vanishing.
    const currentTasks = store.get(backgroundTasksAtom)
    store.set(backgroundTasksAtom, currentTasks.map(t =>
      t.id === evt["shellId"]
        ? { ...t, status: 'stopped' as const, completedAt: Date.now() }
        : t
    ))
  } else if (event.type === 'tool_result' && 'toolUseId' in evt) {
    // Remove task when it completes - but NOT if this is the initial backgrounding result
    // Background tasks return immediately with agentId/shell_id/backgroundTaskId,
    // we should only remove when the task actually completes
    const result = typeof evt["result"] === 'string' ? evt["result"] : JSON.stringify(evt["result"])
    const isBackgroundingResult = result && (
      /agentId:\s*[a-zA-Z0-9_-]+/.test(result) ||
      /shell_id:\s*[a-zA-Z0-9_-]+/.test(result) ||
      /"backgroundTaskId":\s*"[a-zA-Z0-9_-]+"/.test(result)
    )
    if (!isBackgroundingResult) {
      const currentTasks = store.get(backgroundTasksAtom)
      store.set(backgroundTasksAtom, currentTasks.filter(t => t.toolUseId !== evt["toolUseId"]))
    }
  } else if (event.type === 'complete' || event.type === 'interrupted' || event.type === 'error') {
    // Orphan backstop: when the turn ends, any chip still marked 'running' belongs
    // to a background sub-agent whose per-turn subprocess is being torn down — with
    // the default (keep-alive OFF) model it has almost certainly died. Flip it to
    // 'orphaned' (visually distinct, auto-expires) so the bar never shows a false
    // "running" forever. This is the reliability fix that lets the bar be re-enabled.
    //
    // WS2 keep-alive: when the main process reports `backgroundTasksAlive` on the
    // complete event, the persistent query stays open across turns and the tasks
    // genuinely survive — so do NOT orphan them here. They stay 'running' until a
    // real `task_completed` arrives (routed via the between-turns background sink).
    // Without this guard the chip lies "orphaned" while the agent is still working.
    if (evt["backgroundTasksAlive"] === true) {
      return
    }
    const currentTasks = store.get(backgroundTasksAtom)
    if (currentTasks.some(t => t.status === 'running')) {
      store.set(backgroundTasksAtom, currentTasks.map(t =>
        t.status === 'running'
          ? { ...t, status: 'orphaned' as const, completedAt: Date.now() }
          : t
      ))
    }
  }
}
