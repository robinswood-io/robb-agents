import { isJsonObject, parseJsonObject } from '@craft-agent/shared/utils/json';
import { type Tool } from '@modelcontextprotocol/client';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

import { type SessionToolContext, type CallbackMessage, type AuthRequest, type SourceConfig, type LoadedSource, type CredentialManagerInterface, getToolDefsAsJsonSchema, 
// Helpers
loadSourceConfig as loadSourceConfigFromHelpers } from '@craft-agent/session-tools-core';


// ============================================================
// Types
// ============================================================

export interface SessionConfig {
  sessionId: string;
  workspaceRootPath: string;
  plansFolderPath: string;
  callbackPort?: string;
}


export const CALLBACK_TOOL_TIMEOUT_MS = 120000;


// ============================================================
// Callback Communication
// ============================================================

/**
 * Send a callback message to the main process via stderr.
 * These messages are parsed by the main process to trigger UI actions.
 */
export function sendCallback(callback: CallbackMessage): void {
  // Write to stderr as a single line JSON (main process parses this)
  console.error(`__CALLBACK__${JSON.stringify(callback)}`);
}


// ============================================================
// Credential Cache Access
// ============================================================

/**
 * Credential cache entry format (matches main process format).
 * Written by Electron main process, read by this server.
 */
export interface CredentialCacheEntry {
  value: string;
  expiresAt?: number;
}


export function isSafeSingleSegment(segment: string): boolean {
  return (
    typeof segment === 'string' &&
    segment.length > 0 &&
    segment !== '.' &&
    segment !== '..' &&
    !segment.includes('..') &&
    !segment.includes('/') &&
    !segment.includes('\\') &&
    !segment.includes('\0')
  );
}


/**
 * Get the path to a source's credential cache file.
 * The main process writes decrypted credentials to these files.
 */
export function getCredentialCachePath(workspaceRootPath: string, sourceSlug: string): string {
  if (!isSafeSingleSegment(sourceSlug)) {
    throw new Error(`Invalid source slug: "${sourceSlug}"`);
  }
  const sourcesDir = resolve(workspaceRootPath, 'sources');
  const cachePath = resolve(sourcesDir, sourceSlug, '.credential-cache.json');
  if (!cachePath.startsWith(sourcesDir + sep)) {
    throw new Error(`Invalid source slug: "${sourceSlug}"`);
  }
  return cachePath;
}


/**
 * Read credentials from the cache file for a source.
 * Returns null if the cache doesn't exist or is expired.
 */
export function readCredentialCache(workspaceRootPath: string, sourceSlug: string): string | null {
  try {
    const cachePath = getCredentialCachePath(workspaceRootPath, sourceSlug);
    if (!existsSync(cachePath)) {
      return null;
    }

    const content = readFileSync(cachePath, 'utf-8');
    const cache = JSON.parse(content) as CredentialCacheEntry;

    // Check expiry if set
    if (cache.expiresAt && Date.now() > cache.expiresAt) {
      return null;
    }

    return cache.value || null;
  } catch {
    return null;
  }
}


/**
 * Create a credential manager that reads from credential cache files.
 * This allows the session-mcp-server to access credentials without keychain access.
 */
export function createCredentialManager(workspaceRootPath: string): CredentialManagerInterface {
  return {
    hasValidCredentials: async (source: LoadedSource): Promise<boolean> => {
      const token = readCredentialCache(workspaceRootPath, source.config.slug);
      return token !== null;
    },

    getToken: async (source: LoadedSource): Promise<string | null> => {
      return readCredentialCache(workspaceRootPath, source.config.slug);
    },

    refresh: async (_source: LoadedSource): Promise<string | null> => {
      // Cannot refresh from subprocess - would need main process
      return null;
    },
  };
}


// ============================================================
// Codex Context Factory
// ============================================================

/**
 * Create a SessionToolContext for the Codex MCP server.
 * This provides the context needed by all handlers.
 */
