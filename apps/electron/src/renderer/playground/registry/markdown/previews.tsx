import * as React from "react";
import { CollapsibleMarkdownProvider, ImageCardStack, PlatformProvider } from "@craft-agent/ui";
import { MOCK_IMAGE_DATA } from "./fixtures";

// Wrapper for collapsible markdown
export function CollapsibleWrapper({ children }: { children: React.ReactNode }) {
  return <CollapsibleMarkdownProvider>{children}</CollapsibleMarkdownProvider>
}

export function MarkdownImageBlockWrapper({ children }: { children: React.ReactNode }) {
  return (
    <PlatformProvider
      actions={{
        onReadFileDataUrl: async (path: string) => {
          await new Promise((resolve) => setTimeout(resolve, 120))
          const dataUrl = MOCK_IMAGE_DATA[path]
          if (!dataUrl) {
            throw new Error(`Mock image not found for: ${path}`)
          }
          return dataUrl
        },
      }}
    >
      {children}
    </PlatformProvider>
  )
}

export function ImageCardStackPlayground({
  items,
  maxRotate,
}: {
  items: Array<{ src: string; label?: string; ratio?: number }> | string
  maxRotate: number
}) {
  const parsedItems = React.useMemo(() => {
    if (Array.isArray(items)) return items
    if (typeof items === 'string') {
      try {
        const parsed = JSON.parse(items)
        return Array.isArray(parsed) ? parsed : []
      } catch {
        return []
      }
    }
    return []
  }, [items])

  const [currentIndex, setCurrentIndex] = React.useState(0)

  React.useEffect(() => {
    setCurrentIndex(0)
  }, [parsedItems])

  return (
    <div className="h-full w-full p-4 flex flex-col gap-3">
      <div className="text-xs text-muted-foreground flex items-center justify-between">
        <span>Active card: {Math.min(currentIndex + 1, Math.max(parsedItems.length, 1))} / {parsedItems.length}</span>
        <span>Swipe left/right on top card</span>
      </div>
      <div className="flex-1 min-h-0 rounded-md border border-border/60 bg-muted/20 p-4 flex items-center justify-center">
        {parsedItems.length > 0 ? (
          <div className="h-[320px] w-full">
            <ImageCardStack items={parsedItems} currentIndex={currentIndex} onIndexChange={setCurrentIndex} maxRotate={maxRotate} maxHeight={320} />
          </div>
        ) : (
          <div className="h-full w-full flex items-center justify-center text-sm text-muted-foreground">
            Invalid or empty items JSON
          </div>
        )}
      </div>
    </div>
  )
}
