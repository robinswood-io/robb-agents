export interface EmptySessionCleanupMeta {
  lastFinalMessageId?: string
  name?: string
  isProcessing?: boolean
}

export function shouldAutoDeleteEmptySession(
  createdInCurrentNavigation: boolean,
  meta: EmptySessionCleanupMeta | undefined,
  draft: string | undefined,
): boolean {
  return createdInCurrentNavigation
    && !!meta
    && !meta.lastFinalMessageId
    && !meta.name
    && !meta.isProcessing
    && !draft?.trim()
}
