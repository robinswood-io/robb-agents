import { getRobbOperationsExtension, type OperationsRuntimeEvent } from '@craft-agent/shared/operations';
import { sessionLog } from './SessionManager/runtime-platform.ts';

export function emitOperationsEvent(event: OperationsRuntimeEvent): void {
  const extension = getRobbOperationsExtension();
  if (!extension) return;
  try {
    void Promise.resolve(extension.onRuntimeEvent(event)).catch(error => {
      sessionLog.warn('Robb Operations event failed', {
        extensionId: extension.id, eventKind: event.kind,
        message: error instanceof Error ? error.message : String(error),
      });
    });
  } catch (error) {
    sessionLog.warn('Robb Operations event failed', {
      extensionId: extension.id, eventKind: event.kind,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
