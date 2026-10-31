import { omitUndefined } from '@craft-agent/shared/utils/json';
import { join } from "path";
import { existsSync } from "fs";
import { type LoadedSource } from "@craft-agent/shared/sources";
import { type ToolDisplayMeta } from "@craft-agent/core/types";
import { encodeIconToDataUrlAsync, getEmojiIcon, resolveToolIcon } from "@craft-agent/shared/utils";
import { loadAllSkills } from "@craft-agent/shared/skills";
import { getToolIconsDir } from "@craft-agent/shared/config";
// Import from server-core domain utilities
import { normalizeBrowserToolName } from "@craft-agent/server-core/domain";
import { resizeIconBuffer } from "@craft-agent/server-core/services";

/**
 * Resolve tool display metadata for a tool call.
 * Returns metadata with base64-encoded icon for viewer compatibility.
 *
 * @param toolName - Tool name from the event (e.g., "Skill", "mcp__linear__list_issues")
 * @param toolInput - Tool input (used for Skill tool to get skill identifier)
 * @param workspaceRootPath - Path to workspace for loading skills/sources
 * @param sources - Loaded sources for the workspace
 */
const BROWSER_TOOL_ICON_FILENAME = 'chrome.svg'

let browserToolIconDataUrlCache: string | null | undefined

async function getBrowserToolIconDataUrl(): Promise<string | undefined> {
  // Cache miss sentinel: undefined means "not computed yet"
  if (browserToolIconDataUrlCache !== undefined) {
    return browserToolIconDataUrlCache ?? undefined
  }

  try {
    const iconCandidates = [
      join(getToolIconsDir(), BROWSER_TOOL_ICON_FILENAME),
      // Dev fallback (before sync to ~/.craft-agent/tool-icons)
      join(process.cwd(), 'apps', 'electron', 'resources', 'tool-icons', BROWSER_TOOL_ICON_FILENAME),
      // Packaged fallback (app resources)
      join(process.resourcesPath, 'tool-icons', BROWSER_TOOL_ICON_FILENAME),
    ]

    for (const iconPath of iconCandidates) {
      if (!existsSync(iconPath)) continue
      const encoded = await encodeIconToDataUrlAsync(iconPath, { resize: resizeIconBuffer })
      if (encoded) {
        browserToolIconDataUrlCache = encoded
        return encoded
      }
    }

    browserToolIconDataUrlCache = null
  } catch {
    browserToolIconDataUrlCache = null
  }

  return browserToolIconDataUrlCache ?? undefined
}

