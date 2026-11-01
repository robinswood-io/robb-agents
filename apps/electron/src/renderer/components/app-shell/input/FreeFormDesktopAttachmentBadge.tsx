

import { Paperclip } from 'lucide-react';

import { FreeFormInputContextBadge } from './FreeFormInputContextBadge';

import type { FileAttachment } from '../../../../shared/types';

import { WorkingDirectoryBadge } from "./free-form-input-helpers";

interface FreeFormDesktopAttachmentBadgeProps {
  attachments: FileAttachment[]
  t: import("i18next").TFunction<"translation", undefined>
  isEmptySession: boolean
  handleAttachClick: () => void
  disabled: boolean
  onWorkingDirectoryChange: ((path: string) => void) | undefined
  workingDirectory: string | undefined
  sessionFolderPath: string | undefined
  workspaceId: string | undefined
}

export function FreeFormDesktopAttachmentBadge({
  attachments,
  t,
  isEmptySession,
  handleAttachClick,
  disabled,
  onWorkingDirectoryChange,
  workingDirectory,
  sessionFolderPath,
  workspaceId,
}: FreeFormDesktopAttachmentBadgeProps) {
  return (
<div className="flex items-center gap-1 min-w-32 shrink overflow-hidden">
          {/* 1. Attach Files Badge */}
          <FreeFormInputContextBadge
            icon={<Paperclip className="h-4 w-4" />}
            label={attachments.length > 0
              ? t("chat.filesCount", { count: attachments.length })
              : t("chat.attachFiles")
            }
            isExpanded={isEmptySession}
            hasSelection={attachments.length > 0}
            showChevron={false}
            onClick={handleAttachClick}
            tooltip={t("chat.attachFilesTooltip")}
            disabled={disabled}
          />

          {/* 2. Working Directory Selector Badge */}
          {onWorkingDirectoryChange && (
            <WorkingDirectoryBadge
              workingDirectory={workingDirectory}
              onWorkingDirectoryChange={onWorkingDirectoryChange}
              sessionFolderPath={sessionFolderPath}
              isEmptySession={isEmptySession}
              workspaceId={workspaceId}
            />
          )}
          </div>
  )
}
