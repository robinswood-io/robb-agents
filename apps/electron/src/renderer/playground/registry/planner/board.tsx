import * as React from "react";
import { DragDropManager } from "@dnd-kit/dom";
import { Sortable } from "@dnd-kit/dom/sortable";
import type { PlannerHeading, PlannerTask, PlannerSortableEntry, PlannerRow } from "./models";
import { initialHeadings, initialTasks, projects, sessionLinks, events } from "./fixtures";
import { buildFlatOrder, parseHeadingIdFromKey, parseTaskIdFromKey, uniqueOrdered } from "./ordering";
import { renderPlannerBoard } from "./view";

export function PlannerBoard() {
  const [activeProjectId, setActiveProjectId] = React.useState('p2')
  const [headingsState, setHeadingsState] = React.useState<PlannerHeading[]>(initialHeadings)
  const [tasksState, setTasksState] = React.useState<PlannerTask[]>(initialTasks)
  const [selectedTaskId, setSelectedTaskId] = React.useState('t1')
  const [quickAdd, setQuickAdd] = React.useState('')
  const [sidebarWidth, setSidebarWidth] = React.useState(220)
  const [navigatorWidth, setNavigatorWidth] = React.useState(420)
  const [isResizing, setIsResizing] = React.useState<'sidebar' | 'navigator' | null>(null)
  const [sidebarHandleY, setSidebarHandleY] = React.useState<number | null>(null)
  const [navigatorHandleY, setNavigatorHandleY] = React.useState<number | null>(null)
  const sidebarHandleRef = React.useRef<HTMLDivElement>(null)
  const navigatorHandleRef = React.useRef<HTMLDivElement>(null)
  const [flatOrder, setFlatOrder] = React.useState<string[]>(() => {
    const initialProjectHeadings = initialHeadings
      .filter(h => h.projectId === 'p2')
      .sort((a, b) => a.sortOrder - b.sortOrder)
    return buildFlatOrder(initialProjectHeadings, initialTasks)
  })

  const flatListRef = React.useRef<HTMLDivElement | null>(null)
  const rowRefs = React.useRef<Map<string, HTMLDivElement>>(new Map())
  const managerRef = React.useRef<DragDropManager | null>(null)
  const sortableRegistryRef = React.useRef<Map<string, PlannerSortableEntry>>(new Map())
  const headingsStateRef = React.useRef(headingsState)
  const tasksStateRef = React.useRef(tasksState)
  const activeProjectIdRef = React.useRef(activeProjectId)
  const isDraggingRef = React.useRef(false)

  const project = projects.find(p => p.id === activeProjectId) ?? projects[0]
  const projectHeadings = React.useMemo(
    () => headingsState.filter(h => h.projectId === project?.id).sort((a, b) => a.sortOrder - b.sortOrder),
    [headingsState, project?.id]
  )

  const selectedTask = tasksState.find(t => t.id === selectedTaskId)
  const selectedLinks = sessionLinks.filter(link => link.taskId === selectedTaskId)
  const selectedEvents = events.filter(e => e.taskId === selectedTaskId)

  const flatRows = React.useMemo<PlannerRow[]>(() => {
    const headingById = new Map(projectHeadings.map(heading => [heading.id, heading]))
    const taskById = new Map(tasksState.map(task => [task.id, task]))

    return flatOrder
      .map((rowKey) => {
        const headingId = parseHeadingIdFromKey(rowKey)
        if (headingId) {
          if (!headingById.has(headingId)) return null
          return { kind: 'heading', headingId, key: rowKey } as PlannerRow
        }

        const taskId = parseTaskIdFromKey(rowKey)
        if (taskId) {
          const task = taskById.get(taskId)
          if (!task) return null
          if (!headingById.has(task.headingId)) return null
          return { kind: 'task', taskId, key: rowKey } as PlannerRow
        }

        return null
      })
      .filter((row): row is PlannerRow => Boolean(row))
  }, [flatOrder, projectHeadings, tasksState])

  React.useEffect(() => {
    headingsStateRef.current = headingsState
  }, [headingsState])

  React.useEffect(() => {
    tasksStateRef.current = tasksState
  }, [tasksState])

  React.useEffect(() => {
    activeProjectIdRef.current = activeProjectId
  }, [activeProjectId])

  React.useEffect(() => {
    const canonical = buildFlatOrder(projectHeadings, tasksState)
    setFlatOrder((prev) => {
      const canonicalSet = new Set(canonical)
      const preserved = uniqueOrdered(prev.filter(key => canonicalSet.has(key)))
      const missing = canonical.filter(key => !preserved.includes(key))
      const next = uniqueOrdered([...preserved, ...missing])

      const unchanged = next.length === prev.length && next.every((key, index) => key === prev[index])
      return unchanged ? prev : next
    })
  }, [projectHeadings, tasksState])

  React.useEffect(() => {
    if (!selectedTask || !projectHeadings.some(h => h.id === selectedTask.headingId)) {
      const firstTask = tasksState.find(t => projectHeadings.some(h => h.id === t.headingId))
      setSelectedTaskId(firstTask?.id ?? '')
    }
  }, [projectHeadings, tasksState, selectedTask])

  const applyFlatOrderToState = React.useCallback((orderedKeys: string[]) => {
    const activeProject = activeProjectIdRef.current
    const headings = headingsStateRef.current
    const tasks = tasksStateRef.current
    const taskById = new Map(tasks.map(task => [task.id, task]))
    const normalizedOrderedKeys = uniqueOrdered(orderedKeys)

    const projectHeadingIds = new Set(
      headings
        .filter(heading => heading.projectId === activeProject)
        .map(heading => heading.id)
    )

    const orderedHeadingIds = uniqueOrdered(
      normalizedOrderedKeys
        .map(parseHeadingIdFromKey)
        .filter((headingId): headingId is string => Boolean(headingId && projectHeadingIds.has(headingId)))
    )

    const firstHeadingId = orderedHeadingIds[0]
    if (!firstHeadingId) return

    const orderedTaskIds: string[] = []
    const seenTaskIds = new Set<string>()
    const nextHeadingByTaskId = new Map<string, string>()
    let currentHeadingId = firstHeadingId

    normalizedOrderedKeys.forEach((rowKey) => {
      const headingId = parseHeadingIdFromKey(rowKey)
      if (headingId && projectHeadingIds.has(headingId)) {
        currentHeadingId = headingId
        return
      }

      const taskId = parseTaskIdFromKey(rowKey)
      if (!taskId) return
      if (seenTaskIds.has(taskId)) return

      const task = taskById.get(taskId)
      if (!task) return
      if (!projectHeadingIds.has(task.headingId)) return

      seenTaskIds.add(taskId)
      orderedTaskIds.push(taskId)
      nextHeadingByTaskId.set(taskId, currentHeadingId)
    })

    setHeadingsState((prev) => {
      const nextOrderByHeadingId = new Map(orderedHeadingIds.map((id, index) => [id, index + 1]))
      return prev.map((heading) => {
        if (heading.projectId !== activeProject) return heading
        const sortOrder = nextOrderByHeadingId.get(heading.id)
        return sortOrder ? { ...heading, sortOrder } : heading
      })
    })

    setTasksState((prev) => {
      const updated = prev.map((task) => {
        const nextHeadingId = nextHeadingByTaskId.get(task.id)
        if (!nextHeadingId || task.headingId === nextHeadingId) return task
        return { ...task, headingId: nextHeadingId }
      })

      const byId = new Map(updated.map(task => [task.id, task]))
      const ordered = orderedTaskIds.map(taskId => byId.get(taskId)).filter((task): task is PlannerTask => Boolean(task))
      const remaining = updated.filter(task => !orderedTaskIds.includes(task.id))
      return [...ordered, ...remaining]
    })
  }, [])

  React.useEffect(() => {
    const manager = new DragDropManager()
    const sortableRegistry = sortableRegistryRef.current
    managerRef.current = manager

    const unsubDragStart = manager.monitor.addEventListener('dragstart', () => {
      isDraggingRef.current = true
    })

    const unsubDragEnd = manager.monitor.addEventListener('dragend', (event) => {
      requestAnimationFrame(() => { isDraggingRef.current = false })
      if (event.canceled) return

      const sourceId = String(event.operation.source?.id ?? '')
      if (!sourceId.startsWith('heading:') && !sourceId.startsWith('task:')) return

      const list = flatListRef.current
      if (!list) return

      const orderedKeys = uniqueOrdered(
        Array.from(list.children)
          .map(el => (el as HTMLElement).dataset["rowKey"])
          .filter((key): key is string => Boolean(key))
      )

      if (orderedKeys.length === 0) return

      setFlatOrder(orderedKeys)
      applyFlatOrderToState(orderedKeys)
    })

    return () => {
      unsubDragStart()
      unsubDragEnd()
      sortableRegistry.forEach((entry) => entry.sortable.destroy())
      sortableRegistry.clear()
      manager.destroy()
      managerRef.current = null
    }
  }, [applyFlatOrderToState])

  React.useEffect(() => {
    const manager = managerRef.current
    if (!manager) return

    const desiredEntries = new Map<string, { element: HTMLDivElement; index: number }>()

    flatRows.forEach((row, index) => {
      const element = rowRefs.current.get(row.key)
      if (!element) return

      desiredEntries.set(row.key, {
        element,
        index,
      })
    })

    desiredEntries.forEach((desired, rowKey) => {
      const existing = sortableRegistryRef.current.get(rowKey)

      if (existing) {
        if (existing.index !== desired.index) {
          existing.sortable.index = desired.index
          existing.index = desired.index
        }
        if (existing.element !== desired.element) {
          existing.sortable.element = desired.element
          existing.element = desired.element
        }
        return
      }

      const sortable = new Sortable({
        id: rowKey,
        index: desired.index,
        element: desired.element,
      }, manager)

      sortableRegistryRef.current.set(rowKey, {
        sortable,
        element: desired.element,
        index: desired.index,
      })
    })

    Array.from(sortableRegistryRef.current.keys()).forEach((rowKey) => {
      if (desiredEntries.has(rowKey)) return
      const existing = sortableRegistryRef.current.get(rowKey)
      existing?.sortable.destroy()
      sortableRegistryRef.current.delete(rowKey)
    })
  }, [flatRows])

  React.useEffect(() => {
    if (!isResizing) return

    const handleMouseMove = (e: MouseEvent) => {
      const container = sidebarHandleRef.current?.parentElement
      const containerLeft = container?.getBoundingClientRect().left ?? 0

      if (isResizing === 'sidebar') {
        setSidebarWidth(Math.max(e.clientX - containerLeft, 160))
        if (sidebarHandleRef.current) {
          const rect = sidebarHandleRef.current.getBoundingClientRect()
          setSidebarHandleY(e.clientY - rect.top)
        }
      } else if (isResizing === 'navigator') {
        const offset = sidebarWidth + 6 // sidebar + gap
        setNavigatorWidth(Math.max(e.clientX - containerLeft - offset, 240))
        if (navigatorHandleRef.current) {
          const rect = navigatorHandleRef.current.getBoundingClientRect()
          setNavigatorHandleY(e.clientY - rect.top)
        }
      }
    }

    const handleMouseUp = () => {
      setIsResizing(null)
      setSidebarHandleY(null)
      setNavigatorHandleY(null)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isResizing, sidebarWidth])

  const updateTaskTitle = React.useCallback((taskId: string, newTitle: string) => {
    const trimmed = newTitle.trim()
    if (!trimmed) return
    setTasksState(prev => prev.map(t => t.id === taskId ? { ...t, title: trimmed } : t))
  }, [])

  const updateTaskNotes = React.useCallback((taskId: string, newNotes: string) => {
    setTasksState(prev => prev.map(t => t.id === taskId ? { ...t, notes: newNotes } : t))
  }, [])

  const selectedHeading = selectedTask ? headingsState.find(h => h.id === selectedTask.headingId) : null

  const addTask = React.useCallback(() => {
    const title = quickAdd.trim()
    const firstHeading = projectHeadings[0]
    if (!title || !firstHeading) return

    const task: PlannerTask = {
      id: `t-${Date.now()}`,
      headingId: firstHeading.id,
      title,
      notes: '',
      state: 'todo',
      due: 'Inbox',
    }

    setTasksState(prev => [task, ...prev])
    setFlatOrder((prev) => {
      const firstHeadingKey = `heading:${firstHeading.id}`
      const insertionIndex = prev.indexOf(firstHeadingKey)
      if (insertionIndex === -1) return [...prev, `task:${task.id}`]
      const next = [...prev]
      next.splice(insertionIndex + 1, 0, `task:${task.id}`)
      return next
    })
    setSelectedTaskId(task.id)
    setQuickAdd('')
  }, [projectHeadings, quickAdd])

  if (!project) return null
  return renderPlannerBoard({
    sidebarWidth,
    setActiveProjectId,
    project,
    navigatorWidth,
    quickAdd,
    setQuickAdd,
    addTask,
    setSelectedTaskId,
    flatListRef,
    flatRows,
    projectHeadings,
    rowRefs,
    tasksState,
    isDraggingRef,
    selectedTaskId,
    selectedTask,
    updateTaskTitle,
    selectedHeading,
    selectedLinks,
    updateTaskNotes,
    selectedEvents,
    sidebarHandleRef,
    setIsResizing,
    setSidebarHandleY,
    isResizing,
    sidebarHandleY,
    navigatorHandleRef,
    setNavigatorHandleY,
    navigatorHandleY,
  });
}
