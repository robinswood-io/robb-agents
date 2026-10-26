import * as React from 'react';

import { useAtomValue, useSetAtom } from 'jotai';

import { toast } from 'sonner';

import { usePendingPermission, usePendingCredential } from '@/context/AppShellContext';
import { rendererPerf } from '@/lib/perf';

import { coerceInputText } from '@/lib/input-text';
import { resolveSessionFilePath } from '@/lib/resolve-session-file-path';
import { deriveSessionMessagesLoadState, formatSessionLoadFailure } from '@/lib/session-load';
import { ensureSessionMessagesLoadedAtom, forceSessionMessagesReloadAtom, loadedSessionsAtom, sessionMetaMapAtom } from '@/atoms/sessions';

import { resolveEffectiveConnectionSlug, isSessionConnectionUnavailable } from '@config/llm-connections';

interface useChatSessionStateInput {
  sessionId: string
  session: import("@craft-agent/shared/protocol").Session | null
  isFocusedPanel: boolean | undefined
  onSetActiveViewingSession: (sessionId: string) => void
  getDraft: (sessionId: string) => string
  onInputChange: (sessionId: string, value: string) => void
  hydrateDraftAttachments: (sessionId: string) => Promise<import("@craft-agent/shared/protocol").FileAttachment[]>
  onAttachmentsChange: (sessionId: string, attachments: import("@craft-agent/shared/protocol").FileAttachment[]) => void
  activeWorkspaceId: string | null
  llmConnections: import("@config/llm-connections").LlmConnectionWithStatus[]
  workspaceDefaultLlmConnection: string | undefined
  workspaces: import("@craft-agent/core").Workspace[]
  onOpenFile: (path: string) => void
  t: import("i18next").TFunction<"translation", undefined>
  onOpenUrl: (url: string) => void
}

