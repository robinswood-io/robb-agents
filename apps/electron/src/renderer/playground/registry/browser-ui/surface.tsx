import { useCallback, useState } from "react";
import { BrowserControls, BrowserEmptyStateCard, TurnCard } from "@craft-agent/ui";
import { AnimatePresence, motion } from "motion/react";
import { EMPTY_STATE_PROMPT_SAMPLES } from "@/components/browser/empty-state-prompts";
import { BROWSER_LIVE_FX_BORDER } from "../../../../shared/browser-live-fx";
import { routes } from "../../../../shared/routes";
import type { BrowserSurfaceMode, BrowserTraceSidebarSampleProps, AgentVisualState, Scenario } from "./scenarios";
import { PLAYGROUND_LIVE_FX_CORNERS, getScenarioTurns, applyRunState, getScenarioResponse, getLiveFxPayloadFromAgentState } from "./scenarios";

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
  className?: string
  mode?: BrowserSurfaceMode
  emptyStateTitle?: string
  emptyStateDescription?: string
  showExamplePrompts?: boolean
  showSafetyHint?: boolean
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

function BrowserEdgeShaderFx({ className = 'absolute inset-0 pointer-events-none z-20', rounded = false }: { className?: string; rounded?: boolean }) {
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

function BrowserTraceSidebarSample({ scenario, runState, sidebarWidth, hdrEffect, cursorPulse }: BrowserTraceSidebarSampleProps) {
  const turns = getScenarioTurns(scenario).map((items, index) => applyRunState(items, runState))

  return (
    <div className="w-full h-[700px] rounded-xl border border-border overflow-hidden bg-background shadow-sm flex">
      <div className="flex-1 relative overflow-hidden">
        {/* Base placeholder browser content */}
        <div className="absolute inset-0 bg-gradient-to-br from-slate-100 via-slate-50 to-slate-100 dark:from-slate-900 dark:via-slate-950 dark:to-slate-900" />

        {/* Shared edge shader effect (same visual as Browser Frame overlay) */}
        {hdrEffect && <BrowserEdgeShaderFx className="absolute inset-0 pointer-events-none z-20" />}

        {/* Cursor pulse simulation */}
        {cursorPulse && (
          <>
            <motion.div
              className="absolute h-6 w-5 z-30 [will-change:transform]"
              style={{ transform: 'translateZ(0)' }}
              initial={false}
              animate={{ x: [220, 300, 430, 330, 220], y: [180, 260, 240, 350, 180], rotate: [0, 2, -3, 1, 0] }}
              transition={{ duration: 6, repeat: Infinity, ease: 'easeInOut' }}
            >
              <div
                className="h-full w-full bg-black shadow-[0_0_12px_rgba(0,0,0,0.35)]"
                style={{
                  clipPath: 'polygon(0% 0%, 0% 100%, 34% 73%, 51% 100%, 66% 94%, 48% 67%, 100% 67%)',
                  borderRadius: '2px',
                  outline: '1px solid rgba(255,255,255,0.75)',
                }}
              />
            </motion.div>
            <motion.div
              className="absolute h-10 w-10 rounded-full border-2 border-cyan-400/65 z-30 [will-change:transform,opacity]"
              style={{ transform: 'translateZ(0)' }}
              initial={{ x: 213, y: 173, opacity: 0.75, scale: 0.55 }}
              animate={{ x: [213, 293, 423, 323, 213], y: [173, 253, 233, 343, 173], opacity: [0.68, 0.16, 0.68, 0.16, 0.68], scale: [0.6, 1.5, 0.6, 1.5, 0.6] }}
              transition={{ duration: 2.8, repeat: Infinity, ease: 'easeInOut' }}
            />
          </>
        )}

        <BrowserMockPageSurface />
      </div>

      <div
        className="h-full border-l border-border bg-background/95 backdrop-blur-sm overflow-y-auto p-3 space-y-3"
        style={{ width: `${sidebarWidth}px` }}
      >
        {turns.map((activities, index) => {
          const isRunning = runState === 'running' && index === turns.length - 1
          const response = getScenarioResponse(scenario, runState)

          return (
            <TurnCard
              key={`browser-trace-turn-${index + 1}`}
              sessionId="playground-browser-session"
              turnId={`browser-trace-turn-${index + 1}`}
              activities={activities}
              response={response}
              intent={index === 0 ? 'Tool execution trace' : 'Wrapper command trace'}
              isStreaming={isRunning}
              isComplete={!isRunning}
              onOpenFile={(path) => console.log('[Playground] Open file:', path)}
              onOpenUrl={(url) => console.log('[Playground] Open URL:', url)}
              compactMode={true}
            />
          )
        })}
      </div>
    </div>
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
