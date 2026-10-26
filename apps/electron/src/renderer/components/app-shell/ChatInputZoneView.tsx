import * as React from "react";

import type { Session, FileAttachment, LoadedSkill } from "../../../shared/types";
import type { PermissionMode } from "@craft-agent/shared/agent/modes";
import type { ThinkingLevel } from "@craft-agent/shared/agent/thinking-levels";

import { ChatInputZone, type StructuredResponse } from "./input";
import type { RichTextInputHandle } from "@/components/ui/rich-text-input";

import { getSessionStatus } from "@/utils/session";

interface ChatInputZoneViewProps {
  compactMode: boolean
  permissionMode: PermissionMode
  onPermissionModeChange: ((mode: PermissionMode) => void) | undefined
  session: Session
  sessionFolderPath: string | undefined
  onInputChange: ((value: string) => void) | undefined
  labels: import("@craft-agent/shared/labels").LabelConfig[] | undefined
  onLabelsChange: ((labels: string[]) => void) | undefined
  sessionStatuses: import("@/config/session-status-config").SessionStatus[] | undefined
  onSessionStatusChange: ((stateId: string) => void) | undefined
  placeholder: string | string[] | undefined
  isInputDisabled: boolean
  isConversationProcessing: boolean
  handleAnimatedHeightChange: (delta: number) => void
  handleSubmit: (message: string, attachments?: FileAttachment[], skillSlugs?: string[]) => void
  handleStop: (silent?: boolean) => void
  textareaRef: React.RefObject<RichTextInputHandle | null>
  currentModel: string
  onModelChange: (model: string | null, connection?: string) => void
  thinkingLevel: "off" | "low" | "medium" | "high" | "xhigh" | "max"
  onThinkingLevelChange: ((level: ThinkingLevel) => void) | undefined
  enabledModes: PermissionMode[] | undefined
  enableCompactModelPicker: boolean
  structuredInput: import("./input").StructuredInputData | undefined
  handleStructuredResponse: (response: StructuredResponse) => void | Promise<void>
  inputValue: string | undefined
  attachmentsValue: FileAttachment[] | undefined
  onAttachmentsChange: ((attachments: FileAttachment[]) => void) | undefined
  skills: LoadedSkill[] | undefined
  workspaceId: string | undefined
  workingDirectory: string | undefined
  onWorkingDirectoryChange: ((path: string) => void) | undefined
  disableSend: boolean
  connectionUnavailable: boolean
  onConnectionChange: ((connectionSlug: string) => void) | undefined
  followUpInputItems: { id: string; messageId: string; annotationId: string; index: number; noteLabel: string; selectedText: string; color: string | undefined; }[]
  handleFollowUpChipClick: (item: { messageId: string; annotationId: string; }, anchor?: { x: number; y: number; }) => void
  handleFollowUpIndexClick: (item: { messageId: string; annotationId: string; }) => void
}

export function ChatInputZoneView({
  compactMode,
  permissionMode,
  onPermissionModeChange,
  session,
  sessionFolderPath,
  onInputChange,
  labels,
  onLabelsChange,
  sessionStatuses,
  onSessionStatusChange,
  placeholder,
  isInputDisabled,
  isConversationProcessing,
  handleAnimatedHeightChange,
  handleSubmit,
  handleStop,
  textareaRef,
  currentModel,
  onModelChange,
  thinkingLevel,
  onThinkingLevelChange,
  enabledModes,
  enableCompactModelPicker,
  structuredInput,
  handleStructuredResponse,
  inputValue,
  attachmentsValue,
  onAttachmentsChange,
  skills,
  workspaceId,
  workingDirectory,
  onWorkingDirectoryChange,
  disableSend,
  connectionUnavailable,
  onConnectionChange,
  followUpInputItems,
  handleFollowUpChipClick,
  handleFollowUpIndexClick,
}: ChatInputZoneViewProps) {
  return (
<ChatInputZone
            compactMode={compactMode}
            permissionMode={permissionMode}
            onPermissionModeChange={onPermissionModeChange}
            sessionId={session.id}
            sessionFolderPath={sessionFolderPath}
            onInsertMessage={onInputChange}
            sessionLabels={session.labels}
            labels={labels}
            onLabelsChange={onLabelsChange}
            sessionStatuses={sessionStatuses}
            currentSessionStatus={getSessionStatus(session)}
            onSessionStatusChange={onSessionStatusChange}
            inputProps={{
              placeholder,
              disabled: isInputDisabled,
              isProcessing: isConversationProcessing,
              onAnimatedHeightChange: handleAnimatedHeightChange,
              onSubmit: handleSubmit,
              onStop: handleStop,
              textareaRef,
              currentModel,
              onModelChange,
              thinkingLevel,
              onThinkingLevelChange,
              enabledModes,
              enableCompactModelPicker,
              structuredInput,
              onStructuredResponse: handleStructuredResponse,
              inputValue,
              onInputChange,
              attachmentsValue,
              onAttachmentsChange,
              skills,
              workspaceId,
              workingDirectory,
              onWorkingDirectoryChange,
              disableSend: disableSend || connectionUnavailable,
              connectionUnavailable,
              isEmptySession: session.messages.length === 0,
              currentConnection: session.llmConnection,
              onConnectionChange,
              followUpItems: followUpInputItems,
              onFollowUpClick: handleFollowUpChipClick,
              onFollowUpIndexClick: handleFollowUpIndexClick,
            }}
          />
  )
}
