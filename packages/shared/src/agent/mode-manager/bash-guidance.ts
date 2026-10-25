/// <reference path="../../types/incr-regex-package.d.ts" />
import { READ_ONLY_GIT_HARDENING_ARGS } from "../bash-validator.ts";
import { type CompiledBashPattern, type CompiledBlockedCommandHint, type MismatchAnalysis } from "../mode-types.ts";
// Import incr-regex-package for smart pattern mismatch diagnostics
// This library allows character-by-character matching to find WHERE a regex match failed
import { IREGEX } from "incr-regex-package";
import type { RelevantPatternInfo, ToolCheckConfig } from './bash-contracts.ts';

/**
 * Find patterns that might be relevant to the attempted command.
 * Extracts the first word (command name) and finds patterns containing it.
 * This helps provide actionable error messages when a command is blocked.
 *
 * For example, if the command is "git -C /path status", this will find
 * the git pattern and show the agent what format is expected.
 */
export function findRelevantPatterns(command: string, patterns: CompiledBashPattern[]): RelevantPatternInfo[] {
  // Extract the first word (command name) from the command
  const firstWord = command.trim().split(/\s+/)[0]?.toLowerCase();
  if (!firstWord) return [];

  // Find patterns whose source contains the command name
  // This catches patterns like "^git\s+(status|log|...)" when command starts with "git"
  const relevant: RelevantPatternInfo[] = [];

  for (const pattern of patterns) {
    // Check if the pattern source contains the command name
    // Use case-insensitive matching and look for the command at word boundaries
    const sourceLower = pattern.source.toLowerCase();
    if (
      sourceLower.includes(firstWord) ||
      sourceLower.startsWith(`^${firstWord}`)
    ) {
      relevant.push({
        source: pattern.source,
        comment: pattern.comment,
      });
    }
  }

  // Limit to top 3 most relevant patterns to avoid overwhelming the agent
  return relevant.slice(0, 3);
}

/**
 * Resolve command-specific hint for blocked bash commands.
 * Uses exact base-command match and optional whenNotMatching condition.
 */
export function findBlockedCommandHint(command: string, config: ToolCheckConfig): CompiledBlockedCommandHint | undefined {
  const firstToken = command.trim().split(/\s+/)[0]?.toLowerCase();
  if (!firstToken) return undefined;
  const baseCommand = firstToken.split('/').pop() ?? firstToken;

  if (baseCommand === 'git') {
    const safePrefix = `git ${READ_ONLY_GIT_HARDENING_ARGS.join(' ')}`;
    return {
      command: 'git',
      reason: 'Repository Git configuration can execute filesystem, hook, pager, formatting, or signature helpers, so an unneutralized Git command is not provably read-only.',
      context: 'Use the host-owned read-only Git grammar; this retry does not require broader permission.',
      tryInstead: [
        `Retry the supported read-only operation with the exact prefix \`${safePrefix}\`.`,
        'Use only rev-parse, branch --show-current, merge-base, ls-files, grep without a pattern file, or non-patch log. For worktree status or content differences, use target-bound Read/rg/cmp instead of Git status/diff/show.',
      ],
      example: `${safePrefix} rev-parse HEAD`,
    };
  }

  const hints = config.blockedCommandHints ?? [];

  for (const hint of hints) {
    if (hint.command !== baseCommand) continue;

    // If a condition is provided, hint applies only when command does NOT match it
    if (hint.whenNotMatchingRegex && hint.whenNotMatchingRegex.test(command)) {
      continue;
    }

    return hint;
  }

  return undefined;
}

/**
 * Analyze WHY a command didn't match any pattern using incremental regex matching.
 * Uses incr-regex-package to find exactly WHERE in the command matching stopped,
 * which helps generate actionable error messages.
 *
 * For example, if the command is "git -C /path status" and the pattern is
 * "^git\s+(status|log|diff)", this will detect that matching stopped at "-C"
 * and suggest running from within the repo directory instead.
 */
