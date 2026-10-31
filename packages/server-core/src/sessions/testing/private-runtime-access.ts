import type { SessionManager } from '../SessionManager.ts';
import type { PiAgent } from '@craft-agent/shared/agent';
import type { SessionOperations } from '../SessionManager/operation-types.ts';
import { withSessionOperationsForTest } from './session-operation-access.ts';

// Tests expose the same native operation signatures as the direct modules.
type NativeSessionManagerView = {
  [Key in keyof SessionManager]: SessionManager[Key];
};
export type SessionManagerTestView = NativeSessionManagerView & SessionOperations;

type NativePiAgentView = { [Key in keyof PiAgent]: PiAgent[Key] };
export type PiAgentTestView = NativePiAgentView & {
  beginAdmittedToolExecution: PiAgent['beginAdmittedToolExecution'];
  promptPreparationRevision: PiAgent['promptPreparationRevision'];
  send: PiAgent['send'];
  sendPreToolUseDecision: PiAgent['sendPreToolUseDecision'];
  subprocessRuntimeContext: PiAgent['subprocessRuntimeContext'];
};

export type SessionSendArguments = Parameters<SessionManager['sendMessage']>;
export type SessionSentEvent = Parameters<SessionOperations['sendEvent']>[0];

export function sessionManagerForTest(manager: SessionManager): SessionManagerTestView {
  const native: NativeSessionManagerView = withSessionOperationsForTest(manager);
  return native as SessionManagerTestView;
}

export function piAgentForTest(agent: PiAgent): PiAgentTestView {
  const native: NativePiAgentView = agent;
  return native as PiAgentTestView;
}
