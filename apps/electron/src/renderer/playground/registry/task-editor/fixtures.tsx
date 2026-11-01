import { getModelShortName } from "@config/models";
import { mockProjects } from "../../demos/kanban/mock-kanban-data";

// ---------------------------------------------------------------------------
// Static catalogs (stand-ins for the workspace's real models / projects)
// ---------------------------------------------------------------------------
export const OPUS = 'claude-opus-4-7'

export const SONNET = 'claude-sonnet-4-6'

const HAIKU = 'claude-haiku-4-5-20251001'

export const MODELS: { id: string; name: string; dot: string }[] = [
  { id: OPUS, name: 'Opus 4.7', dot: '#6366f1' },
  { id: SONNET, name: 'Sonnet 4.6', dot: '#0ea5e9' },
  { id: HAIKU, name: 'Haiku 4.5', dot: '#10b981' },
]

export const modelName = (id: string) => MODELS.find(m => m.id === id)?.name ?? getModelShortName(id)

export const modelDot = (id: string) => MODELS.find(m => m.id === id)?.dot ?? '#9aa1aa'

let _uid = 0

export const uid = () => `st-${++_uid}`

export const slugify = (s: string) =>
  s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)

export type Mode = 'generate' | 'manual'

export interface EditorSubtask {
  id: string
  title: string
  model: string
  dependsOn: string | null
}

// ---------------------------------------------------------------------------
// YAML preview (live, theme-adaptive)
// ---------------------------------------------------------------------------
function wrap(text: string, width = 56): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return []
  const out: string[] = []
  let line = ''
  for (const w of words) {
    if ((line + ' ' + w).trim().length > width) {
      out.push(line)
      line = w
    } else {
      line = (line ? line + ' ' : '') + w
    }
  }
  if (line) out.push(line)
  return out
}

export function buildYaml(s: {
  title: string
  goal: string
  projectId: string
  orchModel: string
  statusId: string
  subtasks: EditorSubtask[]
  aiMode: boolean
}): string {
  const slug = slugify(s.title) || 'untitled-task'
  const proj = mockProjects.find(p => p.id === s.projectId)
  const lines: string[] = []
  lines.push(`# workspace/tasks/${slug}.yaml`)
  lines.push(`id: ${slug}`)
  lines.push(`title: ${s.title || 'Untitled task'}`)
  const goalLines = wrap(s.goal)
  if (goalLines.length) {
    lines.push(`goal: >`)
    for (const g of goalLines) lines.push(`  ${g}`)
  } else {
    lines.push(`goal: ~`)
  }
  lines.push(`project: ${proj ? slugify(proj.name) : '~'}`)
  lines.push(`model: ${s.orchModel}        # orchestrator`)
  lines.push(`status: ${s.statusId}`)
  lines.push(`state: prepared               # not run yet`)
  lines.push(`subtasks:`)
  if (s.aiMode) {
    lines.push(`  # drafted by the orchestrator when the task runs`)
  } else if (s.subtasks.length === 0) {
    lines.push(`  []`)
  } else {
    for (const st of s.subtasks) {
      const dep = st.dependsOn ? s.subtasks.find(x => x.id === st.dependsOn) : null
      lines.push(`  - title: ${st.title || 'Untitled subtask'}`)
      lines.push(`    model: ${st.model}`)
      lines.push(`    depends_on: [${dep ? slugify(dep.title) : ''}]`)
    }
  }
  return lines.join('\n')
}
