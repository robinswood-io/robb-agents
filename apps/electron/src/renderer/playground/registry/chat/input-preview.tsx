import * as React from "react";
import { ChatInputZone } from "@/components/app-shell/input";
import { setRecentWorkingDirs } from "@/components/app-shell/input/working-directory-history";
import type { PermissionMode } from "../../../../shared/types";
import { AppShellProvider } from "@/context/AppShellContext";
import { ModalProvider } from "@/context/ModalContext";
import { ensureMockElectronAPI, mockInputCallbacks, sampleImageAttachment, samplePdfAttachment } from "../../mock-utils";
import { mockAdminApprovalRequest } from "../../adapters/input-adapters";
import { getRecentDirsForScenario, type RecentDirScenario } from "../../recent-working-dirs";
import { inputContainerSampleLabels, sampleCodeAttachment, samplePermissionRequest, playgroundAppShellContext, sampleBackgroundTasks, inputContainerSampleStatuses } from "./input-fixtures";

type InputContainerMode = 'freeform' | 'permission' | 'admin_approval'

interface InputContainerPlaygroundProps {
  disabled?: boolean | undefined
  isProcessing?: boolean | undefined
  placeholder?: string | undefined
  currentModel?: string | undefined
  permissionMode?: PermissionMode | undefined
  workingDirectory?: string | undefined
  inputMode?: InputContainerMode | undefined
  compactMode?: boolean | undefined
  showOptionBadges?: boolean | undefined
  showTasks?: boolean | undefined
  showLabels?: boolean | undefined
  showStatuses?: boolean | undefined
  labelCount?: number | undefined
  showWorkingDirectory?: boolean | undefined
  seedRecentDirs?: boolean | undefined
  recentDirScenario?: RecentDirScenario | undefined
  showAttachments?: boolean | undefined
  attachmentCount?: number | undefined
  showFollowUps?: boolean | undefined
  followUpCount?: number | undefined
}

