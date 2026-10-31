/**
 * Automations Playground Registry
 *
 * Registry entries for all automation UI components with comprehensive mock data
 * and playground variants for testing every visual state.
 */
import { useState, type ReactNode } from "react";
import { AutomationsListPanel } from "@/components/automations/AutomationsListPanel";
import { AutomationInfoPage } from "@/components/automations/AutomationInfoPage";
import { AutomationCard } from "@/components/automations/AutomationCard";
import { AutomationAvatar } from "@/components/automations/AutomationAvatar";
import { CronBuilder } from "@/components/automations/CronBuilder";
import { getEventDisplayName, type AutomationListItem, type ExecutionEntry, type TestResult, type AutomationTrigger } from "@/components/automations/types";

// ============================================================================
// Wrappers
// ============================================================================

export function PaddedWrapper({ children }: { children: ReactNode }) {
  return <div className="p-6">{children}</div>
}

/** Stateful wrapper for AutomationsListPanel */
export function AutomationsListPanelPlayground({
  automations,
  selectedAutomationId: initialSelectedId,
}: {
  automations: AutomationListItem[]
  selectedAutomationId?: string | null | undefined
}) {
  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedId ?? null)
  const [automationList, setAutomationList] = useState(automations)

  return (
    <AutomationsListPanel
      automations={automationList}
      selectedAutomationId={selectedId}
      onAutomationClick={(id) => setSelectedId(id)}
      onDeleteAutomation={(id) => {
        setAutomationList(prev => prev.filter(h => h.id !== id))
        if (selectedId === id) setSelectedId(null)
      }}
      onToggleAutomation={(id) => {
        setAutomationList(prev => prev.map(h =>
          h.id === id ? { ...h, enabled: !h.enabled } : h
        ))
      }}
      onTestAutomation={(id) => console.log('[Playground] Test automation:', id)}
      onDuplicateAutomation={(id) => console.log('[Playground] Duplicate automation:', id)}
    />
  )
}

/** Stateful wrapper for AutomationInfoPage with test simulation */
export function AutomationInfoPagePlayground({
  automation,
  executions,
}: {
  automation: AutomationListItem
  executions?: ExecutionEntry[] | undefined
}) {
  const [currentAutomation, setCurrentAutomation] = useState(automation)
  const [testResult, setTestResult] = useState<TestResult>({ state: 'idle' })

  const handleTest = () => {
    setTestResult({ state: 'running' })
    setTimeout(() => {
      setTestResult({
        state: 'success',
        duration: 42,
      })
    }, 1500)
  }

  return (
    <AutomationInfoPage
      automation={currentAutomation}
      executions={executions}
      testResult={testResult}
      onToggleEnabled={() => setCurrentAutomation(prev => ({ ...prev, enabled: !prev.enabled }))}
      onTest={handleTest}
      onDuplicate={() => console.log('[Playground] Duplicate')}
      onDelete={() => console.log('[Playground] Delete')}
    />
  )
}

/** Stateful wrapper for CronBuilder */
export function CronBuilderPlayground({
  initialValue,
  timezone,
}: {
  initialValue?: string | undefined
  timezone?: string | undefined
}) {
  const [value, setValue] = useState(initialValue ?? '0 9 * * 1-5')

  return (
    <CronBuilder
      value={value}
      onChange={setValue}
      timezone={timezone}
    />
  )
}

/** Wrapper showing all AutomationAvatar variants in a grid */
export function AutomationAvatarGallery() {
  const events: AutomationTrigger[] = [
    'SchedulerTick', 'LabelAdd', 'LabelRemove', 'LabelConfigChange',
    'PermissionModeChange', 'FlagChange', 'TodoStateChange',
    'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
    'Notification', 'UserPromptSubmit', 'SessionStart', 'SessionEnd',
    'Stop', 'SubagentStart', 'SubagentStop', 'PreCompact',
    'PermissionRequest', 'Setup',
  ]

  return (
    <div className="space-y-6">
      {/* Size variants */}
      <div>
        <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">Sizes</h4>
        <div className="flex items-end gap-4">
          {(['xs', 'sm', 'md', 'lg'] as const).map(size => (
            <div key={size} className="flex flex-col items-center gap-1">
              <AutomationAvatar event="SchedulerTick" size={size} />
              <span className="text-[10px] text-muted-foreground">{size}</span>
            </div>
          ))}
        </div>
      </div>

      {/* All event types */}
      <div>
        <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">All Events</h4>
        <div className="grid grid-cols-4 gap-3">
          {events.map(event => (
            <div key={event} className="flex items-center gap-2">
              <AutomationAvatar event={event} size="md" />
              <span className="text-xs text-foreground/70 truncate">{getEventDisplayName(event)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

/** Stateful wrapper for AutomationCard */
export function AutomationCardPlayground({
  automation,
  defaultExpanded,
}: {
  automation: AutomationListItem
  defaultExpanded?: boolean | undefined
}) {
  const [currentAutomation, setCurrentAutomation] = useState(automation)

  return (
    <AutomationCard
      automation={currentAutomation}
      defaultExpanded={defaultExpanded}
      onToggleEnabled={(enabled) => setCurrentAutomation(prev => ({ ...prev, enabled }))}
      onTest={() => console.log('[Playground] Test automation:', currentAutomation.id)}
    />
  )
}
