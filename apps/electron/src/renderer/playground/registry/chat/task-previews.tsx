import * as React from "react";
import type { BackgroundTask } from "@/components/app-shell/ActiveTasksBar";
import { ActiveOptionBadges } from "@/components/app-shell/ActiveOptionBadges";
import { InputContainer } from "@/components/app-shell/input";
import type { StructuredResponse } from "@/components/app-shell/input/structured/types";
import { Button } from "@/components/ui/button";
import { Sparkles } from "lucide-react";
import type { PermissionMode } from "../../../../shared/types";
import { ensureMockElectronAPI, mockInputCallbacks } from "../../mock-utils";
import { sampleBackgroundTasks, veryLongPermissionRequest, samplePermissionRequest } from "./input-fixtures";

/**
 * Contextual wrapper for ActiveTasksBar showing it with messages and input
 */
interface ActiveTasksBarContextProps {
  tasks?: BackgroundTask[]
}

export function ActiveTasksBarContext({ tasks = sampleBackgroundTasks }: ActiveTasksBarContextProps) {
  const [permissionMode, setPermissionMode] = React.useState<PermissionMode>('ask')

  // Inject mock electronAPI for file attachments
  React.useEffect(() => {
    ensureMockElectronAPI()
  }, [])

  return (
    <div className="w-full max-w-[960px] h-full flex flex-col">
      {/* Sample messages for context - matches ChatDisplay padding */}
      <div className="flex-1 overflow-auto px-5 py-8 space-y-2.5">
        {/* User message */}
        <div className="pt-3 flex justify-end">
          <div className="max-w-[80%] rounded-2xl bg-foreground text-background px-4 py-2">
            <p className="text-sm">Can you explore the codebase structure and analyze the API endpoints?</p>
          </div>
        </div>

        {/* Assistant message */}
        <div className="flex justify-start">
          <div className="max-w-[80%] rounded-2xl bg-muted px-4 py-2">
            <p className="text-sm">I'll explore the codebase and analyze the API endpoints. Let me start by running a background task to search for API route definitions...</p>
          </div>
        </div>
      </div>

      {/* Input area - matches ChatDisplay padding */}
      <div className="mx-auto w-full px-4 pb-4 mt-1" style={{ maxWidth: 'var(--content-max-width, 960px)' }}>
        {/* Active option badges and tasks */}
        <ActiveOptionBadges
          permissionMode={permissionMode}
          onPermissionModeChange={setPermissionMode}
          tasks={tasks}
          sessionId="playground-session"
          onKillTask={(taskId) => console.log('[Playground] Kill task:', taskId)}
        />

        {/* Real InputContainer */}
        <InputContainer
          placeholder="Message Craft Agent..."
          disabled={false}
          isProcessing={false}
          currentModel="claude-sonnet-4-6"
          permissionMode={permissionMode}
          onPermissionModeChange={setPermissionMode}
          workingDirectory="/Users/demo/projects/craft-agent"
          sessionId="playground-session"
          onSubmit={mockInputCallbacks.onSubmit}
          onModelChange={mockInputCallbacks.onModelChange}
          onInputChange={mockInputCallbacks.onInputChange}
          onHeightChange={mockInputCallbacks.onHeightChange}
          onFocusChange={mockInputCallbacks.onFocusChange}
          onWorkingDirectoryChange={mockInputCallbacks.onWorkingDirectoryChange}
          onStop={mockInputCallbacks.onStop}
        />
      </div>
    </div>
  )
}

/**
 * Interactive test component for Permission UI ↔ Input View animation transitions
 * Allows toggling between states to inspect the animate in/out behavior
 */
interface PermissionInputToggleProps {
  autoToggle?: boolean
  autoToggleInterval?: number
  useLongCommand?: boolean
}

export function PermissionInputToggle({ autoToggle = false, autoToggleInterval = 3000, useLongCommand = false }: PermissionInputToggleProps) {
  const [showPermission, setShowPermission] = React.useState(false)
  const [permissionMode, setPermissionMode] = React.useState<PermissionMode>('ask')

  const permissionRequest = useLongCommand ? veryLongPermissionRequest : samplePermissionRequest

  // Auto-toggle for continuous animation testing
  React.useEffect(() => {
    if (!autoToggle) return
    const interval = setInterval(() => {
      setShowPermission(prev => !prev)
    }, autoToggleInterval)
    return () => clearInterval(interval)
  }, [autoToggle, autoToggleInterval])

  // Inject mock electronAPI for file attachments
  React.useEffect(() => {
    ensureMockElectronAPI()
  }, [])

  const handlePermissionResponse = (response: StructuredResponse) => {
    console.log('[Playground] Structured response:', response)
    setShowPermission(false)
  }

  // Build structuredInput state for real InputContainer
  const structuredInput = showPermission ? {
    type: 'permission' as const,
    data: permissionRequest,
  } : undefined

  return (
    <div className="w-full max-w-[960px] h-full flex flex-col px-4 pb-4">
      {/* Spacer to push content to bottom */}
      <div className="flex-1" />

      {/* Control buttons */}
      <div className="flex items-center gap-2 mb-20">
        <Button
          variant={showPermission ? 'default' : 'outline'}
          size="sm"
          onClick={() => setShowPermission(true)}
          className="gap-1.5"
        >
          <Sparkles className="h-3.5 w-3.5" />
          Show Permission
        </Button>
        <Button
          variant={!showPermission ? 'default' : 'outline'}
          size="sm"
          onClick={() => setShowPermission(false)}
          className="gap-1.5"
        >
          Show Input
        </Button>
        <div className="flex-1" />
        <span className="text-xs text-muted-foreground">
          Current: <span className="font-medium">{showPermission ? 'Permission Banner' : 'Input View'}</span>
        </span>
      </div>

      {/* Active option badges */}
      <ActiveOptionBadges
        permissionMode={permissionMode}
        onPermissionModeChange={setPermissionMode}
      />

      {/* Real InputContainer - handles animation automatically */}
      <InputContainer
        placeholder="Message Craft Agent..."
        disabled={false}
        isProcessing={false}
        currentModel="claude-sonnet-4-6"
        permissionMode={permissionMode}
        onPermissionModeChange={setPermissionMode}
        workingDirectory="/Users/demo/projects/craft-agent"
        sessionId="playground-session"
        structuredInput={structuredInput}
        onStructuredResponse={handlePermissionResponse}
        onSubmit={mockInputCallbacks.onSubmit}
        onModelChange={mockInputCallbacks.onModelChange}
        onInputChange={mockInputCallbacks.onInputChange}
        onHeightChange={mockInputCallbacks.onHeightChange}
        onFocusChange={mockInputCallbacks.onFocusChange}
        onWorkingDirectoryChange={mockInputCallbacks.onWorkingDirectoryChange}
        onStop={mockInputCallbacks.onStop}
      />
    </div>
  )
}
