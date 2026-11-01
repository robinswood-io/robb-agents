import { useCallback,useState } from "react";
import { BrowserControls,BrowserEmptyStateCard } from "@craft-agent/ui";
import { AnimatePresence,motion } from "motion/react";
import { EMPTY_STATE_PROMPT_SAMPLES } from "@/components/browser/empty-state-prompts";
import { BROWSER_LIVE_FX_BORDER } from "../../../../shared/browser-live-fx";
import { routes } from "../../../../shared/routes";
import type { BrowserSurfaceMode,AgentVisualState,Scenario } from "./scenarios";
import { PLAYGROUND_LIVE_FX_CORNERS,getLiveFxPayloadFromAgentState } from "./scenarios";

function BrowserAgentEmptyState({
  title,
  description,
  showExamplePrompts,
  showSafetyHint,
}: {
  title: string
  description: string
  showExamplePrompts: boolean
  showSafetyHint: boolean
}) {
  const handlePromptSelect = useCallback(async (prompt: string) => {
    const deepLinkRoute = routes.action.newSession({ input: prompt, send: true })
    const deepLinkUrl = `craftagents://${deepLinkRoute}`

    try {
      if (typeof window !== 'undefined' && window.electronAPI?.openUrl) {
        await window.electronAPI.openUrl(deepLinkUrl)
        return
      }

      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(prompt)
      }
      console.info('[BrowserEmptyState] Prompt copied (Electron API unavailable):', prompt)
    } catch (error) {
      console.warn('[BrowserEmptyState] Failed to open prompt deep link:', error)
    }
  }, [])

  return (
    <BrowserEmptyStateCard
      title={title}
      description={description}
      prompts={EMPTY_STATE_PROMPT_SAMPLES}
      showExamplePrompts={showExamplePrompts}
      showSafetyHint={showSafetyHint}
      onPromptSelect={(sample) => void handlePromptSelect(sample.full)}
    />
  )
}

function BrowserMockPageSurface({
  className,
  mode = 'content',
  emptyStateTitle = 'This browser is ready for your Agents - and you ;)',
  emptyStateDescription = 'Ask any session to use this browser (or open another one) to complete tasks like research, form filling, QA checks, or data extraction.',
  showExamplePrompts = true,
  showSafetyHint = true,
}: {
  className?: string | undefined
  mode?: BrowserSurfaceMode | undefined
  emptyStateTitle?: string | undefined
  emptyStateDescription?: string | undefined
  showExamplePrompts?: boolean | undefined
  showSafetyHint?: boolean | undefined
}) {
  if (mode === 'empty-state') {
    return (
      <div className={className ?? 'absolute inset-0 p-6 z-10'}>
        <BrowserAgentEmptyState
          title={emptyStateTitle}
          description={emptyStateDescription}
          showExamplePrompts={showExamplePrompts}
          showSafetyHint={showSafetyHint}
        />
      </div>
    )
  }

  return (
    <div className={className ?? 'absolute inset-0 p-6 z-10'}>
      <div className="h-10 rounded-lg border border-foreground/10 bg-background/80 backdrop-blur-sm" />
      <div className="mt-4 grid grid-cols-3 gap-3">
        <div className="h-24 rounded-lg bg-foreground/5" />
        <div className="h-24 rounded-lg bg-foreground/5" />
        <div className="h-24 rounded-lg bg-foreground/5" />
      </div>
      <div className="mt-4 space-y-2">
        <div className="h-4 w-[70%] rounded bg-foreground/10" />
        <div className="h-4 w-[85%] rounded bg-foreground/8" />
        <div className="h-4 w-[60%] rounded bg-foreground/10" />
      </div>
    </div>
  )
}

function BrowserEdgeShaderFx({ className = 'absolute inset-0 pointer-events-none z-20', rounded = false }: { className?: string | undefined; rounded?: boolean | undefined }) {
  return (
    <div
      className={className}
      style={{
        borderTopLeftRadius: rounded ? PLAYGROUND_LIVE_FX_CORNERS.topLeft : undefined,
        borderTopRightRadius: rounded ? PLAYGROUND_LIVE_FX_CORNERS.topRight : undefined,
        borderBottomLeftRadius: rounded ? PLAYGROUND_LIVE_FX_CORNERS.bottomLeft : undefined,
        borderBottomRightRadius: rounded ? PLAYGROUND_LIVE_FX_CORNERS.bottomRight : undefined,
        borderWidth: BROWSER_LIVE_FX_BORDER.width,
        borderStyle: BROWSER_LIVE_FX_BORDER.style,
        borderColor: BROWSER_LIVE_FX_BORDER.color,
        boxShadow: BROWSER_LIVE_FX_BORDER.boxShadow,
      }}
    />
  )
}


