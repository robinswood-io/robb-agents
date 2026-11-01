import { useMemo } from "react";
import { BrowserTabStrip } from "@/components/browser/BrowserTabStrip";
import type { BrowserTabStripMode, BrowserTabStripMockPreset } from "./tab-presets";
import { MOCK_BROWSER_PRESETS } from "./tab-presets";

export function BrowserTabStripPlayground({
  activeSessionId,
  mode,
  mockPreset,
}: {
  activeSessionId: string
  mode: BrowserTabStripMode
  mockPreset: BrowserTabStripMockPreset
}) {
  const hasBrowserPaneBridge = typeof window !== 'undefined' && !!window.electronAPI?.browserPane
  const resolvedMode: Exclude<BrowserTabStripMode, 'auto'> = mode === 'auto'
    ? (hasBrowserPaneBridge ? 'live' : 'mock')
    : mode

  const mockInstances = useMemo(() => {
    const items = [...(MOCK_BROWSER_PRESETS[mockPreset] ?? MOCK_BROWSER_PRESETS.default)]
    if (!activeSessionId) return items

    items.sort((a, b) => {
      const aInActiveSession = a.boundSessionId === activeSessionId ? 0 : 1
      const bInActiveSession = b.boundSessionId === activeSessionId ? 0 : 1
      if (aInActiveSession !== bInActiveSession) return aInActiveSession - bInActiveSession
      return a.id.localeCompare(b.id)
    })

    return items
  }, [activeSessionId, mockPreset])

  if (resolvedMode === 'live' && !hasBrowserPaneBridge) {
    return (
      <div className="w-full max-w-[900px] p-6 rounded-xl border border-border bg-background shadow-sm">
        <div className="text-sm font-medium mb-2">Top Bar Browser Strip</div>
        <p className="text-xs text-foreground/60">
          Live mode requires Electron preload APIs (`window.electronAPI.browserPane`), which are not available in plain browser context.
          Switch mode to Auto or Mock for visual review here.
        </p>
      </div>
    )
  }

  return (
    <div className="w-full max-w-[900px] p-6 rounded-xl border border-border bg-background shadow-sm">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium">Top Bar Browser Strip</h3>
        <span className="text-xs text-foreground/50">
          {resolvedMode === 'live' ? 'Live data from browser registry' : 'Mock preview states'}
        </span>
      </div>
      {resolvedMode === 'mock' && (
        <div className="text-xs text-foreground/50 mb-2">
          {mockInstances.length} tabs • {mockInstances.filter(i => i.isLoading).length} loading • {mockInstances.filter(i => !i.isVisible).length} hidden • {mockInstances.filter(i => i.agentControlActive).length} agent-controlled
        </div>
      )}
      <div className="h-[48px] px-3 rounded-lg border border-foreground/[0.08] bg-background flex items-center justify-end gap-1">
        <BrowserTabStrip
          activeSessionId={activeSessionId || null}
          instancesOverride={resolvedMode === 'mock' ? mockInstances : undefined}
        />
      </div>
      <p className="text-xs text-foreground/50 mt-3">
        Accent 1px border indicates a browser currently controlled by an agent.
      </p>
    </div>
  )
}