export function analyzePatternMismatch(command: string, patterns: CompiledBashPattern[]): MismatchAnalysis | null {
  const trimmedCommand = command.trim();
  if (!trimmedCommand) return null;

  // Find the pattern that matches the longest prefix of the command
  // This gives us the "best match" to analyze
  let bestMatch: {
    matchedCount: number;
    matchedPrefix: string;
    pattern: CompiledBashPattern;
  } | null = null;

  for (const pattern of patterns) {
    try {
      // Simplify the pattern for incr-regex: remove anchors and word boundaries
      // which aren't supported by the incremental matching library.
      // This is fine since we only use it for diagnostic purposes.
      const simplifiedPattern = pattern.source
        .replace(/^\^/, '')     // Remove start anchor
        .replace(/\$$/g, '')    // Remove end anchor
        .replace(/\\b/g, '');   // Remove word boundaries

      // Create incremental regex matcher from the simplified pattern
      // IREGEX is a class that takes a regex pattern string in its constructor
      const incr = new IREGEX(simplifiedPattern);

      // Use matchStr to process the entire command and get match info
      // Returns [success, charCount, matchedString]
      const [_success, charCount, matchedStr] = incr.matchStr(trimmedCommand);

      // Track the pattern that matched the most characters (best partial match)
      if (charCount > 0 && (!bestMatch || charCount > bestMatch.matchedCount)) {
        bestMatch = {
          matchedCount: charCount,
          matchedPrefix: matchedStr || trimmedCommand.substring(0, charCount),
          pattern,
        };
      }
    } catch {
      // If incr-regex can't parse the pattern (complex regex features),
      // skip this pattern - we'll fall back to basic diagnostics
      continue;
    }
  }

  // If no pattern matched anything, return null (unknown command)
  if (!bestMatch || bestMatch.matchedCount === 0) {
    return null;
  }

  // Analyze what token caused the mismatch
  const failedPosition = bestMatch.matchedCount;
  const remainingCommand = trimmedCommand.substring(failedPosition).trim();
  const failedToken = remainingCommand.split(/\s+/)[0] || '';

  // Generate a helpful suggestion based on what we found
  const suggestion = generateMismatchSuggestion(
    trimmedCommand,
    bestMatch.matchedPrefix,
    failedToken,
    bestMatch.pattern
  );

  return {
    matchedPrefix: bestMatch.matchedPrefix,
    failedAtPosition: failedPosition,
    failedToken,
    bestMatchPattern: {
      source: bestMatch.pattern.source,
      comment: bestMatch.pattern.comment,
    },
    suggestion,
  };
}

/**
 * Generate an actionable suggestion based on pattern mismatch analysis.
 * Looks for common patterns like flags before subcommands in git/gh/docker.
 */
function generateMismatchSuggestion(
  command: string,
  matchedPrefix: string,
  failedToken: string,
  pattern: CompiledBashPattern
): string | undefined {
  const firstWord = command.split(/\s+/)[0]?.toLowerCase();

  // Detect "flags before subcommand" pattern for git, gh, docker, kubectl
  const commandsWithSubcommands = ['git', 'gh', 'docker', 'kubectl', 'npm', 'yarn', 'cargo'];
  if (
    commandsWithSubcommands.includes(firstWord || '') &&
    failedToken.startsWith('-')
  ) {
    // The command has a flag where a subcommand was expected
    // Try to find the actual subcommand later in the command
    const words = command.split(/\s+/);
    const subcommandCandidates = words.slice(1).filter(w => !w.startsWith('-') && !w.includes('/'));

    if (subcommandCandidates.length > 0) {
      const likelySubcommand = subcommandCandidates[0];
      return `The pattern expects \`${firstWord} <subcommand>\` directly, but found flag \`${failedToken}\` first. ` +
        `Try running from within the target directory, or use: \`${firstWord} ${likelySubcommand} ...\``;
    }

    return `The pattern expects a subcommand after \`${firstWord}\`, but found flag \`${failedToken}\`. ` +
      `Run from the target directory or switch to Ask/Execute mode.`;
  }

  // Detect possible typos in subcommands using simple heuristics
  // (Check if failedToken is close to any word in the pattern)
  if (pattern.comment && !failedToken.startsWith('-')) {
    // Extract subcommand options from pattern comment if present
    // e.g., "Git read-only operations: view status, history, branches, diffs"
    const commentLower = pattern.comment.toLowerCase();
    const failedTokenLower = failedToken.toLowerCase();

    // Check for common subcommand names in the comment
    const commonSubcommands = ['status', 'log', 'diff', 'show', 'branch', 'list', 'view', 'get', 'describe'];
    for (const sub of commonSubcommands) {
      // Simple Levenshtein-ish check: if token is within 2 chars of a known subcommand
      if (
        commentLower.includes(sub) &&
        Math.abs(failedTokenLower.length - sub.length) <= 2 &&
        failedTokenLower !== sub
      ) {
        // Check if first 2 chars match (simple typo detection)
        if (failedTokenLower.substring(0, 2) === sub.substring(0, 2)) {
          return `Did you mean \`${firstWord} ${sub}\` instead of \`${firstWord} ${failedToken}\`?`;
        }
      }
    }
  }

  // Generic fallback
  return undefined;
}

/**
 * Format actionable guidance for permission customization.
 * Tells the agent where to read/modify permissions.
 */
export function formatPermissionGuidance(config: ToolCheckConfig): string {
  const lines: string[] = [];

  // Only include guidance if permission paths are available
  if (config.permissionPaths) {
    lines.push('');
    lines.push('To see what commands are allowed in Explore mode, read:');
    lines.push(`  • ${config.permissionPaths.workspacePath}`);
    lines.push(`  • ${config.permissionPaths.appDefaultPath}`);
    lines.push('');
    lines.push('To understand the permission system and how to customize:');
    lines.push(`  • ${config.permissionPaths.docsPath}`);
  }

  return lines.join('\n');
}
