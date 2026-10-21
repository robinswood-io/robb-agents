import React from 'react'
import ReactDOM from 'react-dom/client'
import { Provider as JotaiProvider, useAtomValue } from 'jotai'
import App from './App'
import { ThemeProvider } from './context/ThemeContext'
import { windowWorkspaceIdAtom } from './atoms/sessions'
import { Toaster } from '@/components/ui/sonner'
import { setupI18n, i18n } from '@craft-agent/shared/i18n'
import { initReactI18next } from 'react-i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import './index.css'

// Initialize i18n before any React rendering
setupI18n([LanguageDetector, initReactI18next])

// One-shot bootstrap: ensure the main process's i18n + preferences.json learn
// the language we just restored from localStorage. The main-process IPC handler
// validates the code and persists idempotently, so this is safe to run on every
// renderer startup. Without this push, a freshly-installed (or freshly-upgraded)
// app would still generate titles in English until the user manually re-picks
// the language in Appearance.
const resolvedLanguage = i18n.resolvedLanguage
console.info('[i18n] renderer bootstrap push', {
  resolvedLanguage: resolvedLanguage ?? null,
  localStorageI18nextLng: typeof window !== 'undefined' ? window.localStorage?.getItem('i18nextLng') : null,
})
if (resolvedLanguage) {
  void window.electronAPI?.changeLanguage?.(resolvedLanguage)
}

/**
 * Minimal fallback UI shown when the entire React tree crashes.
 * Handled purely locally by RootErrorBoundary (no external telemetry).
 */
function CrashFallback({ error }: { error?: unknown }) {
  const errorMessage = error instanceof Error
    ? `${error.name}: ${error.message}\n\n${error.stack || ''}`
    : error ? String(error) : null

  return (
    <div className="flex flex-col items-center justify-center h-screen font-sans text-foreground/70 gap-3 p-6 max-w-xl mx-auto text-center">
      <p className="text-base font-medium text-foreground">{i18n.t('crash.somethingWentWrong')}</p>
      <p className="text-[13px] text-muted-foreground">{i18n.t('crash.restartPrompt')}</p>
      {errorMessage && (
        <pre className="mt-2 p-3 rounded bg-muted/60 text-xs text-left max-h-48 overflow-auto w-full font-mono border border-border/40 select-text text-foreground/80 whitespace-pre-wrap">
          {errorMessage}
        </pre>
      )}
      <button
        onClick={() => window.location.reload()}
        className="mt-2 px-4 py-1.5 rounded-md bg-background border border-border/40 shadow-minimal text-[13px] text-foreground/80 cursor-pointer hover:bg-muted"
      >
        {i18n.t('crash.reload')}
      </button>
    </div>
  )
}

/**
 * Root component - loads workspace ID for theme context and renders App
 * App.tsx handles window mode detection internally (main vs tab-content)
 */
function Root() {
  // Shared atom — written by App on init & workspace switch, read here for ThemeProvider
  const workspaceId = useAtomValue(windowWorkspaceIdAtom)

  return (
    <ThemeProvider activeWorkspaceId={workspaceId} defaultColorTheme="robinswood">
      <App />
      <Toaster />
    </ThemeProvider>
  )
}

class RootErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: unknown; hasError: boolean }
> {
  state = { error: undefined as unknown, hasError: false }

  static getDerivedStateFromError(error: unknown) {
    return { error, hasError: true }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[RootErrorBoundary] Renderer crashed:', error, info.componentStack)
  }

  render() {
    if (this.state.hasError) {
      return <CrashFallback error={this.state.error} />
    }
    return this.props.children
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RootErrorBoundary>
      <JotaiProvider>
        <Root />
      </JotaiProvider>
    </RootErrorBoundary>
  </React.StrictMode>
)
