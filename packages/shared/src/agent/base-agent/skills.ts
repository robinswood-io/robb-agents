/**
 * BaseAgent Abstract Class
 *
 * Shared base class for all AI agent backends (ClaudeAgent, PiAgent).
 * Extracts common functionality including:
 * - Model/thinking configuration
 * - Permission mode management (via PermissionManager)
 * - Source management (via SourceManager)
 * - Planning heuristics (via PlanningAdvisor)
 * - Config watching (via ConfigWatcherManager)
 * - Usage tracking (via UsageTracker)
 *
 * Provider-specific behavior (chat, abort, capabilities) is implemented in subclasses.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
// Skill extraction for Codex/Copilot backends (Claude uses native SDK Skill tool)
import { parseMentions, resolveSkillMentions, resolveSourceMentions, resolveFileMentions } from "../../mentions/index.ts";
import { loadAllSkills } from "../../skills/storage.ts";
import type { BaseAgent } from '../base-agent.ts';
import type { BaseAgentExtractSkillPathsResult } from './protocol.ts';

// ============================================================
  // Skill Path Resolution (shared across backends)
  // ============================================================

  /**
   * Extract skill mentions from a message and resolve their SKILL.md paths.
   *
   * Parses [skill:slug] or [skill:workspaceId:slug] mentions, resolves the
   * corresponding SKILL.md file paths. Does NOT read the files — the model
   * must read them itself (enforced by PrerequisiteManager).
   *
   * @param message - The user message containing potential skill mentions
   * @returns Object with:
   *   - skillPaths: Map of slug → resolved SKILL.md absolute path
   *   - cleanMessage: Message with mentions stripped, or default directive
   *   - missingSkills: Array of skill slugs that were mentioned but not found
   */
export function extractSkillPaths(transportOwner: BaseAgent, message: string): BaseAgentExtractSkillPathsResult {
    const workspaceRoot = transportOwner["config"].workspace?.rootPath ?? transportOwner["workingDirectory"];
    const projectRoot = transportOwner["config"].session?.workingDirectory;
    const sealedSkills = transportOwner["config"].sealedSkillPackages;
    const skills = sealedSkills ?? loadAllSkills(workspaceRoot, projectRoot);
    const skillSlugs = skills.map(s => s.slug);
    transportOwner["debug"](`[extractSkillPaths] Available skills: ${skillSlugs.join(', ')}`);
    const parsed = parseMentions(message, skillSlugs, []);
    transportOwner["debug"](`[extractSkillPaths] Parsed skills: ${JSON.stringify(parsed.skills)}`);
    if (parsed.invalidSkills && parsed.invalidSkills.length > 0) {
        transportOwner["debug"](`[extractSkillPaths] Invalid skills: ${JSON.stringify(parsed.invalidSkills)}`);
    }
    // Resolve SKILL.md paths for matched skills
    const skillPaths = new Map<string, string>();
    const sealedSkillContents = new Map<string, string>();
    for (const slug of parsed.skills) {
        const skill = skills.find(s => s.slug === slug);
        if (skill) {
            if (!('path' in skill)) {
                sealedSkillContents.set(slug, skill.content);
                continue;
            }
            const skillMdPath = join(skill.path, 'SKILL.md');
            if (existsSync(skillMdPath)) {
                skillPaths.set(slug, skillMdPath);
                transportOwner["debug"](`[extractSkillPaths] Resolved skill ${slug} → ${skillMdPath}`);
            }
            else {
                transportOwner["debug"](`[extractSkillPaths] SKILL.md not found: ${skillMdPath}`);
            }
        }
    }
    // Resolve mentions to semantic markers (like file mentions) instead of stripping them.
    // This preserves sentence structure: "find the bug in [skill:datadog-api]"
    // becomes "find the bug in [Mentioned skill: Datadog API (slug: datadog-api)]"
    const skillNames = new Map(skills.map(s => [
        s.slug,
        'metadata' in s ? s.metadata.name : s.name,
    ]));
    const withSkills = resolveSkillMentions(message, skillNames);
    const withSources = resolveSourceMentions(withSkills);
    const workDir = transportOwner["config"].session?.workingDirectory ?? transportOwner["workingDirectory"];
    const resolved = resolveFileMentions(withSources, workDir).trim();
    // If user sent only skill mentions with no other text, add a directive
    const cleanMessage = (!resolved && (skillPaths.size > 0 || sealedSkillContents.size > 0))
        ? 'Follow the skill instructions from the files listed above.'
        : resolved;
    transportOwner["debug"](`[extractSkillPaths] Clean message: "${cleanMessage.slice(0, 100)}...", skills: ${skillPaths.size}`);
    return {
        skillPaths,
        sealedSkillContents,
        cleanMessage,
        missingSkills: parsed.invalidSkills || []
    };
}

/**
   * Format a directive telling the model to read skill SKILL.md files before proceeding.
   * Called from chat() — all agents get the same directive prepended to their message.
   */
export function formatSkillDirective(transportOwner: BaseAgent, skillPaths: Map<string, string>): string {
    if (skillPaths.size === 0)
        return '';
    const pathList = [...skillPaths.entries()]
        .map(([slug, path]) => `- ${path} (skill: ${slug})`)
        .join('\n');
    return `Before proceeding with the user's request, you MUST read the following skill instruction files using the Read tool or \`cat\` via Bash:\n${pathList}\n\nDo not take any other action until you have read these files.`;
}

export function formatSealedSkillDirective(transportOwner: BaseAgent, skills: Map<string, string>): string {
    if (skills.size === 0)
        return '';
    return [...skills.entries()].map(([slug, content]) => `<host_sealed_skill_package slug=${JSON.stringify(slug)}>\n${content}\n</host_sealed_skill_package>`).join('\n\n')
        + '\n\nThese are the complete host-sealed skill package bytes for this turn. Follow them directly; do not read or discover a live skill package from the filesystem.';
}
