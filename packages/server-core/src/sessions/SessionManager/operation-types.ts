import type * as operations from './operations.ts';
import type { ManagedSession } from "./managed-session.ts";

type BoundOperation<Operation> = Operation extends (context: infer _Context, ...args: infer Arguments) => infer Result
  ? (...args: Arguments) => Result
  : never;

interface GenericSessionOperations {
  trackSessionOperation: <T>(managed: ManagedSession, operation: () => Promise<T>, allowShutdownTerminalResult?: boolean) => Promise<T>;
  trackManagerOperation: <T>(operation: () => Promise<T>) => Promise<T>;
  serializeDirectHumanSupersession: <T>(managed: ManagedSession, operation: () => Promise<T>) => Promise<T>;
  serializeSourceActivation: <T>(managed: ManagedSession, operation: () => Promise<T>) => Promise<T>;
}

export type SessionOperations = Omit<{
  [Name in keyof typeof operations]: BoundOperation<(typeof operations)[Name]>;
}, keyof GenericSessionOperations> & GenericSessionOperations;

export type SessionOperationArguments<Name extends keyof SessionOperations> = Parameters<SessionOperations[Name]>;
export type SessionOperationResult<Name extends keyof SessionOperations> = ReturnType<SessionOperations[Name]>;