export async function resolveToolDisplayMeta(
  toolName: string,
  toolInput: Record<string, unknown> | undefined,
  workspaceRootPath: string,
  sources: LoadedSource[]
): Promise<ToolDisplayMeta | undefined> {
  // Check if it's an MCP tool (format: mcp__<serverSlug>__<toolName>)
  if (toolName.startsWith('mcp__')) {
    const parts = toolName.split('__')
    if (parts.length >= 3) {
      const serverSlug = parts[1]
      const toolSlug = parts.slice(2).join('__')

      // Internal MCP server tools (session, docs)
      const internalMcpServers: Record<string, Record<string, string>> = {
        'session': {
          'SubmitPlan': 'Submit Plan',
          'call_llm': 'LLM Query',
          'config_validate': 'Validate Config',
          'skill_validate': 'Validate Skill',
          'mermaid_validate': 'Validate Mermaid',
          'source_test': 'Test Source',
          'source_oauth_trigger': 'OAuth',
          'source_google_oauth_trigger': 'Google Auth',
          'source_slack_oauth_trigger': 'Slack Auth',
          'source_microsoft_oauth_trigger': 'Microsoft Auth',
          'source_credential_prompt': 'Enter Credentials',
          'transform_data': 'Transform Data',
          'render_template': 'Render Template',
          'update_user_preferences': 'Update Preferences',
          'send_developer_feedback': 'Send Feedback',
          'browser_tool': 'Browser',
        },
        'craft-agents-docs': {
          'SearchCraftAgents': 'Search Docs',
        },
      }

      const internalServer = serverSlug === undefined ? undefined : internalMcpServers[serverSlug]
      if (internalServer) {
        const displayName = internalServer[toolSlug]
        if (displayName) {
          const normalizedBrowserTool = normalizeBrowserToolName(toolSlug)
          return omitUndefined<ToolDisplayMeta>({
            displayName,
            iconDataUrl: normalizedBrowserTool ? await getBrowserToolIconDataUrl() : undefined,
            category: 'native' as const,
          })
        }
      }

      // External source tools
      let sourceSlug = serverSlug

      // Special case: api-bridge server embeds source slug in tool name as "api_{slug}"
      // e.g., mcp__api-bridge__api_stripe → sourceSlug = "stripe"
      if (sourceSlug === 'api-bridge' && toolSlug.startsWith('api_')) {
        sourceSlug = toolSlug.slice(4)
      }

      const source = sources.find(s => s.config.slug === sourceSlug)
      if (source) {
        // Try file-based icon first, fall back to emoji icon from config
        const iconDataUrl = source.iconPath
          ? await encodeIconToDataUrlAsync(source.iconPath, { resize: resizeIconBuffer })
          : getEmojiIcon(source.config.icon)
        return omitUndefined<ToolDisplayMeta>({
          displayName: source.config.name,
          iconDataUrl,
          description: source.config.tagline,
          category: 'source' as const,
        })
      }
    }
    return undefined
  }

  // Check if it's the Skill tool
  if (toolName === 'Skill' && toolInput) {
    // Skill input has 'skill' param with format: "skillSlug" or "workspaceId:skillSlug"
    const skillParam = toolInput["skill"] as string | undefined
    if (skillParam) {
      // Extract skill slug (remove workspace prefix if present)
      const skillSlug = skillParam.includes(':') ? skillParam.split(':').pop() : skillParam
      if (skillSlug) {
        // Load skills and find the one being invoked
        try {
          const skills = loadAllSkills(workspaceRootPath)
          const skill = skills.find(s => s.slug === skillSlug)
          if (skill) {
            // Try file-based icon first, fall back to emoji icon from metadata
            const iconDataUrl = skill.iconPath
              ? await encodeIconToDataUrlAsync(skill.iconPath, { resize: resizeIconBuffer })
              : getEmojiIcon(skill.metadata.icon)
            return omitUndefined<ToolDisplayMeta>({
              displayName: skill.metadata.name,
              iconDataUrl,
              description: skill.metadata.description,
              category: 'skill' as const,
            })
          }
        } catch {
          // Skills loading failed, skip
        }
      }
    }
    return undefined
  }

  // CLI tool icon resolution for Bash commands
  // Parses the command string to detect known tools (git, npm, docker, etc.)
  // and resolves their brand icon from ~/.craft-agent/tool-icons/
  if (toolName === 'Bash' && toolInput?.["command"]) {
    try {
      const toolIconsDir = getToolIconsDir()
      const match = resolveToolIcon(String(toolInput["command"]), toolIconsDir)
      if (match) {
        return {
          displayName: match.displayName,
          iconDataUrl: match.iconDataUrl,
          category: 'native' as const,
        }
      }
    } catch {
      // Icon resolution is best-effort — never crash the session for it
    }
  }

  // Native browser tool names (with Chrome icon)
  const normalizedBrowserToolName = normalizeBrowserToolName(toolName)
  if (normalizedBrowserToolName) {
    const browserDisplayName = normalizedBrowserToolName
      .split('_')
      .map((part, index) => (index === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
      .join(' ')
      .replace(/^browser\s+/i, 'Browser ')

    return omitUndefined<ToolDisplayMeta>({
      displayName: browserDisplayName,
      iconDataUrl: await getBrowserToolIconDataUrl(),
      category: 'native' as const,
    })
  }

  // Native tool display names (no icons - UI handles these with built-in icons)
  // This ensures toolDisplayMeta is always populated for consistent display
  const nativeToolNames: Record<string, string> = {
    'Read': 'Read',
    'Write': 'Write',
    'Edit': 'Edit',
    'Bash': 'Terminal',
    'Grep': 'Search',
    'Glob': 'Find Files',
    'Task': 'Agent',
    'Agent': 'Agent',
    'WebFetch': 'Fetch URL',
    'WebSearch': 'Web Search',
    'TodoWrite': 'Update Todos',
    'NotebookEdit': 'Edit Notebook',
    'KillShell': 'Kill Shell',
    'TaskOutput': 'Task Output',
  }

  const nativeDisplayName = nativeToolNames[toolName]
  if (nativeDisplayName) {
    return {
      displayName: nativeDisplayName,
      category: 'native' as const,
    }
  }

  // Unknown tool - no display metadata (will fall back to tool name in UI)
  return undefined
}
