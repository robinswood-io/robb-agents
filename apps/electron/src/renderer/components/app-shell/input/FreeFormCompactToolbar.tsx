

import { Paperclip } from 'lucide-react';

import { CompactWorkingDirectorySelector } from '@/components/ui/CompactWorkingDirectorySelector';

import { FreeFormInputContextBadge } from './FreeFormInputContextBadge';

import type { FileAttachment } from '../../../../shared/types';
import { type PermissionMode } from '@craft-agent/shared/agent/modes';
import { type ThinkingLevel } from '@craft-agent/shared/agent/thinking-levels';

import { CompactPermissionModeSelector } from './CompactPermissionModeSelector';
import { CompactModelSelector } from './CompactModelSelector';

interface FreeFormCompactToolbarProps {
  onPermissionModeChange: ((mode: PermissionMode) => void) | undefined
  permissionMode: PermissionMode
  enableCompactModelPicker: boolean
  currentModel: string
  currentConnection: string | undefined
  onModelChange: (model: string | null, connection?: string) => void
  onConnectionChange: ((connectionSlug: string) => void) | undefined
  thinkingLevel: "off" | "low" | "medium" | "high" | "xhigh" | "max"
  onThinkingLevelChange: ((level: ThinkingLevel) => void) | undefined
  isEmptySession: boolean
  connectionUnavailable: boolean
  contextStatus: { isCompacting?: boolean; inputTokens?: number; contextWindow?: number; } | undefined
  isProcessing: boolean
  attachments: FileAttachment[]
  t: import("i18next").TFunction<"translation", undefined>
  handleAttachClick: () => void
  disabled: boolean
  onWorkingDirectoryChange: ((path: string) => void) | undefined
  workingDirectory: string | undefined
  sessionFolderPath: string | undefined
  workspaceId: string | undefined
}

export function FreeFormCompactToolbar({
  onPermissionModeChange,
  permissionMode,
  enableCompactModelPicker,
  currentModel,
  currentConnection,
  onModelChange,
  onConnectionChange,
  thinkingLevel,
  onThinkingLevelChange,
  isEmptySession,
  connectionUnavailable,
  contextStatus,
  isProcessing,
  attachments,
  t,
  handleAttachClick,
  disabled,
  onWorkingDirectoryChange,
  workingDirectory,
  sessionFolderPath,
  workspaceId,
}: FreeFormCompactToolbarProps) {
  return (
<div className="flex items-center gap-1 min-w-0 shrink overflow-hidden">
          {onPermissionModeChange && (
            <CompactPermissionModeSelector
              permissionMode={permissionMode}
              onPermissionModeChange={onPermissionModeChange}
            />
          )}
          {enableCompactModelPicker && (
            <CompactModelSelector
              currentModel={currentModel}
              currentConnection={currentConnection}
              onModelChange={onModelChange}
              onConnectionChange={onConnectionChange}
              thinkingLevel={thinkingLevel}
              onThinkingLevelChange={onThinkingLevelChange}
              isEmptySession={isEmptySession}
              connectionUnavailable={connectionUnavailable}
              contextStatus={contextStatus}
              disabled={isProcessing}
            />
          )}
          <FreeFormInputContextBadge
            icon={<Paperclip className="h-4 w-4" />}
            label={attachments.length > 0
              ? t("chat.filesCount", { count: attachments.length })
              : t("chat.attach")
            }
            isExpanded={false}
            hasSelection={attachments.length > 0}
            showChevron={false}
            iconOnly
            onClick={handleAttachClick}
            tooltip={t("chat.attachFilesTooltip")}
            disabled={disabled}
          />
          {onWorkingDirectoryChange && (
            <CompactWorkingDirectorySelector
              workingDirectory={workingDirectory}
              onWorkingDirectoryChange={onWorkingDirectoryChange}
              sessionFolderPath={sessionFolderPath}
              isEmptySession={false}
              workspaceId={workspaceId}
            />
          )}
          </div>
  )
}
