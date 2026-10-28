

import { isJsonObject,parseJsonObject } from '@craft-agent/shared/utils/json';
import { useEffect,useState,useMemo,useCallback } from "react";

import { extractOverlayData,extractOverlayCards,type DiffViewerSettings } from "@craft-agent/ui";

import type { Session } from "../../../shared/types";

import { type OverlayState,isStackedActivityTool } from "./chat-display-contracts";

interface useChatOverlaysInput {
  session: Session | null
}

export function useChatOverlays(_input: useChatOverlaysInput) {
const [overlayState, setOverlayState] = useState<OverlayState>(null)

const [diffViewerSettings, setDiffViewerSettings] = useState<Partial<DiffViewerSettings>>({})

useEffect(() => {
    window.electronAPI.readPreferences().then(({ content }) => {
      try {
        const prefs = parseJsonObject(content)
        const value = prefs['diffViewer']
        if (isJsonObject(value)) {
          const settings: Partial<DiffViewerSettings> = {}
          if (value['diffStyle'] === 'unified' || value['diffStyle'] === 'split') settings.diffStyle = value['diffStyle']
          if (typeof value['disableBackground'] === 'boolean') settings.disableBackground = value['disableBackground']
          setDiffViewerSettings(settings)
        }
      } catch {
        // Ignore parse errors, use defaults
      }
    })
  }, [])

const handleDiffViewerSettingsChange = useCallback((settings: DiffViewerSettings) => {
    setDiffViewerSettings(settings)
    // Read current preferences, merge in new settings, write back
    window.electronAPI.readPreferences().then(({ content }) => {
      try {
        const prefs = parseJsonObject(content)
        prefs['diffViewer'] = settings
        prefs['updatedAt'] = Date.now()
        window.electronAPI.writePreferences(JSON.stringify(prefs, null, 2))
      } catch {
        // If preferences malformed, create fresh with just diffViewer
        window.electronAPI.writePreferences(JSON.stringify({ diffViewer: settings, updatedAt: Date.now() }, null, 2))
      }
    })
  }, [])

const handleCloseOverlay = useCallback(() => {
    setOverlayState(null)
  }, [])

const overlayCards = useMemo(() => {
    if (!overlayState || overlayState.type !== 'activity') return []
    return extractOverlayCards(overlayState.activity)
  }, [overlayState])

const activityOutputOverlayData = useMemo(() => {
    if (!overlayState || overlayState.type !== 'activity') return null
    return extractOverlayData(overlayState.activity)
  }, [overlayState])

const useStackedActivityOverlay = useMemo(() => {
    if (!overlayState || overlayState.type !== 'activity') return false
    return isStackedActivityTool(overlayState.activity)
  }, [overlayState])


return { setOverlayState, overlayState, useStackedActivityOverlay, handleCloseOverlay, overlayCards, activityOutputOverlayData, diffViewerSettings, handleDiffViewerSettingsChange }
}
