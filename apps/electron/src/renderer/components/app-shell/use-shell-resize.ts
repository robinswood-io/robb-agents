import * as React from "react";

import * as storage from "@/lib/local-storage";

interface useShellResizeInput {
  isResizing: "sidebar" | "session-list" | null
  setSidebarWidth: React.Dispatch<React.SetStateAction<number>>
  resizeHandleRef: React.RefObject<HTMLDivElement | null>
  setSidebarHandleY: React.Dispatch<React.SetStateAction<number | null>>
  isSidebarVisible: boolean
  sidebarWidth: number
  setSessionListWidth: React.Dispatch<React.SetStateAction<number>>
  sessionListHandleRef: React.RefObject<HTMLDivElement | null>
  setSessionListHandleY: React.Dispatch<React.SetStateAction<number | null>>
  sessionListWidth: number
  setIsResizing: React.Dispatch<React.SetStateAction<"sidebar" | "session-list" | null>>
}

export function useShellResize({
  isResizing,
  setSidebarWidth,
  resizeHandleRef,
  setSidebarHandleY,
  isSidebarVisible,
  sidebarWidth,
  setSessionListWidth,
  sessionListHandleRef,
  setSessionListHandleY,
  sessionListWidth,
  setIsResizing,
}: useShellResizeInput) {
React.useEffect(() => {
    if (!isResizing) return

    const handleMouseMove = (e: MouseEvent) => {
      if (isResizing === 'sidebar') {
        const newWidth = Math.min(Math.max(e.clientX, 180), 320)
        setSidebarWidth(newWidth)
        if (resizeHandleRef.current) {
          const rect = resizeHandleRef.current.getBoundingClientRect()
          setSidebarHandleY(e.clientY - rect.top)
        }
      } else if (isResizing === 'session-list') {
        const offset = isSidebarVisible ? sidebarWidth : 0
        const newWidth = Math.min(Math.max(e.clientX - offset, 240), 480)
        setSessionListWidth(newWidth)
        if (sessionListHandleRef.current) {
          const rect = sessionListHandleRef.current.getBoundingClientRect()
          setSessionListHandleY(e.clientY - rect.top)
        }
      }
    }

    const handleMouseUp = () => {
      if (isResizing === 'sidebar') {
        storage.set(storage.KEYS.sidebarWidth, sidebarWidth)
        setSidebarHandleY(null)
      } else if (isResizing === 'session-list') {
        storage.set(storage.KEYS.sessionListWidth, sessionListWidth)
        setSessionListHandleY(null)
      }
      setIsResizing(null)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [
    isResizing,
    sidebarWidth,
    sessionListWidth,
    isSidebarVisible, resizeHandleRef, sessionListHandleRef, setIsResizing, setSessionListHandleY, setSessionListWidth, setSidebarHandleY, setSidebarWidth
  ])
return {  }
}