export function createCodexContext(config: SessionConfig): SessionToolContext {
  const { sessionId, workspaceRootPath, plansFolderPath } = config;

  // File system implementation
  const fs = {
    exists: (path: string) => existsSync(path),
    readFile: (path: string) => readFileSync(path, 'utf-8'),
    readFileBuffer: (path: string) => readFileSync(path),
    writeFile: (path: string, content: string) => writeFileSync(path, content, 'utf-8'),
    isDirectory: (path: string) => existsSync(path) && statSync(path).isDirectory(),
    readdir: (path: string) => readdirSync(path),
    stat: (path: string) => {
      const stats = statSync(path);
      return {
        size: stats.size,
        isDirectory: () => stats.isDirectory(),
      };
    },
  };

  // Callback implementation using stderr
  const callbacks = {
    onPlanSubmitted: (planPath: string) => {
      sendCallback({
        __callback__: 'plan_submitted',
        sessionId,
        planPath,
      });
    },
    onAuthRequest: (request: AuthRequest) => {
      sendCallback({
        __callback__: 'auth_request',
        ...request,
      });
    },
  };

  // Create credential manager that reads from cache files
  const credentialManager = createCredentialManager(workspaceRootPath);

  // Session paths for transform_data / render_template
  const sessionsDir = join(workspaceRootPath, 'sessions', sessionId);
  const sessionDataDir = join(sessionsDir, 'data');

  // Build context
  return {
    sessionId,
    workspacePath: workspaceRootPath,
    get sourcesPath() { return join(workspaceRootPath, 'sources'); },
    get skillsPath() { return join(workspaceRootPath, 'skills'); },
    plansFolderPath,
    sessionPath: sessionsDir,
    dataPath: sessionDataDir,
    callbacks,
    fs,
    loadSourceConfig: (sourceSlug: string): SourceConfig | null => {
      return loadSourceConfigFromHelpers(workspaceRootPath, sourceSlug);
    },

    // Credential manager reads from cache files written by main process
    credentialManager,

    // Preferences: write directly to preferences.json
    updatePreferences: (updates: Record<string, unknown>) => {
      // Resolve preferences path from config dir (parent of workspaces dir)
      // workspaceRootPath = ~/.craft-agent/workspaces/{id}
      // preferencesPath = ~/.craft-agent/preferences.json
      const configDir = join(workspaceRootPath, '..', '..');
      const prefsPath = join(configDir, 'preferences.json');
      try {
        let current: Record<string, unknown> = {};
        if (existsSync(prefsPath)) {
          current = parseJsonObject(readFileSync(prefsPath, 'utf-8'));
        }
        const merged = {
          ...current,
          ...updates,
          location: isJsonObject(updates["location"])
            ? { ...(isJsonObject(current["location"]) ? current["location"] : {}), ...updates["location"] }
            : current["location"],
          updatedAt: Date.now(),
        };
        writeFileSync(prefsPath, JSON.stringify(merged, null, 2), { encoding: 'utf-8', mode: 0o600 });
      } catch (err) {
        console.error('Failed to update preferences:', err);
      }
    },

    // Developer feedback: write one JSON file per entry to {configDir}/feedback/
    submitFeedback: (feedback) => {
      const rawId = typeof feedback?.id === 'string' ? feedback.id.trim() : '';
      const safeId = rawId.replace(/[^a-zA-Z0-9._-]/g, '_');
      if (!safeId || !isSafeSingleSegment(safeId)) {
        throw new Error('Invalid feedback ID');
      }
      const configDir = process.env["CRAFT_CONFIG_DIR"] || join(workspaceRootPath, '..', '..');
      const feedbackDir = resolve(configDir, 'feedback');
      mkdirSync(feedbackDir, { recursive: true, mode: 0o700 });
      const filePath = resolve(feedbackDir, `${safeId}.json`);
      if (!filePath.startsWith(feedbackDir + sep)) {
        throw new Error('Invalid feedback ID');
      }
      writeFileSync(filePath, JSON.stringify(feedback, null, 2), { encoding: 'utf-8', mode: 0o600 });
    },

    // Note: saveSourceConfig, validators, renderMermaid
    // are not available in Codex context (require Electron internals)
  };
}


// ============================================================
// Tool Definitions (from canonical registry)
// ============================================================

export function createSessionTools(includeDeveloperFeedback: boolean): Tool[] {
  return getToolDefsAsJsonSchema({
    includeDeveloperFeedback,
  }).map(def => ({
    name: def.name,
    description: def.description,
    inputSchema: def.inputSchema as Tool['inputSchema'],
  }));
}