export function InputContainerPlayground({
  disabled = false,
  isProcessing = false,
  placeholder = 'Message Craft Agent...',
  currentModel = 'claude-sonnet-4-6',
  permissionMode = 'ask',
  workingDirectory = '/Users/demo/projects/craft-agent',
  inputMode = 'freeform',
  compactMode = false,
  showOptionBadges = true,
  showTasks = true,
  showLabels = true,
  showStatuses = true,
  labelCount = 3,
  showWorkingDirectory = true,
  seedRecentDirs = true,
  recentDirScenario = 'few',
  showAttachments = false,
  attachmentCount = 2,
  showFollowUps = false,
  followUpCount = 2,
}: InputContainerPlaygroundProps) {
  const playgroundSessionId = 'playground-session'
  const [model, setModel] = React.useState(currentModel)
  const [mode, setMode] = React.useState<PermissionMode>(permissionMode)
  const [inputValue, setInputValue] = React.useState('')
  const [currentSessionStatus, setCurrentSessionStatus] = React.useState('in-progress')
  const [cwd, setCwd] = React.useState(workingDirectory)

  React.useEffect(() => {
    ensureMockElectronAPI()
  }, [])

  React.useEffect(() => {
    if (!seedRecentDirs) return
    setRecentWorkingDirs(getRecentDirsForScenario(recentDirScenario))
  }, [seedRecentDirs, recentDirScenario])

  React.useEffect(() => {
    setModel(currentModel)
  }, [currentModel])

  React.useEffect(() => {
    setMode(permissionMode)
  }, [permissionMode])

  React.useEffect(() => {
    setCwd(workingDirectory)
  }, [workingDirectory])

  const labels = React.useMemo(() => inputContainerSampleLabels.slice(0, Math.max(1, Math.min(labelCount, inputContainerSampleLabels.length))), [labelCount])

  const [sessionLabels, setSessionLabels] = React.useState<string[]>(['bug', 'priority::2', 'sprint::Q1-S3'])

  React.useEffect(() => {
    const next = labels.map((label) => {
      if (label.id === 'priority') return 'priority::2'
      if (label.id === 'due-date') return 'due-date::2026-03-15'
      if (label.id === 'sprint') return 'sprint::Q1-S3'
      return label.id
    })
    setSessionLabels(next)
  }, [labels])

  const followUpItems = React.useMemo(() => {
    const samples = [
      {
        id: 'fu-a',
        messageId: 'assistant-msg-1',
        annotationId: 'annotation-1',
        index: 1,
        noteLabel: 'Prevent stale token from discarding draft input.',
        selectedText: 'Include OAuth refresh edge cases',
        color: 'info',
      },
      {
        id: 'fu-b',
        messageId: 'assistant-msg-1',
        annotationId: 'annotation-2',
        index: 2,
        noteLabel: 'Check compact mode and quick mode switching.',
        selectedText: 'Validate animation with permission mode transitions',
        color: 'info',
      },
      {
        id: 'fu-c',
        messageId: 'assistant-msg-2',
        annotationId: 'annotation-3',
        index: 3,
        noteLabel: 'Review spacing and overflow for label/source badge density.',
        selectedText: 'Review label + source badge density on narrow widths',
        color: 'info',
      },
      {
        id: 'fu-d',
        messageId: 'assistant-msg-3',
        annotationId: 'annotation-4',
        index: 4,
        noteLabel: 'Add chip click affordance for jumping back to annotation',
        selectedText: 'Add chip click affordance for jumping back to annotation',
        color: 'info',
      },
    ]
    if (!showFollowUps) return []
    return samples.slice(0, Math.max(1, Math.min(followUpCount, samples.length)))
  }, [showFollowUps, followUpCount])

  const attachmentFiles = React.useMemo(() => {
    if (!showAttachments) return [] as File[]

    const imageBytes = sampleImageAttachment.base64
      ? Uint8Array.from(atob(sampleImageAttachment.base64), char => char.charCodeAt(0))
      : new Uint8Array([137, 80, 78, 71])

    const samples: File[] = [
      new File([imageBytes], sampleImageAttachment.name, { type: sampleImageAttachment.mimeType }),
      new File(['%PDF-1.4\n% Playground sample\n'], samplePdfAttachment.name, { type: samplePdfAttachment.mimeType }),
      new File(['export function App() {\n  return <div>Hello Playground</div>\n}\n'], sampleCodeAttachment.name, { type: sampleCodeAttachment.mimeType }),
    ]

    return samples.slice(0, Math.max(1, Math.min(attachmentCount, samples.length)))
  }, [showAttachments, attachmentCount])

  const attachmentSeedKey = React.useMemo(() => {
    if (!showAttachments) return 'none'
    return attachmentFiles.map(file => `${file.name}:${file.size}`).join('|')
  }, [showAttachments, attachmentFiles])

  React.useEffect(() => {
    if (!showAttachments || attachmentFiles.length === 0) return

    const timer = setTimeout(() => {
      window.dispatchEvent(new CustomEvent('craft:paste-files', {
        detail: {
          files: attachmentFiles,
          sessionId: playgroundSessionId,
        },
      }))
    }, 0)

    return () => clearTimeout(timer)
  }, [showAttachments, attachmentSeedKey, attachmentFiles, playgroundSessionId])

  const structuredInput = React.useMemo(() => {
    if (inputMode === 'permission') {
      return {
        type: 'permission' as const,
        data: samplePermissionRequest,
      }
    }

    if (inputMode === 'admin_approval') {
      return {
        type: 'admin_approval' as const,
        request: {
          ...samplePermissionRequest,
          requestId: 'admin-approval-1',
          type: 'admin_approval' as const,
        },
        data: mockAdminApprovalRequest({
          appName: 'Docker Desktop',
          reason: 'Homebrew needs admin access to complete post-install steps.',
          impact: 'May install files in /Applications and system-managed directories.',
          command: 'brew install --cask docker',
        }),
      }
    }

    return undefined
  }, [inputMode])

  return (
    <ModalProvider>
    <AppShellProvider value={playgroundAppShellContext}>
      <div className="w-full h-full flex flex-col bg-background">
        <div className="flex-1" />

        <ChatInputZone
          key={`input:${inputMode}:${compactMode ? 'compact' : 'full'}:${showAttachments ? attachmentSeedKey : 'none'}:${showFollowUps ? followUpCount : 0}:${seedRecentDirs ? recentDirScenario : 'unseeded'}`}
          compactMode={compactMode}
          showOptionBadges={showOptionBadges}
          permissionMode={mode}
          onPermissionModeChange={setMode}
          tasks={showTasks ? sampleBackgroundTasks : []}
          sessionId={playgroundSessionId}
          onKillTask={(taskId) => console.log('[Playground] Kill task:', taskId)}
          onInsertMessage={setInputValue}
          sessionLabels={showLabels ? sessionLabels : []}
          labels={showLabels ? labels : []}
          onLabelsChange={setSessionLabels}
          sessionStatuses={showStatuses ? inputContainerSampleStatuses : []}
          currentSessionStatus={showStatuses ? currentSessionStatus : undefined}
          onSessionStatusChange={setCurrentSessionStatus}
          inputProps={{
            placeholder,
            disabled,
            isProcessing,
            ...(structuredInput !== undefined ? { structuredInput: structuredInput } : {}),
            onStructuredResponse: (response) => {
              console.log('[Playground] Structured response:', response)
            },
            currentModel: model,
            workingDirectory: showWorkingDirectory ? cwd : undefined,
            onWorkingDirectoryChange: showWorkingDirectory ? setCwd : undefined,
            followUpItems,
            onSubmit: mockInputCallbacks.onSubmit,
            onModelChange: (nextModel) => {
              if (nextModel !== null) setModel(nextModel)
            },
            onInputChange: setInputValue,
            inputValue,
            onHeightChange: mockInputCallbacks.onHeightChange,
            onFocusChange: mockInputCallbacks.onFocusChange,
            onStop: mockInputCallbacks.onStop,
          }}
        />
      </div>
    </AppShellProvider>
    </ModalProvider>
  )
}
