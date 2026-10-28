import type { ToolDisplayMeta, ToolExecutionCheckpoint } from "@craft-agent/core";



// ============================================================================
// Event types (mirrored from event-processor/types.ts)
// ============================================================================

export interface TextCompleteEvent {
  text: string
  isIntermediate?: boolean
  turnId?: string
  parentToolUseId?: string
  timestamp?: number
}


export interface ToolStartEvent {
  toolName: string
  toolUseId: string
  toolInput?: Record<string, unknown>
  toolIntent?: string
  toolDisplayName?: string
  toolDisplayMeta?: ToolDisplayMeta
  turnId?: string
  parentToolUseId?: string
  timestamp?: number
}


export interface ToolResultEvent {
  toolUseId: string
  toolName?: string
  result: string
  isError?: boolean
  executed?: boolean
  checkpoint?: ToolExecutionCheckpoint
  turnId?: string
  parentToolUseId?: string
  timestamp?: number
}


export interface TypedErrorEvent {
  error: {
    code: string
    title: string
    message: string
    details?: string[]
    originalError?: string
    canRetry: boolean
    actions: unknown[]
  }
  timestamp?: number
}


export interface TaskBackgroundedEvent {
  toolUseId: string
  taskId: string
  intent?: string
  turnId?: string
}


export interface ShellBackgroundedEvent {
  toolUseId: string
  shellId: string
  intent?: string
  turnId?: string
}


export interface TaskProgressEvent {
  toolUseId: string
  elapsedSeconds: number
  turnId?: string
}


export interface TaskCompletedEvent {
  taskId: string
  status: 'completed' | 'failed' | 'stopped'
  outputFile?: string
  summary?: string
  turnId?: string
}


// ============================================================================
// Helpers
// ============================================================================

export let idCounter = 0

export function nextId() { return `msg-${++idCounter}` }


/** Extract the set of defined (non-undefined) keys from an object */
export function definedKeys(obj: object): Set<string> {
  return new Set(Object.keys(obj).filter(key => { const value: unknown = Reflect.get(obj, key); return value !== undefined }))
}
