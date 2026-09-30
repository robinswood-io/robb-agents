/**
 * Auto-Label Evaluator
 *
 * Core evaluation engine for auto-label rules. Scans user messages against
 * configured regex patterns, producing label matches.
 *
 * Evaluation flow:
 * 1. Strip code blocks from message (avoid matching inside code)
 * 2. Walk the label tree, collect all labels with autoRules
 * 3. For each rule: run regex with forced 'g' flag, substitute capture groups
 * 4. Normalize extracted values based on the label's valueType
 * 5. Deduplicate matches (same labelId + value = keep only first)
 * 6. Cap at MAX_MATCHES_PER_MESSAGE to prevent label explosion
 * 7. Return array of AutoLabelMatch ready for session storage
 */

import type { LabelConfig, AutoLabelRule } from '../types.ts'
import type { AutoLabelMatch } from './types.ts'
import { normalizeValue } from './normalize.ts'

/** Maximum number of auto-label matches per message to prevent label explosion from pasted logs/data */
const MAX_MATCHES_PER_MESSAGE = 10

/**
 * Built-in default topic patterns for common conversation themes.
 * When a label does not have explicit `autoRules` defined, these patterns
 * allow automatic tagging of chats based on user intent and domain.
 * Supports both English and French keywords.
 */
const DEFAULT_TOPIC_PATTERNS: Record<string, string> = {
  bug: '\\b(?:bug|bugs|fix|fixes|fixed|fixing|error|errors|crash|crashes|issue|issues|exception|exceptions|broken|patch|patching|debug|debugging|fail|failed|failure|erreur|erreurs|panne|pannes|corriger|correction|bloqu(?:ant|é|ee|es))\\b',
  code: '\\b(?:code|coding|refactor|refactoring|component|components|function|functions|class|classes|endpoint|endpoints|api|apis|typescript|javascript|python|rust|golang|backend|frontend|fullstack|implementation|composant|composants|fonction|fonctions|developp(?:er|ement))\\b',
  automation: '\\b(?:auto|automation|automations|script|scripts|cron|crons|ci|cd|pipeline|pipelines|docker|container|containers|workflow|workflows|bot|bots|automatisation|automatisations)\\b',
  design: '\\b(?:design|designs|ui|ux|css|tailwind|style|styles|theme|themes|layout|layouts|font|fonts|color|colors|interface|interfaces|maquette|maquettes|visuel|visuels)\\b',
  writing: '\\b(?:writing|write|doc|docs|documentation|readme|article|articles|blog|posts|copy|copywriting|redaction|rediger|texte|textes|traduction|translation)\\b',
  research: '\\b(?:research|researching|investigate|investigation|explore|exploration|audit|audits|benchmark|benchmarks|compare|comparison|recherche|recherches|analyse|analyses|etude|etudes)\\b',
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Recursively collect all labels that have autoRules defined, or provide
 * built-in topic rules for standard categories and hashtags.
 * Walks the entire label tree depth-first.
 */
export function collectAutoLabelRules(labels: LabelConfig[]): Array<{
  label: LabelConfig
  rule: AutoLabelRule
}> {
  const result: Array<{ label: LabelConfig; rule: AutoLabelRule }> = []

  function walk(nodes: LabelConfig[]) {
    for (const label of nodes) {
      if (label.autoRules && label.autoRules.length > 0) {
        for (const rule of label.autoRules) {
          result.push({ label, rule })
        }
      } else {
        // Built-in topic inference for standard labels without custom autoRules
        const topicPattern = DEFAULT_TOPIC_PATTERNS[label.id.toLowerCase()]
        if (topicPattern) {
          result.push({
            label,
            rule: {
              pattern: topicPattern,
              flags: 'gi',
              description: `Built-in topic pattern for ${label.name}`,
            },
          })
        }

        // Hashtag matching for any label (#bug, #code, #auth, etc.)
        const escapedId = escapeRegex(label.id)
        const escapedName = escapeRegex(label.name.replace(/\s+/g, ''))
        result.push({
          label,
          rule: {
            pattern: `(?:^|\\s)#(?:${escapedId}|${escapedName})\\b`,
            flags: 'gi',
            description: `Hashtag match for #${label.id}`,
          },
        })

        // Keyword mention for custom domain labels (length >= 4, e.g. "Stripe", "Auth", "Billing")
        const cleanName = label.name.trim()
        if (cleanName.length >= 4 && !DEFAULT_TOPIC_PATTERNS[cleanName.toLowerCase()]) {
          result.push({
            label,
            rule: {
              pattern: `\\b${escapeRegex(cleanName)}\\b`,
              flags: 'gi',
              description: `Keyword match for ${label.name}`,
            },
          })
        }
      }

      if (label.children) {
        walk(label.children)
      }
    }
  }

  walk(labels)
  return result
}

/**
 * Strip fenced code blocks and inline code from message text.
 * Prevents regex patterns from matching inside code examples, logs, etc.
 */
function stripCodeBlocks(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '')  // fenced code blocks
    .replace(/`[^`]+`/g, '')          // inline code
}

/**
 * Evaluate all auto-label rules against a user message.
 * Returns deduplicated matches with normalized values, capped at MAX_MATCHES_PER_MESSAGE.
 *
 * @param message - The user's message text to scan
 * @param labels - The workspace label tree (from config)
 */
export function evaluateAutoLabels(
  message: string,
  labels: LabelConfig[],
): AutoLabelMatch[] {
  // Strip code blocks before scanning to avoid matching inside code
  const cleanMessage = stripCodeBlocks(message)

  const rules = collectAutoLabelRules(labels)
  const matches: AutoLabelMatch[] = []
  // Track seen entries to deduplicate (same label + same value = skip)
  const seen = new Set<string>()

  for (const { label, rule } of rules) {
    // Stop if we've hit the match limit
    if (matches.length >= MAX_MATCHES_PER_MESSAGE) break

    const ruleMatches = evaluateRegexRule(cleanMessage, label, rule)

    // Deduplicate and add to results (respecting match limit)
    for (const match of ruleMatches) {
      if (matches.length >= MAX_MATCHES_PER_MESSAGE) break

      const key = label.valueType && match.value ? `${match.labelId}::${match.value}` : match.labelId
      if (!seen.has(key)) {
        seen.add(key)
        matches.push(match)
      }
    }
  }

  return matches
}

/**
 * Evaluate a regex-based auto-label rule.
 * Always enforces the 'g' flag to prevent infinite exec() loops.
 * Uses single-pass $N substitution to prevent injection.
 */
function evaluateRegexRule(
  message: string,
  label: LabelConfig,
  rule: AutoLabelRule
): AutoLabelMatch[] {
  const matches: AutoLabelMatch[] = []

  try {
    // Ensure global flag is always present to prevent infinite exec() loops
    const flags = rule.flags
      ? (rule.flags.includes('g') ? rule.flags : rule.flags + 'g')
      : 'gi'
    const regex = new RegExp(rule.pattern, flags)
    let match: RegExpExecArray | null

    while ((match = regex.exec(message)) !== null) {
      // For boolean labels without valueType, do not capture random substrings as value
      let value = ''
      if (label.valueType) {
        // Single-pass $N substitution: prevents injection where captured text
        // contains $N patterns that would be double-substituted
        value = rule.valueTemplate
          ? rule.valueTemplate.replace(/\$(\d+)/g, (_, n) => match![parseInt(n)] ?? '')
          : match[1] ?? match[0]

        // Normalize based on the label's declared valueType
        value = normalizeValue(value, label.valueType)
      }

      matches.push({
        labelId: label.id,
        value,
        matchedText: match[0],
      })

      // Prevent infinite loop on zero-length matches
      if (match[0].length === 0) {
        regex.lastIndex++
      }
    }
  } catch (e) {
    // Invalid regex — skip silently (validation should catch this at config time)
    console.warn(`[AutoLabel] Invalid regex for label "${label.id}": ${rule.pattern}`, e)
  }

  return matches
}
