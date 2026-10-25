import type { PlaygroundMessagingHandle, PlaygroundAllowListHandle } from './mock-utils/messaging';

declare global {
  interface Window {
    __playgroundMessaging?: PlaygroundMessagingHandle;
    __playgroundAllowList?: PlaygroundAllowListHandle;
  }
}

import { mockElectronAPI } from "./mock-utils/electron-api";
export { mockElectronAPI } from "./mock-utils/electron-api";
import { playgroundMessagingHandle, playgroundAllowListHandle } from "./mock-utils/messaging";
export { type PlaygroundMessagingHandle, type PlaygroundAllowListHandle, playgroundMessagingHandle, playgroundAllowListHandle } from "./mock-utils/messaging";
import type { FileAttachment, LoadedSource, PermissionMode } from '../../shared/types';



/**
 * Inject mock electronAPI into window if not already present.
 * Call this in playground component wrappers before rendering components
 * that depend on electronAPI.
 *
 * IMPORTANT: this also runs as a top-level side effect when this module is
 * imported (see below), so that consumers relying on a synchronous
 * `window.electronAPI.*` read at module-load time (e.g.
 * `SessionFilesSection.tsx`'s top-level `getRuntimeEnvironment()` call) see
 * the mock before their module is evaluated. The entry `playground.tsx`
 * must import this module before any component chain that touches
 * `window.electronAPI` at import time.
 */
export function ensureMockElectronAPI() {
  try {
    const merged = window.electronAPI
      ? { ...window.electronAPI, ...mockElectronAPI }
      : mockElectronAPI
    Object.defineProperty(window, 'electronAPI', {
      value: merged,
      configurable: true,
      writable: true,
    })
  } catch {
    if (!window.electronAPI) {
      ;Object.assign(window, { electronAPI: mockElectronAPI })
    }
  }
  if (!window.__playgroundMessaging) {
    ;window.__playgroundMessaging = playgroundMessagingHandle
    console.log('[Playground] Exposed __playgroundMessaging handle')
  }
  if (!window.__playgroundAllowList) {
    ;window.__playgroundAllowList = playgroundAllowListHandle
    console.log('[Playground] Exposed __playgroundAllowList handle')
  }
}

// Install on import so any later module that reads `window.electronAPI` at
// top level finds the mock in place. Safe: only runs once (idempotent).
ensureMockElectronAPI()

// ============================================================================
// Sample Data
// ============================================================================

export const mockSources: LoadedSource[] = [
  {
    config: {
      id: 'github-api-1',
      slug: 'github-api',
      name: 'GitHub API',
      provider: 'github',
      type: 'api',
      enabled: true,
      api: {
        baseUrl: 'https://api.github.com',
        authType: 'bearer',
      },
      icon: 'https://www.google.com/s2/favicons?domain=github.com&sz=128',
      tagline: 'Access repositories, issues, and pull requests',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    guide: null,
    folderPath: '/mock/sources/github-api',
    workspaceRootPath: '/mock/workspaces/playground-workspace',
    workspaceId: 'playground-workspace',
  },
  {
    config: {
      id: 'linear-api-1',
      slug: 'linear-api',
      name: 'Linear',
      provider: 'linear',
      type: 'api',
      enabled: true,
      api: {
        baseUrl: 'https://api.linear.app',
        authType: 'bearer',
      },
      icon: 'https://www.google.com/s2/favicons?domain=linear.app&sz=128',
      tagline: 'Issue tracking and project management',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    guide: null,
    folderPath: '/mock/sources/linear-api',
    workspaceRootPath: '/mock/workspaces/playground-workspace',
    workspaceId: 'playground-workspace',
  },
  {
    config: {
      id: 'local-files-1',
      slug: 'local-files',
      name: 'Local Files',
      provider: 'filesystem',
      type: 'local',
      enabled: true,
      local: {
        path: '/Users/demo/projects',
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    guide: null,
    folderPath: '/mock/sources/local-files',
    workspaceRootPath: '/mock/workspaces/playground-workspace',
    workspaceId: 'playground-workspace',
  },
]

export const sampleImageAttachment: FileAttachment = {
  type: 'image',
  path: '/Users/demo/screenshot.png',
  name: 'screenshot.png',
  mimeType: 'image/png',
  size: 245000,
  base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
}

export const samplePdfAttachment: FileAttachment = {
  type: 'pdf',
  path: '/Users/demo/design.pdf',
  name: 'design.pdf',
  mimeType: 'application/pdf',
  size: 1024000,
}

// ============================================================================
// Mock Callbacks
// ============================================================================

export const mockInputCallbacks = {
  onSubmit: (message: string, attachments?: FileAttachment[]) => {
    console.log('[Playground] Message submitted:', { message, attachments })
  },

  onModelChange: (model: string | null) => {
    console.log('[Playground] Model changed to:', model ?? 'automatic')
  },

  onInputChange: (value: string) => {
    console.log('[Playground] Input changed:', value.substring(0, 50) + (value.length > 50 ? '...' : ''))
  },

  onHeightChange: (height: number) => {
    console.log('[Playground] Height changed:', height)
  },

  onFocusChange: (focused: boolean) => {
    console.log('[Playground] Focus changed:', focused)
  },

  onPermissionModeChange: (mode: PermissionMode) => {
    console.log('[Playground] Permission mode changed:', mode)
  },

  onSourcesChange: (slugs: string[]) => {
    console.log('[Playground] Sources changed:', slugs)
  },

  onWorkingDirectoryChange: (path: string) => {
    console.log('[Playground] Working directory changed:', path)
  },

  onStop: () => {
    console.log('[Playground] Stop requested')
  },
}

export const mockAttachmentCallbacks = {
  onRemove: (index: number) => {
    console.log('[Playground] Remove attachment at index:', index)
  },

  onOpenFile: (path: string) => {
    console.log('[Playground] Open file:', path)
  },
}

export const mockBackgroundTaskCallbacks = {
  onKillTask: (taskId: string) => {
    console.log('[Playground] Kill task:', taskId)
  },
}