export function BrowserFramePlayground({
  initialUrl,
  loading,
  agentState,
  themeColor,
  surfaceMode,
  emptyStateTitle,
  emptyStateDescription,
  showExamplePrompts,
  showSafetyHint,
}: {
  initialUrl: string
  loading: boolean
  agentState: AgentVisualState
  themeColor: string
  surfaceMode: BrowserSurfaceMode
  emptyStateTitle: string
  emptyStateDescription: string
  showExamplePrompts: boolean
  showSafetyHint: boolean
}) {
  const [url, setUrl] = useState(initialUrl)
  const scenario: Scenario = 'full-matrix'
  const liveFx = getLiveFxPayloadFromAgentState(scenario, agentState)

  return (
    <div className="w-full h-[700px] rounded-xl border border-border overflow-hidden bg-background shadow-sm flex">
      <div className="flex-1 min-w-0">
        <BrowserControls
          url={url}
          loading={loading}
          onNavigate={setUrl}
          onUrlChange={setUrl}
          themeColor={themeColor || undefined}
          urlBarClassName="max-w-[600px]"
          className="border-b-0"
        />
        <div className="h-[calc(100%-48px)] bg-foreground-2">
          <div className="relative h-full w-full bg-background overflow-hidden">
            <BrowserMockPageSurface
              className="absolute inset-0 p-6"
              mode={surfaceMode}
              emptyStateTitle={emptyStateTitle}
              emptyStateDescription={emptyStateDescription}
              showExamplePrompts={showExamplePrompts}
              showSafetyHint={showSafetyHint}
            />

            <AnimatePresence>
              {liveFx.active && (
                <motion.div
                  className="absolute inset-0 pointer-events-none z-20"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.2, ease: 'easeOut' }}
                >
                  <BrowserEdgeShaderFx className="absolute inset-0" rounded />

                  <div
                    className="absolute text-[11px]"
                    style={{
                      top: '8px',
                      right: '8px',
                      padding: '4px 8px',
                      borderRadius: '7px',
                      font: '11px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif',
                      background: 'rgba(2, 6, 23, 0.82)',
                      color: 'rgba(236, 254, 255, 0.95)',
                      backdropFilter: 'blur(4px)',
                    }}
                  >
                    {liveFx.label}
                  </div>

                  {liveFx.cursor && (
                    <motion.div
                      className="absolute"
                      style={{
                        width: '18px',
                        height: '22px',
                        left: liveFx.cursor.x - 2,
                        top: liveFx.cursor.y - 2,
                        filter: 'drop-shadow(0 0 8px rgba(0,0,0,0.35))',
                      }}
                      initial={{ opacity: 0, scale: 0.95 }}
                      animate={{ opacity: 1, scale: 1 }}
                      transition={{ duration: 0.16, ease: 'easeOut' }}
                    >
                      <div
                        className="h-full w-full bg-black"
                        style={{
                          clipPath: 'polygon(0% 0%, 0% 100%, 34% 73%, 51% 100%, 66% 94%, 48% 67%, 100% 67%)',
                          borderRadius: '2px',
                          outline: '1px solid rgba(255,255,255,0.75)',
                        }}
                      />
                    </motion.div>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>

    </div>
  )
}

export function BrowserEmptyStatePlayground({
  title,
  description,
  showExamplePrompts,
  showSafetyHint,
}: {
  title: string
  description: string
  showExamplePrompts: boolean
  showSafetyHint: boolean
}) {
  return (
    <div className="w-full h-[700px] rounded-xl border border-border overflow-hidden bg-background shadow-sm flex">
      <div className="relative h-full w-full bg-foreground-2 overflow-hidden">
        <BrowserMockPageSurface
          className="absolute inset-0 p-8"
          mode="empty-state"
          emptyStateTitle={title}
          emptyStateDescription={description}
          showExamplePrompts={showExamplePrompts}
          showSafetyHint={showSafetyHint}
        />
      </div>
    </div>
  )
}
