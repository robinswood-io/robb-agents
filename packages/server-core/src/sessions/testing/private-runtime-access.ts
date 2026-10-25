import type { SessionManager } from '../SessionManager.ts';
import type { PiAgent } from '@craft-agent/shared/agent';
import type { SessionOperations } from '../SessionManager/operation-types.ts';
import { withSessionOperationsForTest } from './session-operation-access.ts';

// Tests expose the same native operation signatures as the direct modules.
export type SessionManagerTestView = {
  [Key in keyof SessionManager]: SessionManager[Key];
} & SessionOperations;

export type PiAgentTestView = { [Key in keyof PiAgent]: PiAgent[Key] } & {
  beginAdmittedToolExecution: PiAgent['beginAdmittedToolExecution'];
  promptPreparationRevision: PiAgent['promptPreparationRevision'];
  send: PiAgent['send'];
  sendPreToolUseDecision: PiAgent['sendPreToolUseDecision'];
  subprocessRuntimeContext: PiAgent['subprocessRuntimeContext'];
};

export type SessionSendArguments = Parameters<SessionManager['sendMessage']>;
export type SessionSentEvent = Parameters<SessionOperations['sendEvent']>[0];

export function sessionManagerForTest(manager: SessionManager): SessionManagerTestView {
  return withSessionOperationsForTest(manager) as unknown as SessionManagerTestView;
}

export function piAgentForTest(agent: PiAgent): PiAgentTestView {
  return agent as unknown as PiAgentTestView;
}