export function useChatSessionState({
  sessionId,
  session,
  isFocusedPanel,
  onSetActiveViewingSession,
  getDraft,
  onInputChange,
  hydrateDraftAttachments,
  onAttachmentsChange,
  activeWorkspaceId,
  llmConnections,
  workspaceDefaultLlmConnection,
  workspaces,
  onOpenFile,
  t,
  onOpenUrl,
}: useChatSessionStateInput) {
const loadedSessions = useAtomValue(loadedSessionsAtom)

const messagesLoaded = loadedSessions.has(sessionId)

const sessionMetaMap = useAtomValue(sessionMetaMapAtom)

const sessionMeta = sessionMetaMap.get(sessionId)

const ensureMessagesLoaded = useSetAtom(ensureSessionMessagesLoadedAtom)

const forceMessagesReload = useSetAtom(forceSessionMessagesReloadAtom)

const [messagesLoadError, setMessagesLoadError] = React.useState<string | null>(null)

const [messagesRetrying, setMessagesRetrying] = React.useState(false)

const autoForcedReloadSessionRef = React.useRef<string | null>(null)

const shouldForceInitialMessagesReload = React.useMemo(() => {
    const expectedMessageCount = session?.messageCount ?? sessionMeta?.messageCount ?? 0
    return messagesLoaded
      && !!session
      && (session.messages?.length ?? 0) === 0
      && (expectedMessageCount > 0 || !!session.lastFinalMessageId || !!sessionMeta?.lastFinalMessageId)
  }, [messagesLoaded, session, sessionMeta])

React.useEffect(() => {
    let cancelled = false
    setMessagesLoadError(null)
    setMessagesRetrying(false)

    if (shouldForceInitialMessagesReload && autoForcedReloadSessionRef.current === sessionId) {
      setMessagesLoadError('Session messages are not available')
      return () => {
        cancelled = true
      }
    }

    const useForceReload = shouldForceInitialMessagesReload
    if (useForceReload) {
      autoForcedReloadSessionRef.current = sessionId
    }

    const loadPromise = useForceReload
      ? forceMessagesReload(sessionId)
      : ensureMessagesLoaded(sessionId)

    loadPromise
      .then((loadedSession) => {
        if (!cancelled && !loadedSession) {
          setMessagesLoadError('Session messages are not available')
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setMessagesLoadError(formatSessionLoadFailure(error))
        }
      })

    return () => {
      cancelled = true
    }
  }, [sessionId, ensureMessagesLoaded, forceMessagesReload, shouldForceInitialMessagesReload])

const handleRetryMessagesLoad = React.useCallback(async () => {
    setMessagesLoadError(null)
    setMessagesRetrying(true)

    try {
      const loadedSession = await forceMessagesReload(sessionId)
      if (!loadedSession) {
        setMessagesLoadError('Session messages are not available')
      }
    } catch (error) {
      setMessagesLoadError(formatSessionLoadFailure(error))
    } finally {
      setMessagesRetrying(false)
    }
  }, [forceMessagesReload, sessionId])

const messageLoadState = React.useMemo(() => deriveSessionMessagesLoadState({
    session,
    sessionMeta,
    messagesLoaded,
    loadError: messagesLoadError,
  }), [session, sessionMeta, messagesLoaded, messagesLoadError])

const sessionLoadedMarkedRef = React.useRef<string | null>(null)

React.useLayoutEffect(() => {
    if (session && sessionLoadedMarkedRef.current !== sessionId) {
      sessionLoadedMarkedRef.current = sessionId
      rendererPerf.markSessionSwitch(sessionId, 'session.loaded')
    }
  }, [sessionId, session])

const [isWindowFocused, setIsWindowFocused] = React.useState(true)

React.useEffect(() => {
    window.electronAPI.getWindowFocusState().then(setIsWindowFocused)
    const cleanup = window.electronAPI.onWindowFocusChange(setIsWindowFocused)
    return cleanup
  }, [])

React.useEffect(() => {
    if (session && isWindowFocused && isFocusedPanel !== false) {
      onSetActiveViewingSession(session.id)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id, isWindowFocused, isFocusedPanel, onSetActiveViewingSession])

const pendingPermission = usePendingPermission(sessionId)

const pendingCredential = usePendingCredential(sessionId)

const [inputValue, setInputValue] = React.useState(() => coerceInputText(getDraft(sessionId)))

const inputValueRef = React.useRef(inputValue)

inputValueRef.current = inputValue

React.useEffect(() => {
    setInputValue(coerceInputText(getDraft(sessionId)))
  }, [getDraft, sessionId])

React.useEffect(() => {
    let attempts = 0
    const maxAttempts = 10
    const interval = setInterval(() => {
      const currentDraft = coerceInputText(getDraft(sessionId))
      if (currentDraft !== inputValueRef.current && currentDraft !== '') {
        setInputValue(currentDraft)
        clearInterval(interval)
      }
      attempts++
      if (attempts >= maxAttempts) {
        clearInterval(interval)
      }
    }, 50)

    return () => clearInterval(interval)
  }, [sessionId, getDraft])

React.useEffect(() => {
    const handler = (e: Event) => {
      const { sessionId: targetId, text } = (e as CustomEvent).detail ?? {}
      if (targetId === sessionId) {
        const nextText = coerceInputText(text)
        setInputValue(nextText)
        inputValueRef.current = nextText
      }
    }
    window.addEventListener('craft:restore-input', handler)
    return () => window.removeEventListener('craft:restore-input', handler)
  }, [sessionId])

const handleInputChange = React.useCallback((value: string) => {
    const nextText = coerceInputText(value)
    setInputValue(nextText)
    inputValueRef.current = nextText
    onInputChange(sessionId, nextText)
  }, [sessionId, onInputChange])

const [attachmentsValue, setAttachmentsValue] = React.useState<import('../../shared/types').FileAttachment[]>([])

React.useEffect(() => {
    let cancelled = false
    setAttachmentsValue([])
    hydrateDraftAttachments(sessionId).then((atts) => {
      if (!cancelled) setAttachmentsValue(atts)
    })
    return () => { cancelled = true }
  }, [sessionId, hydrateDraftAttachments])

const handleAttachmentsChange = React.useCallback((attachments: import('../../shared/types').FileAttachment[]) => {
    setAttachmentsValue(attachments)
    onAttachmentsChange(sessionId, attachments)
  }, [sessionId, onAttachmentsChange])

const handleModelChange = React.useCallback((model: string | null, connection?: string) => {
    if (activeWorkspaceId) {
      window.electronAPI.setSessionModel(sessionId, activeWorkspaceId, model, connection)
    }
  }, [sessionId, activeWorkspaceId])

const handleConnectionChange = React.useCallback(async (connectionSlug: string) => {
    try {
      await window.electronAPI.sessionCommand(sessionId, { type: 'setConnection', connectionSlug })
    } catch (error) {
      // Connection change may fail if session already started or connection is invalid
      console.error('Failed to change connection:', error)
    }
  }, [sessionId])

const connectionUnavailable = React.useMemo(() =>
    isSessionConnectionUnavailable(session?.llmConnection, llmConnections),
    [session?.llmConnection, llmConnections]
  )

const effectiveModel = React.useMemo(() => {
    if (session?.model) return session.model

    // When connection is unavailable, don't resolve through a different connection
    if (connectionUnavailable) return session?.model ?? ''

    const connectionSlug = resolveEffectiveConnectionSlug(
      session?.llmConnection, workspaceDefaultLlmConnection, llmConnections
    )
    const connection = connectionSlug ? llmConnections.find(c => c.slug === connectionSlug) : null

    return connection?.defaultModel ?? ''
  }, [session?.model, session?.llmConnection, workspaceDefaultLlmConnection, llmConnections, connectionUnavailable])

const workingDirectory = session?.workingDirectory

const activeWorkspace = React.useMemo(
    () => workspaces.find((w) => w.id === activeWorkspaceId) || null,
    [workspaces, activeWorkspaceId]
  )

const handleWorkingDirectoryChange = React.useCallback(async (path: string) => {
    if (!session) return
    await window.electronAPI.sessionCommand(session.id, { type: 'updateWorkingDirectory', dir: path })
  }, [session])

const handleOpenFile = React.useCallback(
    async (path: string) => {
      // Resolve bare relative paths against session working directory,
      // or workspace root as a fallback when workingDirectory is not set.
      const resolved = resolveSessionFilePath(path, workingDirectory, activeWorkspace?.rootPath)

      // Smart fallback for missing files in AI output:
      // if the exact path doesn't exist, search nearby for same basename
      // (e.g. markdown/linkify.test.ts -> markdown/__tests__/linkify.test.ts).
      if (resolved.startsWith('/')) {
        const lastSlash = resolved.lastIndexOf('/')
        if (lastSlash > 0 && lastSlash < resolved.length - 1) {
          const parentDir = resolved.slice(0, lastSlash)
          const fileName = resolved.slice(lastSlash + 1)
          try {
            const matches = await window.electronAPI.searchFiles(parentDir, fileName)
            const files = matches.filter((m) => m.type === 'file' && m.name === fileName)
            const exact = files.find((m) => m.path === resolved)
            if (exact) {
              onOpenFile(exact.path)
              return
            }

            if (files.length === 1) {
              onOpenFile(files[0].path)
              toast.info(t('chat.openedClosestMatch', { path: files[0].relativePath }))
              return
            }
          } catch {
            // Search fallback is best-effort; proceed with original resolved path.
          }
        }
      }

      onOpenFile(resolved)
    },
    [onOpenFile, workingDirectory, activeWorkspace?.rootPath, t]
  )

const handleOpenUrl = React.useCallback(
    (url: string) => {
      onOpenUrl(url)
    },
    [onOpenUrl]
  )
return { messageLoadState, sessionMeta, handleOpenFile, handleOpenUrl, effectiveModel, handleModelChange, handleConnectionChange, inputValue, handleInputChange, attachmentsValue, handleAttachmentsChange, handleWorkingDirectoryChange, messagesRetrying, handleRetryMessagesLoad, connectionUnavailable, pendingPermission, pendingCredential, workingDirectory }
}
