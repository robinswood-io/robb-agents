
import { useTranslation } from "react-i18next";

import { Icon_Home } from '@craft-agent/ui';

import { isMac } from '@/lib/platform';

import { FreeFormInputContextBadge } from './FreeFormInputContextBadge';

import { WorkingDirectorySelector, formatPathForDisplay } from './WorkingDirectorySelector';

export function formatFollowUpChipText(text: string, fallback: string, maxLength = 50): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (!normalized) return fallback

  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength - 1).trimEnd()}…`
    : normalized
}

export const cmdKey = isMac ? '⌘' : 'Ctrl'

export function shuffleArray<T>(array: T[]): T[] {
  const shuffled = [...array]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    // Both indices are within the copied array; T itself may include undefined.
    [shuffled[i], shuffled[j]] = [shuffled[j] as T, shuffled[i] as T]
  }
  return shuffled
}

export function WorkingDirectoryBadge({
  workingDirectory,
  onWorkingDirectoryChange,
  sessionFolderPath,
  isEmptySession = false,
  workspaceId,
}: {
  workingDirectory?: string | undefined
  onWorkingDirectoryChange: (path: string) => void
  sessionFolderPath?: string | undefined
  isEmptySession?: boolean | undefined
  workspaceId?: string | undefined
}) {
  const { t } = useTranslation()
  return (
    <WorkingDirectorySelector
      workingDirectory={workingDirectory}
      onWorkingDirectoryChange={onWorkingDirectoryChange}
      sessionFolderPath={sessionFolderPath}
      workspaceId={workspaceId}
      renderTrigger={({ open, hasFolder, folderName, workingDirectory: wd, homeDir, gitBranch }) => (
        <span className="shrink min-w-0 overflow-hidden">
          <FreeFormInputContextBadge
            icon={<Icon_Home className="h-4 w-4" />}
            label={folderName ?? t('chat.workInFolder')}
            isExpanded={isEmptySession}
            hasSelection={hasFolder}
            showChevron={true}
            isOpen={open}
            tooltip={
              hasFolder ? (
                <span className="flex flex-col gap-0.5">
                  <span className="font-medium">{t("chat.workingDirectory")}</span>
                  <span className="text-xs opacity-70">{formatPathForDisplay(wd, homeDir)}</span>
                  {gitBranch && <span className="text-xs opacity-70">{t("chat.onBranch", { branch: gitBranch })}</span>}
                </span>
              ) : t("chat.chooseWorkingDirectory")
            }
          />
        </span>
      )}
    />
  )
}
