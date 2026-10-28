/**
 * SessionFilesSection - Displays files in the session directory as a tree view
 *
 * Features:
 * - Recursive tree view with expandable folders (matches sidebar styling)
 * - File watcher for auto-refresh when files change
 * - Click to preview in-app, double-click to open
 * - Right-click context menu with "Open" / "Show in {file manager}" actions
 * - Persisted expanded folder state per session
 *
 * Styling matches LeftSidebar patterns:
 * - Chevron hidden by default, shown on hover
 * - Vertical connector lines for nested items
 * - 14x14px icons, 8px gaps, 6px radius
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import "react";
import "motion/react";
import "lucide-react";
import "@/components/ui/styled-context-menu";
import { cn } from '@/lib/utils';
import * as storage from '@/lib/local-storage';
import { useAppShellContext } from '@/context/AppShellContext';
import { getFileManagerName } from '@/lib/platform';
import { restoreSessionFileWatch } from './session-files-watch';

import { type SessionFilesSectionProps, collectDirectoryPaths, FileTreeItem } from "./session-file-tree";
export { type SessionFilesSectionProps } from "./session-file-tree";






import type { SessionFile } from '../../../shared/types';






/**
 * Section displaying session files as a tree
 */
export function SessionFilesSection({ sessionId, className, sessionFolderPath, hideHeader = false }: SessionFilesSectionProps) {
  const { t } = useTranslation()
  const [files, setFiles] = useState<SessionFile[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set())
  const [hasSavedExpandedState, setHasSavedExpandedState] = useState(false)
  const mountedRef = useRef(true)

  // Load expanded paths from storage when session changes.
  // If no value exists yet, we default to "expand all" after files load.
  useEffect(() => {
    if (sessionId) {
      const raw = storage.getRaw(storage.KEYS.sessionFilesExpandedFolders, sessionId)
      if (raw !== null) {
        const saved = storage.get<string[]>(storage.KEYS.sessionFilesExpandedFolders, [], sessionId)
        setExpandedPaths(new Set(saved))
        setHasSavedExpandedState(true)
      } else {
        setExpandedPaths(new Set())
        setHasSavedExpandedState(false)
      }
    } else {
      setExpandedPaths(new Set())
      setHasSavedExpandedState(false)
    }
  }, [sessionId])

  // Save expanded paths to storage when they change
  const saveExpandedPaths = useCallback((paths: Set<string>) => {
    if (sessionId) {
      storage.set(storage.KEYS.sessionFilesExpandedFolders, Array.from(paths), sessionId)
    }
  }, [sessionId])

  // Load files
  const loadFiles = useCallback(async () => {
    if (!sessionId) {
      setFiles([])
      return
    }

    setIsLoading(true)
    try {
      const sessionFiles = await window.electronAPI.getSessionFiles(sessionId)
      if (mountedRef.current) {
        setFiles(sessionFiles)

        // Default behavior: expand the entire folder tree when there's no saved state yet.
        if (!hasSavedExpandedState) {
          const allDirectoryPaths = new Set(collectDirectoryPaths(sessionFiles))
          if (allDirectoryPaths.size > 0) {
            setExpandedPaths(allDirectoryPaths)
            saveExpandedPaths(allDirectoryPaths)
            setHasSavedExpandedState(true)
          }
        }
      }
    } catch (error) {
      console.error('Failed to load session files:', error)
      if (mountedRef.current) {
        setFiles([])
      }
    } finally {
      if (mountedRef.current) {
        setIsLoading(false)
      }
    }
  }, [sessionId, hasSavedExpandedState, saveExpandedPaths])

  // Initial load and file watcher setup
  useEffect(() => {
    mountedRef.current = true
    loadFiles()

    if (sessionId) {
      // Start watching for file changes
      void window.electronAPI.watchSessionFiles(sessionId)

      // Listen for file change events
      const unsubscribe = window.electronAPI.onSessionFilesChanged((changedSessionId) => {
        if (changedSessionId === sessionId && mountedRef.current) {
          void loadFiles()
        }
      })

      const unsubscribeReconnect = window.electronAPI.onReconnected(() => {
        if (!mountedRef.current) return
        void restoreSessionFileWatch(sessionId, loadFiles)
      })

      return () => {
        mountedRef.current = false
        unsubscribe()
        unsubscribeReconnect()
        void window.electronAPI.unwatchSessionFiles()
      }
    }

    return () => {
      mountedRef.current = false
    }
  }, [sessionId, loadFiles])

  // Use the link interceptor (via context) so file clicks show in-app previews
  // instead of always opening in the file manager / default app.
  const { onOpenFile } = useAppShellContext()
  const fileManagerName = getFileManagerName()

  // Reveal a file/folder in the system file manager
  const handleRevealInFileManager = useCallback((path: string) => {
    window.electronAPI.showInFolder(path)
  }, [])

  // Handle file click — preview in-app if possible, open directory in file manager
  const handleFileClick = useCallback((file: SessionFile) => {
    if (file.type === 'directory') {
      window.electronAPI.openFile(file.path)
    } else {
      onOpenFile(file.path)
    }
  }, [onOpenFile])

  // Handle double-click — same as single click (interceptor decides preview vs external)
  const handleFileDoubleClick = handleFileClick

  // Toggle folder expanded state
  const handleToggleExpand = useCallback((path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
      }
      saveExpandedPaths(next)
      return next
    })
  }, [saveExpandedPaths])

  if (!sessionId) {
    return null
  }

  return (
    <div className={cn('flex flex-col h-full min-h-0', className)}>
      {/* Header - matches sidebar styling with select-none, extra top padding for visual balance */}
      {!hideHeader && (
        <div className="flex items-center justify-between px-4 pt-4 pb-2 shrink-0 select-none">
          <span className="text-xs font-medium text-muted-foreground">{t("chat.sessionFiles")}</span>
          {sessionFolderPath && (
            <button
              type="button"
              onClick={() => window.electronAPI.showInFolder(sessionFolderPath)}
              className="text-xs text-foreground/50 hover:text-foreground/80 hover:underline underline-offset-2 transition-colors"
            >
              {t("chat.viewInFileManager", { fileManager: fileManagerName })}
            </button>
          )}
        </div>
      )}

      {/* File tree - px-2 is on nav to match LeftSidebar exactly (constrains grid width) */}
      {/* overflow-x-hidden prevents horizontal scroll, forcing truncation */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden pb-2 min-h-0">
        {files.length === 0 ? (
          <div className="px-4 text-muted-foreground select-none">
            <p className="text-xs">
              {isLoading ? t('chat.sessionFilesLoading') : t('chat.sessionFilesEmpty')}
            </p>
          </div>
        ) : (
          /* Root nav has px-2 to match LeftSidebar exactly - this constrains grid width */
          <nav className="grid gap-0.5 px-2">
            {files.map((file) => (
              <FileTreeItem
                key={file.path}
                file={file}
                depth={0}
                expandedPaths={expandedPaths}
                onToggleExpand={handleToggleExpand}
                onFileClick={handleFileClick}
                onFileDoubleClick={handleFileDoubleClick}
                onRevealInFileManager={handleRevealInFileManager}
              />
            ))}
          </nav>
        )}
      </div>
    </div>
  )
}
