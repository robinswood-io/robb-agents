import * as React from 'react';

import { useOptionalAppShellContext } from '@/context/AppShellContext';

import { shuffleArray } from "./free-form-input-helpers";

interface useInputPlaceholderInput {
  appShellCtx: import("@/context/AppShellContext").AppShellContextType | null
  workspaceId: string | undefined
  placeholder: string | string[] | undefined
  compactMode: boolean
  effectivePlaceholderProp: string | string[]
}

export function useInputPlaceholder({
  appShellCtx,
  workspaceId,
  effectivePlaceholderProp,
}: useInputPlaceholderInput) {
const sessionStatuses = appShellCtx?.sessionStatuses ?? []

const onSessionStatusChange = appShellCtx?.onSessionStatusChange

const workspaceRootPath = React.useMemo(() => {
    if (!appShellCtx || !workspaceId) return null
    return appShellCtx.workspaces.find(w => w.id === workspaceId)?.rootPath ?? null
  }, [appShellCtx, workspaceId])

const workspaceSlug = React.useMemo(() => {
    if (!appShellCtx || !workspaceId) return workspaceId
    return appShellCtx.workspaces.find(w => w.id === workspaceId)?.slug ?? workspaceId
  }, [appShellCtx, workspaceId])

const appShellContext = useOptionalAppShellContext()

const isFocusedPanel = appShellContext?.isFocusedPanel ?? true



const shuffledPlaceholder = React.useMemo(
    () => Array.isArray(effectivePlaceholderProp) ? shuffleArray(effectivePlaceholderProp) : effectivePlaceholderProp,
    [effectivePlaceholderProp]
  )

const effectivePlaceholder = isFocusedPanel ? shuffledPlaceholder : ''
return { isFocusedPanel, workspaceSlug, sessionStatuses, workspaceRootPath, onSessionStatusChange, effectivePlaceholder }
}
