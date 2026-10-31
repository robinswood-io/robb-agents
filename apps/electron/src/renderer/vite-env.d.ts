interface ImportMeta {
  readonly glob: import('vite').ImportGlobFunction
}

declare module '*.css' {}


// Image imports
declare module "*.png" {
  const src: string
  export default src
}

declare module "*.jpg" {
  const src: string
  export default src
}

declare module "*.jpeg" {
  const src: string
  export default src
}

declare module "*.svg" {
  const src: string
  export default src
}

// PDF imports (used with ?url suffix for react-pdf)
declare module "*?url" {
  const src: string
  export default src
}


interface WindowEventMap {
  'craft:approve-plan': CustomEvent<{
    sessionId?: string | undefined
    planPath?: string | undefined
    includeDraftInput?: boolean | undefined
    source?: string | undefined
  }>
  'craft:approve-plan-with-compact': WindowEventMap['craft:approve-plan']
  'craft:compaction-complete': CustomEvent<{ sessionId: string }>
  'craft:paste-files': CustomEvent<{ files: File[]; sessionId?: string | undefined }>
}
