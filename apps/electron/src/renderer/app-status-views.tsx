
import { useTranslation } from 'react-i18next';

import { useWindowCloseHandler } from '@/hooks/useWindowCloseHandler';

import { ImagePreviewOverlay, PDFPreviewOverlay, CodePreviewOverlay, DocumentFormattedMarkdownOverlay, JSONPreviewOverlay } from '@craft-agent/ui';
import { type FilePreviewState } from '@/hooks/useLinkInterceptor';
import { resolveDocumentFilePath } from '@/lib/resolve-session-file-path';

export function SessionLoadErrorScreen({
  message,
  onRetry,
}: {
  message: string
  onRetry: () => void
}) {
  const { t } = useTranslation()

  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="max-w-lg rounded-xl border border-border/50 bg-background shadow-minimal p-6 text-center">
        <h2 className="text-lg font-semibold text-foreground">{t("errors.failedToLoadSessions")}</h2>
        <p className="mt-2 text-sm text-foreground/60">
          {t("errors.failedToLoadSessionsDesc")}
        </p>
        <p className="mt-3 rounded-lg bg-foreground/5 px-3 py-2 text-left text-xs text-foreground/70 break-words">
          {message}
        </p>
        <button
          type="button"
          onClick={onRetry}
          className="mt-4 inline-flex h-8 items-center justify-center rounded-[8px] bg-foreground text-background px-3 text-sm font-medium hover:opacity-90 transition-opacity"
        >
          {t("errors.retryLoadingSessions")}
        </button>
      </div>
    </div>
  )
}

export function WindowCloseHandler() {
  useWindowCloseHandler()
  return null
}

export function FilePreviewRenderer({
  state,
  onClose,
  loadDataUrl,
  loadPdfData,
  onOpenFile,
  onOpenUrl,
  isDark,
}: {
  state: FilePreviewState
  onClose: () => void
  loadDataUrl: (path: string) => Promise<string>
  loadPdfData: (path: string) => Promise<Uint8Array>
  onOpenFile: (path: string) => void
  onOpenUrl: (url: string) => void
  isDark: boolean
}) {
  const theme = isDark ? 'dark' : 'light' as const

  switch (state.type) {
    case 'image':
      return (
        <ImagePreviewOverlay
          isOpen
          onClose={onClose}
          filePath={state.filePath}
          loadDataUrl={loadDataUrl}
          theme={theme}
        />
      )

    case 'pdf':
      return (
        <PDFPreviewOverlay
          isOpen
          onClose={onClose}
          filePath={state.filePath}
          loadPdfData={loadPdfData}
          theme={theme}
        />
      )

    case 'code':
    case 'text':
      return (
        <CodePreviewOverlay
          isOpen
          onClose={onClose}
          filePath={state.filePath}
          content={state.content ?? ''}
          language={state.type === 'code' ? state.language : 'plaintext'}
          mode="read"
          theme={theme}
          error={state.error}
        />
      )

    case 'markdown': {
      // Show PLAN header for .md files in plans folder (handles both absolute and relative paths)
      const isPlanFile =
        (state.filePath.includes('/plans/') || state.filePath.startsWith('plans/')) &&
        state.filePath.endsWith('.md')
      return (
        <DocumentFormattedMarkdownOverlay
          isOpen
          onClose={onClose}
          content={state.content ?? ''}
          filePath={state.filePath}
          variant={isPlanFile ? 'plan' : 'response'}
          onOpenFile={(path) => onOpenFile(resolveDocumentFilePath(path, state.filePath))}
          onOpenUrl={onOpenUrl}
          error={state.error}
        />
      )
    }

    case 'json': {
      // JSONPreviewOverlay expects parsed data, not a raw string.
      // @uiw/react-json-view crashes on null value, so guard against it.
      let parsedData: unknown = null
      try {
        if (state.content) parsedData = JSON.parse(state.content)
      } catch {
        // If parsing fails, fall back to showing as code
        return (
          <CodePreviewOverlay
            isOpen
            onClose={onClose}
            filePath={state.filePath}
            content={state.content ?? ''}
            language="json"
            mode="read"
            theme={theme}
            error={state.error}
          />
        )
      }
      // If read failed and content is empty, show raw code overlay with the read error.
      if ((!state.content || !state.content.trim()) && state.error) {
        return (
          <CodePreviewOverlay
            isOpen
            onClose={onClose}
            filePath={state.filePath}
            content={state.content ?? ''}
            language="json"
            mode="read"
            theme={theme}
            error={state.error}
          />
        )
      }
      return (
        <JSONPreviewOverlay
          isOpen
          onClose={onClose}
          filePath={state.filePath}
          title={state.filePath.split('/').pop() ?? 'JSON'}
          data={parsedData}
          theme={theme}
          error={state.error}
        />
      )
    }

    default:
      return null
  }
}
