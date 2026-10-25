import type { SessionManager } from '../SessionManager.ts';
import type { SessionRuntimeState } from './runtime-state.ts';

/** Existing manager identity and its single runtime state, shared by direct calls. */
export interface SessionOperationContext {
  readonly owner: SessionManager;
  readonly state: SessionRuntimeState;
}
