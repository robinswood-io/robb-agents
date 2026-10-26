import * as React from "react";

import { useRef, useState, useEffect, useCallback } from "react";

import { type FilterMode } from "./view-filters";

import type { Workspace } from "../../../shared/types";

import { toast } from "sonner";
import { navigate, routes } from "@/lib/navigate";

interface useShellConfigurationInput {
  activeWorkspace: Workspace | undefined
  viewConfigs: import("@craft-agent/shared/views").ViewConfig[]
  t: import("i18next").TFunction<"translation", undefined>
  listFilter: Map<string, FilterMode>
  labelFilter: Map<string, FilterMode>
  projectFilter: Map<string, FilterMode>
  setSearchActive: React.Dispatch<React.SetStateAction<boolean>>
  setSearchQuery: React.Dispatch<React.SetStateAction<string>>
  focusZone: (id: import("@/context/FocusContext").FocusZoneId, options?: import("@/context/FocusContext").FocusZoneOptions) => void
}

export function useShellConfiguration({
  activeWorkspace,
  viewConfigs,
  t,
  listFilter,
  labelFilter,
  projectFilter,
  setSearchActive,
  setSearchQuery,
  focusZone,
}: useShellConfigurationInput) {
const [editPopoverOpen, setEditPopoverOpen] = useState<'statuses' | 'labels' | 'views' | 'add-source' | 'add-source-api' | 'add-source-mcp' | 'add-source-local' | 'add-skill' | 'add-label' | 'automation-config' | 'add-project' | null>(null)

const editPopoverAnchorY = useRef<number>(120)

const editLabelTargetId = useRef<string | undefined>(undefined)

const editPopoverTriggerRef = useRef<Element | null>(null)

const captureContextMenuPosition = useCallback(() => {
    const trigger = document.querySelector('.group\\/section > [data-state="open"]')
    if (trigger) {
      const rect = trigger.getBoundingClientRect()
      editPopoverAnchorY.current = rect.top
      editPopoverTriggerRef.current = trigger
    }
  }, [])

useEffect(() => {
    const el = editPopoverTriggerRef.current
    if (!el) return
    if (editPopoverOpen) {
      el.setAttribute('data-edit-active', 'true')
    } else {
      el.removeAttribute('data-edit-active')
      editPopoverTriggerRef.current = null
    }
  }, [editPopoverOpen])

const openConfigureStatuses = useCallback(() => {
    captureContextMenuPosition()
    setTimeout(() => setEditPopoverOpen('statuses'), 50)
  }, [captureContextMenuPosition])

const openConfigureLabels = useCallback((labelId?: string) => {
    editLabelTargetId.current = labelId
    captureContextMenuPosition()
    setTimeout(() => setEditPopoverOpen('labels'), 50)
  }, [captureContextMenuPosition])

const openConfigureViews = useCallback(() => {
    captureContextMenuPosition()
    setTimeout(() => setEditPopoverOpen('views'), 50)
  }, [captureContextMenuPosition])

const handleDeleteView = useCallback(async (viewId: string) => {
    if (!activeWorkspace?.id) return
    try {
      const updated = viewConfigs.filter(v => v.id !== viewId)
      await window.electronAPI.saveViews(activeWorkspace.id, updated)
    } catch (err) {
      console.error('[AppShell] Failed to delete view:', err)
    }
  }, [activeWorkspace?.id, viewConfigs])

const handleAddLabel = useCallback((parentId?: string) => {
    editLabelTargetId.current = parentId
    captureContextMenuPosition()
    setTimeout(() => setEditPopoverOpen('add-label'), 50)
  }, [captureContextMenuPosition])

const handleDeleteLabel = useCallback(async (labelId: string) => {
    if (!activeWorkspace?.id) return
    try {
      await window.electronAPI.deleteLabel(activeWorkspace.id, labelId)
    } catch (err) {
      console.error('[AppShell] Failed to delete label:', err)
    }
  }, [activeWorkspace?.id])

const openAddSource = useCallback((sourceType?: 'api' | 'mcp' | 'local') => {
    captureContextMenuPosition()
    const key = sourceType ? `add-source-${sourceType}` as const : 'add-source' as const
    setTimeout(() => setEditPopoverOpen(key), 50)
  }, [captureContextMenuPosition])

const openAddSkill = useCallback(() => {
    captureContextMenuPosition()
    setTimeout(() => setEditPopoverOpen('add-skill'), 50)
  }, [captureContextMenuPosition])

const openAddAutomation = useCallback(() => {
    captureContextMenuPosition()
    setTimeout(() => setEditPopoverOpen('automation-config'), 50)
  }, [captureContextMenuPosition])

const [createProjectDialogOpen, setCreateProjectDialogOpen] = useState(false)

const openAddProject = useCallback(() => {
    if (!activeWorkspace?.id) return
    setCreateProjectDialogOpen(true)
  }, [activeWorkspace?.id])

const handleCreateProjectSubmit = useCallback(async (name: string) => {
    if (!activeWorkspace?.id) return
    setCreateProjectDialogOpen(false)
    try {
      const project = await window.electronAPI.createProject(activeWorkspace.id, { name })
      navigate(routes.view.projects(project.slug))
    } catch (err) {
      console.error('[AppShell] Failed to create project:', err)
      toast.error(t('projectsList.createFailed'))
    }
  }, [activeWorkspace?.id, t])

const resolveInheritedNewSessionParams = useCallback((): { status?: string; label?: string; project?: string } | null => {
    const statusCount = listFilter.size
    const labelCount = labelFilter.size
    const projectCount = projectFilter.size
    const total = statusCount + labelCount + projectCount
    if (total !== 1) return null
    if (statusCount === 1) {
      const [stateId] = [...listFilter.keys()]
      return { status: stateId }
    }
    if (labelCount === 1) {
      const [labelId] = [...labelFilter.keys()]
      return { label: labelId }
    }
    if (projectCount === 1) {
      const [projectId] = [...projectFilter.keys()]
      return { project: projectId }
    }
    return null
  }, [listFilter, labelFilter, projectFilter])

const handleNewChat = useCallback((newPanel: boolean = false) => {
    if (!activeWorkspace) return

    // Exit search mode and switch to All Sessions
    setSearchActive(false)
    setSearchQuery('')

    // Inherit sole-active filter into the new session when unambiguous.
    const inherited = resolveInheritedNewSessionParams()

    // Delegate to NavigationContext which handles session creation
    navigate(
      routes.action.newSession(inherited ?? undefined),
      newPanel ? { newPanel: true, targetLaneId: 'main' } : undefined
    )

    // Focus the chat input after navigation completes
    setTimeout(() => focusZone('chat', { intent: 'programmatic' }), 50)
  }, [activeWorkspace, focusZone, resolveInheritedNewSessionParams, setSearchActive, setSearchQuery])

const handleNewBrowserWindow = useCallback(async () => {
    try {
      const instanceId = await window.electronAPI.browserPane.create({
        show: true,
      })
      await window.electronAPI.browserPane.focus(instanceId)
    } catch (error) {
      console.error('[Chat] Failed to create browser window:', error)
      toast.error(t('toast.failedToCreateBrowser'))
    }
  }, [ t])

const handleDeleteSource = useCallback(async (sourceSlug: string) => {
    if (!activeWorkspace) return
    try {
      await window.electronAPI.deleteSource(activeWorkspace.id, sourceSlug)
      toast.success(t('toast.deletedSource'))
    } catch (error) {
      console.error('[Chat] Failed to delete source:', error)
      toast.error(t('toast.failedToDeleteSource'))
    }
  }, [activeWorkspace, t])

const handleDeleteSkill = useCallback(async (skillSlug: string) => {
    if (!activeWorkspace) return
    try {
      await window.electronAPI.deleteSkill(activeWorkspace.id, skillSlug)
      toast.success(t('toast.deletedSkill', { slug: skillSlug }))
    } catch (error) {
      console.error('[Chat] Failed to delete skill:', error)
      toast.error(t('toast.failedToDeleteSkill'))
    }
  }, [activeWorkspace, t])
return { handleNewChat, openConfigureLabels, handleAddLabel, handleDeleteLabel, handleNewBrowserWindow, openAddSource, openAddSkill, openAddProject, openAddAutomation, handleDeleteSource, handleDeleteSkill, editPopoverOpen, setEditPopoverOpen, editPopoverAnchorY, editLabelTargetId, createProjectDialogOpen, setCreateProjectDialogOpen, handleCreateProjectSubmit }
}
