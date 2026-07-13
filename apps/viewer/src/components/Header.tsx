/**
 * Header - App header with branding and controls
 */

import { Sun, Moon, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

/**
 * RobinswoodLogo - compact Robb Agents monogram
 */
function RobinswoodLogo({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect x="2" y="2" width="20" height="20" rx="5" fill="#08033A" />
      <path
        d="M6.4 16.6V7.4h6.2c2.35 0 4.05 1.28 4.05 3.28 0 1.36-.74 2.39-1.95 2.92l2.85 3h-3.4l-2.48-2.66H9.2v2.66H6.4Zm2.8-4.96h3.02c.85 0 1.4-.39 1.4-1.06s-.55-1.06-1.4-1.06H9.2v2.12Z"
        fill="#F7F3ED"
      />
      <path d="M5.9 17.7c3.1-.7 5.45-.62 7.25-.08 1.86.56 3.34.48 5.85-.86" stroke="#E0796B" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

interface HeaderProps {
  hasSession: boolean
  sessionTitle?: string
  isDark: boolean
  onToggleTheme: () => void
  onClear: () => void
}

export function Header({ hasSession, sessionTitle, isDark, onToggleTheme, onClear }: HeaderProps) {
  const { t } = useTranslation()
  return (
    <header className="shrink-0 grid grid-cols-[auto_1fr_auto] items-center px-4 py-3">
      {/* Logo - links to main site */}
      <a
        href="https://github.com/robinswood-io/robb-agents"
        className="hover:opacity-80 transition-opacity"
        title="Robb Agents"
      >
        <RobinswoodLogo className="w-6 h-6" />
      </a>

      {/* Session title - centered */}
      <div className="flex justify-center">
        {sessionTitle && (
          <span className="text-sm font-semibold text-foreground truncate max-w-md">
            {sessionTitle}
          </span>
        )}
      </div>

      <div className="flex items-center gap-2">
        {/* Clear button (when session is loaded) */}
        {hasSession && (
          <button
            onClick={onClear}
            className="p-1.5 rounded-md bg-background shadow-minimal text-foreground/40 hover:text-foreground/70 transition-colors"
            title={t('viewer.clearSession')}
          >
            <X className="w-4 h-4" />
          </button>
        )}

        {/* Theme toggle */}
        <button
          onClick={onToggleTheme}
          className="p-1.5 rounded-md bg-background shadow-minimal text-foreground/40 hover:text-foreground/70 transition-colors"
          title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          {isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
        </button>
      </div>
    </header>
  )
}
