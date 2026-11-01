import { createScopedLogger, CONSOLE_LOGGER, type PlatformServices, type Logger } from "@craft-agent/server-core/runtime";

// Module-level platform ref — set once during init via setSessionPlatform()
export let _platform: PlatformServices | null = null

// Scoped logger — upgraded from console fallback when setSessionPlatform() is called.
// Named `sessionLog` so all ~30 existing call sites remain unchanged.
export let sessionLog: Logger = createScopedLogger(CONSOLE_LOGGER, 'session')

export function setSessionPlatform(platform: PlatformServices): void {
  _platform = platform
  sessionLog = createScopedLogger(platform.logger, 'session')
}

interface SessionRuntimeHooks {
  updateBadgeCount: (count: number) => void
  captureException: (error: unknown, context?: { errorSource?: string; sessionId?: string }) => void
  onSessionStarted: () => void
  onSessionStopped: () => void
}

const defaultSessionRuntimeHooks: SessionRuntimeHooks = {
  updateBadgeCount: () => {},
  onSessionStarted: () => {},
  onSessionStopped: () => {},
  captureException: (error, context) => {
    const err = error instanceof Error ? error : new Error(String(error))
    if (_platform?.captureError) {
      _platform.captureError(err)
      return
    }
    sessionLog.error('[runtime-hooks] captureException fallback:', {
      errorSource: context?.errorSource,
      sessionId: context?.sessionId,
      message: err.message,
      stack: err.stack,
    })
  },
}

export let sessionRuntimeHooks: SessionRuntimeHooks = defaultSessionRuntimeHooks

export function setSessionRuntimeHooks(hooks: Partial<SessionRuntimeHooks>): void {
  sessionRuntimeHooks = {
    ...sessionRuntimeHooks,
    ...hooks,
  }
}
