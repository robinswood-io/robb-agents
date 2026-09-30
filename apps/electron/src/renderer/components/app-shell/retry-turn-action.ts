import type { SessionCommand } from '../../../shared/types'

interface RetryTurnActionOptions {
  sessionId: string
  sessionCommand: (sessionId: string, command: SessionCommand) => Promise<unknown>
  isProcessing: () => boolean
  onPendingChange: (pending: boolean) => void
  onAlreadyRunning?: () => void
  onError: (error: unknown) => void
}

/** Resume an existing turn through the host; coalesce clicks until its acknowledgement. */
export function createRetryTurnAction(options: RetryTurnActionOptions) {
  let inFlight = false
  return async (userMessageId: string): Promise<void> => {
    if (!userMessageId || inFlight || options.isProcessing()) return
    inFlight = true
    options.onPendingChange(true)
    try {
      const result = await options.sessionCommand(options.sessionId, { type: 'retryTurn', userMessageId })
      if (result && typeof result === 'object' && 'status' in result && result.status === 'already_running') {
        options.onAlreadyRunning?.()
      }
    } catch (error) {
      options.onError(error)
    } finally {
      inFlight = false
      options.onPendingChange(false)
    }
  }
}
