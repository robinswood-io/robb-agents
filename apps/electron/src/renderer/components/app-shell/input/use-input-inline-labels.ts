import * as React from 'react';

import { useInlineLabelMenu } from '@/components/ui/label-menu';
import type { LabelConfig } from '@craft-agent/shared/labels';

import { type RichTextInputHandle } from '@/components/ui/rich-text-input';

import { getEditConfig } from '@/components/ui/EditPopover';

interface useInputInlineLabelsInput {
  richInputRef: React.RefObject<RichTextInputHandle | null>
  labels: LabelConfig[]
  sessionLabels: string[]
  handleLabelSelect: (labelId: string) => void
  sessionStatuses: import("../../ui/session-status-menu").SessionStatus[]
  currentSessionStatus: string | undefined
  workspaceRootPath: string | null
  setInput: React.Dispatch<React.SetStateAction<string>>
  syncToParent: (value: string) => void
  t: import("i18next").TFunction<"translation", undefined>
}

export function useInputInlineLabels({
  richInputRef,
  labels,
  sessionLabels,
  handleLabelSelect,
  sessionStatuses,
  currentSessionStatus,
  workspaceRootPath,
  setInput,
  syncToParent,
  t,
}: useInputInlineLabelsInput) {
const inlineLabel = useInlineLabelMenu({
    inputRef: richInputRef,
    labels,
    sessionLabels,
    onSelect: handleLabelSelect,
    sessionStatuses,
    ...(currentSessionStatus !== undefined ? { activeStateId: currentSessionStatus } : {}),
  })

const [addLabelPopoverOpen, setAddLabelPopoverOpen] = React.useState(false)

const [addLabelPrefill, setAddLabelPrefill] = React.useState('')

const handleAddLabel = React.useCallback((prefill: string) => {
    if (!workspaceRootPath) return

    // Remove the #trigger text from input
    const cleaned = inlineLabel.handleSelect('')
    setInput(cleaned)
    syncToParent(cleaned)
    inlineLabel.close()

    // Store the prefill text (e.g., "Test" from "#Test") to pre-fill the popover
    // Format: "Add new label {prefill}" so user can just press enter or modify
    setAddLabelPrefill(prefill ? t('labels.addNewLabel', { prefill }) : '')

    // Open the EditPopover for label creation
    setAddLabelPopoverOpen(true)
  }, [workspaceRootPath, inlineLabel, syncToParent, t, setInput])

const addLabelEditConfig = React.useMemo(() => {
    if (!workspaceRootPath) return null
    return getEditConfig('add-label', workspaceRootPath)
  }, [workspaceRootPath])
return { inlineLabel, handleAddLabel, addLabelEditConfig, addLabelPopoverOpen, setAddLabelPopoverOpen, addLabelPrefill }
}
