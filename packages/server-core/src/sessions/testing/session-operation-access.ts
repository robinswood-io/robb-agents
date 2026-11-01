import { createRequire } from 'node:module';
import type { SessionManager } from '../SessionManager.ts';
import type { SessionOperationContext } from '../SessionManager/operation-context.ts';

const require = createRequire(import.meta.url);

/** Keep historical operation-level fixtures independent of production encapsulation. */
export function withSessionOperationsForTest(manager: SessionManager): SessionManager {
  const state: unknown = Reflect.get(manager, 'runtimeState');
  if (!state || typeof state !== 'object') return manager;

  // Delay loading the runtime until a fixture has installed its provider mocks.
  const operations = require('../SessionManager/operations.ts') as typeof import('../SessionManager/operations.ts');
  const context: SessionOperationContext = {
    owner: manager,
    state: state as SessionOperationContext['state'],
  };
  for (const [name, operation] of Object.entries(operations)) {
    if (typeof Reflect.get(manager, name) === 'function' || typeof operation !== 'function') continue;
    Object.defineProperty(manager, name, {
      configurable: true,
      writable: true,
      value: (...args: unknown[]): unknown => Reflect.apply(operation, undefined, [context, ...args]),
    });
  }
  return manager;
}
