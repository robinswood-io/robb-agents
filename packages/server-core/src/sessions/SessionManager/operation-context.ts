import type { Message } from '@craft-agent/core/types';
import type { SendMessageOptions } from '@craft-agent/shared/protocol';
import type { SessionManager } from '../SessionManager.ts';
import type { SessionRuntimeState } from './runtime-state.ts';

/** Existing manager identity and its single runtime state, shared by direct calls. */
export interface SessionOperationContext {
  readonly owner: SessionManager;
  readonly state: SessionRuntimeState;
}

/** The existing mutable message values shared by callbacks within one turn. */
export interface SessionMessageState {
  message: string;
  options: SendMessageOptions | undefined;
  syntheticAutomaticMessage: Message | undefined;
}
