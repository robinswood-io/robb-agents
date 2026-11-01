/**
 * Automation System Validation
 *
 * Validators for automations.json configuration files.
 * Used by PreToolUse automations and workspace validators.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolveAutomationsConfigPath } from "../resolve-config-path.ts";
import { isValidLabelId } from "../../labels/storage.ts";
import { extractLabelId } from "../../labels/values.ts";
import { getLlmConnection } from "../../config/storage.ts";
import { getDefaultModelsForConnection } from "../../config/llm-connections.ts";
import type { ModelDefinition } from "../../config/models.ts";
import type { ValidationResult, ValidationIssue } from "../../config/validators.ts";
import { validateAutomationsContent } from './content-validation.ts';

/**
 * Validate automations.json from workspace path (reads from disk).
 * Follows the same pattern as other validators in validators.ts.
 */
export function validateAutomations(workspaceRoot: string): ValidationResult {
  const configPath = resolveAutomationsConfigPath(workspaceRoot);
  const file = 'automations.json';

  // Automations config is optional - no config means no automations (valid state)
  if (!existsSync(configPath)) {
    return {
      valid: true,
      errors: [],
      warnings: [{
        file,
        path: '',
        message: 'No automations configuration found (no automations configured)',
        severity: 'warning',
      }],
    };
  }

  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch (e) {
    return {
      valid: false,
      errors: [{
        file,
        path: '',
        message: `Cannot read file: ${e instanceof Error ? e.message : 'Unknown error'}`,
        severity: 'error',
      }],
      warnings: [],
    };
  }

  // Parse JSON once — validateAutomationsContent also parses, but we need the
  // parsed object for workspace-aware validations below
  let content: unknown;
  try {
    content = JSON.parse(raw);
  } catch (e) {
    return {
      valid: false,
      errors: [{
        file,
        path: '',
        message: `Invalid JSON: ${e instanceof Error ? e.message : 'Unknown error'}`,
        severity: 'error',
      }],
      warnings: [],
    };
  }

  // Validate content (schema + semantic checks)
  const contentResult = validateAutomationsContent(raw);
  if (!contentResult.valid) {
    return contentResult;
  }

  // Additional workspace-aware validations
  const errors: ValidationIssue[] = [];
  const warnings = [...contentResult.warnings];

  // Validate labels, llmConnection slugs, and model compatibility
  try {
    const config = content as { automations?: Record<string, Array<{ labels?: string[]; actions?: Array<{ type: string; llmConnection?: string; model?: string }> }>> };
    const labelEntries = config.automations;
    if (labelEntries) {
      for (const [event, matchers] of Object.entries(labelEntries)) {
        if (!matchers) continue;
        for (let i = 0; i < matchers.length; i++) {
          const matcher = matchers[i];
          if (matcher?.labels) {
            for (const label of matcher.labels) {
              // Extract label ID (handles "priority::3" -> "priority")
              const labelId = extractLabelId(label);
              if (!isValidLabelId(workspaceRoot, labelId)) {
                warnings.push({
                  file,
                  path: `automations.${event}[${i}].labels`,
                  message: `Label "${labelId}" does not exist in workspace`,
                  severity: 'warning',
                  suggestion: `Create this label in labels/config.json or use an existing label ID`,
                });
              }
            }
          }
          // Validate llmConnection slugs and model compatibility in prompt actions
          const actions = matcher?.actions;
          if (actions) {
            for (const action of actions) {
              if (action.type !== 'prompt') continue;

              if (action.llmConnection) {
                const connection = getLlmConnection(action.llmConnection);
                if (!connection) {
                  // Missing connection is an error — the automation will fail at runtime
                  // (falls back to default connection, which likely doesn't support the model)
                  errors.push({
                    file,
                    path: `automations.${event}[${i}].actions`,
                    message: `LLM connection "${action.llmConnection}" not found in config`,
                    severity: 'error',
                    suggestion: 'Check the connection slug in AI Settings or config.json',
                  });
                } else if (action.model) {
                  // Validate model is available for this connection
                  const availableModels = connection.models ?? getDefaultModelsForConnection(connection.providerType, connection.piAuthProvider);
                  const modelIds = availableModels.map(m => typeof m === 'string' ? m : (m as ModelDefinition).id);
                  // Check exact match or suffix match (e.g. "haiku" matches "claude-haiku-4-5-20251001")
                  const modelValue = action.model;
                  const isAvailable = modelIds.some(id =>
                    id === modelValue || id.endsWith(`/${modelValue}`) ||
                    // Also match short aliases: "haiku" → any id containing "haiku", "sonnet" → "sonnet", etc.
                    id.toLowerCase().includes(modelValue.toLowerCase())
                  );
                  if (!isAvailable) {
                    warnings.push({
                      file,
                      path: `automations.${event}[${i}].actions`,
                      message: `Model "${modelValue}" may not be available on connection "${action.llmConnection}" (${connection.providerType})`,
                      severity: 'warning',
                      suggestion: `Available models: ${modelIds.slice(0, 5).join(', ')}${modelIds.length > 5 ? `, ... (${modelIds.length} total)` : ''}`,
                    });
                  }
                }
              }
            }
          }
        }
      }
    }
  } catch {
    // JSON already validated, this shouldn't happen
  }

  const allErrors = [...contentResult.errors, ...errors];
  return {
    valid: allErrors.length === 0,
    errors: allErrors,
    warnings,
  };
}
