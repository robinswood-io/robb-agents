import { type SDKUserMessage, type SDKAssistantMessageError } from "@anthropic-ai/claude-agent-sdk";
import { mapClaudeSdkAssistantError, type ClaudeSdkApiError } from "../claude-sdk-error-mapper.ts";
import type { FileAttachment } from "../../utils/files.ts";
import { getPermissionModeDiagnostics } from "../mode-manager.ts";
import { getSessionPlansPath, getSessionPath } from "../../sessions/storage.ts";
import { getLastApiError } from "../../interceptor-common.ts";
// Documentation is served via local files at ~/.craft-agent/docs/
// Import and re-export AgentEvent from core (single source of truth)
// Documentation is served via local files at ~/.craft-agent/docs/
// Import and re-export AgentEvent from core (single source of truth)
import type { AgentEvent } from "@craft-agent/core/types";
// Stateless tool matching — pure functions for SDK message → AgentEvent conversion
// Stateless tool matching — pure functions for SDK message → AgentEvent conversion
import { ToolIndex } from "../tool-matching.ts";
import type { ClaudeAgent } from '../claude-agent.ts';
import type { ContentBlockParam } from './shared.ts';
import type { ClaudeMapSDKErrorToTypedErrorResult, ClaudeDetectInactiveSourceToolErrorResult } from './protocol.ts';

// formatSourceState() and getAuthToolName() are now delegated to this.sourceManager

  // buildRecoveryContext() is now inherited from BaseAgent
  // formatWorkspaceCapabilities() is now in PromptBuilder

  /**
   * Build an SDK user message with proper content blocks for binary attachments
   * Prepends date/time context for prompt caching optimization (keeps system prompt static)
   * Injects session state (including mode state) for every message
   */
export function buildSDKUserMessage(transportOwner: ClaudeAgent, text: string, attachments?: FileAttachment[]): SDKUserMessage {
    const contentBlocks: ContentBlockParam[] = [];
    // Add context parts using centralized PromptBuilder
    // This includes: date/time, session state (with plansFolderPath),
    // workspace capabilities, and working directory context
    const sdkPromptDiagnostics = getPermissionModeDiagnostics(transportOwner["modeSessionId"]);
    transportOwner["debug"](`[ModeSnapshot] sessionId=${transportOwner["modeSessionId"]} buildSDKUserMessage mode=${sdkPromptDiagnostics.permissionMode} ` +
        `modeVersion=${sdkPromptDiagnostics.modeVersion} changedBy=${sdkPromptDiagnostics.lastChangedBy} changedAt=${sdkPromptDiagnostics.lastChangedAt}`);
    const contextParts = transportOwner["promptBuilder"].buildContextParts({ plansFolderPath: getSessionPlansPath(transportOwner["workspaceRootPath"], transportOwner["modeSessionId"]) }, transportOwner["sourceManager"].formatSourceState());
    for (const part of contextParts) {
        contentBlocks.push({ type: 'text', text: part });
    }
    // Add attachments - images/PDFs are uploaded inline, text files are path-only
    // Text files are NOT embedded to prevent context overflow; agent uses Read tool
    if (attachments) {
        for (const attachment of attachments) {
            // Add path info text block so the agent knows where the file is stored
            // This enables the agent to use the Read tool to access text/office files
            if (attachment.storedPath) {
                let pathInfo = `[Attached file: ${attachment.name}]\n[Stored at: ${attachment.storedPath}]`;
                if (attachment.markdownPath) {
                    pathInfo += `\n[Markdown version: ${attachment.markdownPath}]`;
                }
                contentBlocks.push({
                    type: 'text',
                    text: pathInfo,
                });
            }
            // Only images and PDFs are uploaded inline (agent cannot read these with Read tool)
            if (attachment.type === 'image' && attachment.base64) {
                const mediaType = transportOwner["mapImageMediaType"](attachment.mimeType);
                if (mediaType) {
                    contentBlocks.push({
                        type: 'image',
                        source: {
                            type: 'base64',
                            media_type: mediaType,
                            data: attachment.base64,
                        },
                    });
                }
            }
            else if (attachment.type === 'pdf' && attachment.base64) {
                contentBlocks.push({
                    type: 'document',
                    source: {
                        type: 'base64',
                        media_type: 'application/pdf',
                        data: attachment.base64,
                    },
                });
            }
            // Text files: path info already added above, agent uses Read tool to access content
        }
    }
    // Add user's text message
    if (text.trim()) {
        contentBlocks.push({ type: 'text', text });
    }
    return {
        type: 'user',
        message: {
            role: 'user',
            content: contentBlocks,
        },
        parent_tool_use_id: null,
        // Session resumption is handled by options.resume, not here
        // Setting session_id here with resume option causes SDK to return empty response
        session_id: '',
    } as SDKUserMessage;
}

/**
   * Map file MIME types to SDK-supported image types
   */
export function mapImageMediaType(transportOwner: ClaudeAgent, mimeType?: string): 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' | null {
    if (!mimeType)
        return null;
    const supported: Record<string, 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'> = {
        'image/jpeg': 'image/jpeg',
        'image/png': 'image/png',
        'image/gif': 'image/gif',
        'image/webp': 'image/webp',
    };
    return supported[mimeType] || null;
}

/**
   * Parse actual API error from SDK debug log file.
   * The SDK logs errors like: [ERROR] Error in non-streaming fallback: 400 {"type":"error","error":{"type":"invalid_request_error","message":"Could not process image"},"request_id":"req_..."}
   * These go to ~/.claude/debug/{sessionId}.txt, NOT to stderr.
   *
   * Uses async retries with non-blocking delays to handle race condition where
   * SDK may still be writing to the debug file when the error event is received.
   */
