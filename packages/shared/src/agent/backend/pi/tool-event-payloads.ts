import { isUnknownArray } from '../../../utils/json.ts';
import type { AgentEvent as PiAgentEvent } from '@earendil-works/pi-agent-core';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { PI_TOOL_NAME_MAP } from './constants.ts';
import { toolMetadataStore } from '../../../interceptor-common.ts';

type PiEvent = PiAgentEvent | AgentSessionEvent;

export function extractToolMetadataFromEvent(event: PiEvent): { intent?: string; displayName?: string } | undefined {
    const metadata = (event as {
      toolMetadata?: { intent?: unknown; displayName?: unknown };
    }).toolMetadata;

    if (!metadata) return undefined;

    const intent = typeof metadata.intent === 'string' ? metadata.intent : undefined;
    const displayName = typeof metadata.displayName === 'string' ? metadata.displayName : undefined;

    if (!intent && !displayName) return undefined;
    return { ...(intent !== undefined ? { intent } : {}), ...(displayName !== undefined ? { displayName } : {}) };
  }

export function resolveStoredMetadata(toolCallId: string, sessionDir?: string): { meta?: { intent?: string; displayName?: string }; keyTried?: string } {
    const candidates = new Set<string>([toolCallId]);
    if (toolCallId.includes('|')) {
      const [base] = toolCallId.split('|');
      if (base) candidates.add(base);
    }

    for (const candidate of candidates) {
      const meta = toolMetadataStore.get(candidate, sessionDir);
      if (meta) return { meta, keyTried: candidate };
    }

    return {  keyTried: Array.from(candidates).join(' -> ') };
  }

export function normalizeToolInput(
    toolName: string,
    args: Record<string, unknown>,
  ): Record<string, unknown> {
    if (toolName === 'Edit') {
      const normalized = { ...args };
      if ('path' in normalized && !('file_path' in normalized)) {
        normalized["file_path"] = normalized["path"];
        delete normalized["path"];
      }

      // Pi SDK >= 0.63.2 uses edits[] array instead of top-level oldText/newText.
      // Preserve the full edits[] payload so the renderer can expand and display
      // every replacement block. Also derive the first edit into flat old/new
      // fields as a compatibility bridge for UI paths that still expect them.
      const edits = normalized["edits"] as Array<{ oldText?: string; newText?: string }> | undefined;
      if (isUnknownArray(edits) && edits.length > 0 && edits[0]) {
        const first = edits[0];
        if (first.oldText != null && !('old_string' in normalized)) {
          normalized["old_string"] = first.oldText;
        }
        if (first.newText != null && !('new_string' in normalized)) {
          normalized["new_string"] = first.newText;
        }
      }

      // Legacy path: top-level oldText/newText (Pi SDK < 0.63.2 or resumed sessions)
      if ('oldText' in normalized && !('old_string' in normalized)) {
        normalized["old_string"] = normalized["oldText"];
        delete normalized["oldText"];
      }
      if ('newText' in normalized && !('new_string' in normalized)) {
        normalized["new_string"] = normalized["newText"];
        delete normalized["newText"];
      }
      return normalized;
    }

    if (toolName === 'Write') {
      const normalized = { ...args };
      if ('path' in normalized && !('file_path' in normalized)) {
        normalized["file_path"] = normalized["path"];
        delete normalized["path"];
      }
      return normalized;
    }

    if (toolName === 'Read' || toolName === 'Glob' || toolName === 'Grep') {
      const normalized = { ...args };
      if ('path' in normalized && !('file_path' in normalized)) {
        normalized["file_path"] = normalized["path"];
        delete normalized["path"];
      }
      return normalized;
    }

    return args;
  }

export function resolveToolName(rawName: string): string {
    return PI_TOOL_NAME_MAP[rawName] || rawName;
  }

export function extractToolResult(result: unknown, isError: boolean): string {
    if (typeof result === 'string') return result;

    if (result === undefined || result === null) {
      return isError ? 'Tool execution failed' : 'Success';
    }

    // Pi tool results follow the AgentToolResult shape: { content: [...], details: ... }
    const typed = result as {
      content?: Array<{ type: string; text?: string }>;
      details?: unknown;
    };

    if (isUnknownArray(typed.content)) {
      if (typed.content.length === 0) return '';
      const texts = typed.content
        .filter((c) => c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text!);
      if (texts.length > 0) return texts.join('\n');
    }

    // Fall back to JSON
    try {
      return JSON.stringify(result);
    } catch {
      return String(result);
    }
  }

export function getToolDisplayName(toolName: string): string | undefined {
    switch (toolName) {
      case 'Bash':
        return 'Run Command';
      case 'Read':
        return 'Read File';
      case 'Write':
        return 'Write File';
      case 'Edit':
        return 'Edit File';
      case 'Glob':
      case 'Find':
        return 'Search Files';
      case 'Grep':
        return 'Search Content';
      case 'Ls':
        return 'List Directory';
      default:
        return undefined;
    }
  }
