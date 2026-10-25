import { loadProjectById, getProjectAssetsPath, listProjectAssets, getProjectMemoryPath, loadProjectMemory } from "../../projects/storage.ts";
import type { ProjectPromptContext } from "../../projects/types.ts";
// Path utilities
import { join } from "path";
import { homedir } from "os";
// Error typing
import { parseError, type AgentError } from "../errors.ts";
import { InvalidWorkingDirectoryError } from "../spawn-helpers.ts";
import type { PiAgent } from '../pi-agent.ts';

/**
   * Look up the bound project (if any) and return a snapshot for system-prompt injection.
   * Mirrors ClaudeAgent.resolveProjectContext — safe to call on every turn since the
   * project config file is small.
   */
export function resolveProjectContext(transportOwner: PiAgent): ProjectPromptContext | null {
    const projectId = transportOwner["config"].session?.projectId;
    if (!projectId)
        return null;
    try {
        const root = transportOwner["config"].workspace.rootPath;
        const project = loadProjectById(root, projectId);
        if (!project)
            return null;
        const slug = project.config.slug;
        return {
            name: project.config.name,
            description: project.config.description,
            details: project.config.details,
            assetsPath: getProjectAssetsPath(root, slug),
            assets: listProjectAssets(root, slug).map((a) => ({
                filename: a.filename,
                mimeType: a.mimeType,
                sizeBytes: a.sizeBytes,
            })),
            memoryPath: getProjectMemoryPath(root, slug),
            memoryContent: loadProjectMemory(root, slug, 5000, { includeStructured: false }) ?? undefined,
        };
    }
    catch (error) {
        transportOwner["debug"](`[resolveProjectContext] Failed to load project ${projectId}: ${error instanceof Error ? error.message : error}`);
        return null;
    }
}

// ============================================================
  // Helpers
  // ============================================================

  /**
   * Resolve working directory to an absolute path.
   * BaseAgent stores paths with tilde (~) but Node.js spawn doesn't expand tilde.
   */
export function resolvedCwd(transportOwner: PiAgent): string {
    const wd = transportOwner["workingDirectory"];
    if (wd.startsWith('~/'))
        return join(homedir(), wd.slice(2));
    if (wd === '~')
        return homedir();
    return wd;
}

// ============================================================
  // Error Parsing
  // ============================================================

  /**
   * Parse a Pi error into a typed AgentError.
   */
export function parsePiError(transportOwner: PiAgent, error: Error): AgentError {
    if (error instanceof InvalidWorkingDirectoryError)
        return parseError(error);
    const errorMessage = error.message.toLowerCase();
    // Auth errors
    if (errorMessage.includes('api key') ||
        errorMessage.includes('unauthorized') ||
        errorMessage.includes('401') ||
        errorMessage.includes('authentication')) {
        // For OAuth connections, attempt token refresh before giving up
        if (transportOwner["config"].authType === 'oauth') {
            transportOwner["refreshAndPushTokens"]().catch(err => {
                transportOwner["debug"](`Token refresh from parsePiError failed: ${err}`);
            });
        }
        return {
            code: 'invalid_api_key',
            title: 'Invalid API Key',
            message: 'Your API key was rejected. Check your credentials in Settings.',
            actions: [
                { key: 's', label: 'Update API key', command: '/settings', action: 'settings' },
            ],
            canRetry: transportOwner["config"].authType === 'oauth',
            originalError: error.message,
        };
    }
    // Rate limiting
    if (errorMessage.includes('rate') || errorMessage.includes('429')) {
        return {
            code: 'rate_limited',
            title: 'Rate Limited',
            message: 'Too many requests. Please wait a moment before trying again.',
            actions: [
                { key: 'r', label: 'Retry', action: 'retry' },
            ],
            canRetry: true,
            retryDelayMs: 5000,
            originalError: error.message,
        };
    }
    // Service errors
    if (errorMessage.includes('500') ||
        errorMessage.includes('502') ||
        errorMessage.includes('503') ||
        errorMessage.includes('service') ||
        errorMessage.includes('overloaded')) {
        return {
            code: 'service_error',
            title: 'Service Error',
            message: 'The AI service is temporarily unavailable. Please try again.',
            actions: [
                { key: 'r', label: 'Retry', action: 'retry' },
            ],
            canRetry: true,
            retryDelayMs: 2000,
            originalError: error.message,
        };
    }
    // Network errors
    if (errorMessage.includes('network') ||
        errorMessage.includes('econnrefused') ||
        errorMessage.includes('fetch failed')) {
        return {
            code: 'network_error',
            title: 'Connection Error',
            message: 'Could not connect to the server. Check your internet connection.',
            actions: [
                { key: 'r', label: 'Retry', action: 'retry' },
            ],
            canRetry: true,
            retryDelayMs: 1000,
            originalError: error.message,
        };
    }
    // Fall back to shared error parsing
    return parseError(error);
}

// ============================================================
  // Debug
  // ============================================================
export function debug(transportOwner: PiAgent, message: string): void {
    transportOwner["onDebug"]?.(`[pi] ${message}`);
}