export async function parseApiErrorFromDebugLog(transportOwner: ClaudeAgent): Promise<ClaudeSdkApiError | null> {
    if (!transportOwner["sessionId"])
        return null;
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const debugFilePath = path.join(os.homedir(), '.claude', 'debug', `${transportOwner["sessionId"]}.txt`);
    // Helper for non-blocking delay
    const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    // Retry up to 3 times with 50ms delays to handle race condition
    // where SDK emits error event before finishing debug file write
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            if (!fs.existsSync(debugFilePath)) {
                // File doesn't exist yet, wait and retry
                if (attempt < 2) {
                    await delay(50);
                    continue;
                }
                return null;
            }
            // Read the file and get last 50 lines to find recent errors
            const content = fs.readFileSync(debugFilePath, 'utf-8');
            const lines = content.split('\n').slice(-50);
            // Search backwards for the most recent [ERROR] line with JSON
            for (let i = lines.length - 1; i >= 0; i--) {
                const line = lines[i];
                // Match [ERROR] lines containing JSON with error details
                const errorMatch = line.match(/\[ERROR\].*?(\{.*\})/);
                if (errorMatch && errorMatch[1]) {
                    try {
                        const parsed = JSON.parse(errorMatch[1]);
                        if (parsed?.error?.message) {
                            return {
                                errorType: parsed.error.type || 'error',
                                message: parsed.error.message,
                                requestId: parsed.request_id,
                            };
                        }
                    }
                    catch {
                        // Not valid JSON, continue searching
                    }
                }
            }
            // File exists but no error found yet, wait and retry
            if (attempt < 2) {
                await delay(50);
            }
        }
        catch {
            // File read error, wait and retry
            if (attempt < 2) {
                await delay(50);
            }
        }
    }
    return null;
}

/**
   * Pop a recent captured API error, preferring the session-scoped file.
   * Falls back to the legacy global file for backward compatibility.
   */
export function getCapturedApiErrorForSession(transportOwner: ClaudeAgent) {
    const sessionId = transportOwner["config"].session?.id;
    if (!sessionId) {
        return getLastApiError();
    }
    const sessionDir = getSessionPath(transportOwner["workspaceRootPath"], sessionId);
    return getLastApiError(sessionDir) ?? getLastApiError();
}

/**
   * Map SDK assistant message error codes to typed error events with user-friendly messages.
   * Merges SDK code with parsed debug errors and interceptor-captured API statuses.
   */
export async function mapSDKErrorToTypedError(transportOwner: ClaudeAgent, errorCode: SDKAssistantMessageError): Promise<ClaudeMapSDKErrorToTypedErrorResult> {
    const actualError = await transportOwner["parseApiErrorFromDebugLog"]();
    const capturedApiError = transportOwner["getCapturedApiErrorForSession"]();
    const error = mapClaudeSdkAssistantError(errorCode, {
        actualError,
        capturedApiError,
        userTurnHadAttachments: transportOwner["lastTurnHadAttachments"],
    });
    return {
        type: 'typed_error',
        error,
    };
}

/**
   * Check if a tool result error indicates a "tool not found" for an inactive source.
   * This is used to detect when Claude tries to call a tool from a source that exists
   * but isn't currently active, so we can auto-activate and retry.
   *
   * @returns The source slug, tool name, and input if this is an inactive source error, null otherwise
   */
export function detectInactiveSourceToolError(transportOwner: ClaudeAgent, event: AgentEvent, toolIndex: ToolIndex): ClaudeDetectInactiveSourceToolErrorResult | null {
    if (event.type !== 'tool_result' || !event.isError)
        return null;
    const resultStr = typeof event.result === 'string' ? event.result : '';
    // Try to extract tool name from error message patterns:
    // - "No such tool available: mcp__slack__api_slack"
    // - "Error: Tool 'mcp__slack__api_slack' not found"
    let toolName: string | null = null;
    // Pattern 1: "No such tool available: {toolName}" or "No tool available: {toolName}"
    // Note: SDK wraps in XML tags like "</tool_use_error>", so we stop at '<' to avoid capturing the tag
    const noSuchToolMatch = resultStr.match(/No (?:such )?tool available:\s*([^\s<]+)/i);
    if (noSuchToolMatch?.[1]) {
        toolName = noSuchToolMatch[1];
    }
    // Pattern 2: "Tool '{toolName}' not found" or "Tool `{toolName}` not found"
    if (!toolName) {
        const toolNotFoundMatch = resultStr.match(/Tool\s+['"`]([^'"`]+)['"`]\s+not found/i);
        if (toolNotFoundMatch?.[1]) {
            toolName = toolNotFoundMatch[1];
        }
    }
    // Fallback: try toolIndex if we couldn't extract from error
    if (!toolName) {
        const name = toolIndex.getName(event.toolUseId);
        if (name) {
            toolName = name;
        }
    }
    if (!toolName)
        return null;
    // Check if it's an MCP tool (mcp__{slug}__{toolname})
    if (!toolName.startsWith('mcp__'))
        return null;
    const parts = toolName.split('__');
    if (parts.length < 3)
        return null;
    // parts[1] is guaranteed to exist since we checked parts.length >= 3
    const sourceSlug = parts[1]!;
    // Check if source exists but is inactive
    const sourceExists = transportOwner["sourceManager"].getAllSources().some((s) => s.config.slug === sourceSlug);
    const isActive = transportOwner["sourceManager"].isSourceActive(sourceSlug);
    if (sourceExists && !isActive) {
        // Get input from toolIndex
        const input = toolIndex.getInput(event.toolUseId);
        return { sourceSlug, toolName, input: input ?? {} };
    }
    return null;
}
