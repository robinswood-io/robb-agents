import type { SessionToolContext } from "../../context.ts";
import type { ToolResult, SourceConfig, ConnectionStatus } from "../../types.ts";
import { errorResponse } from "../../response.ts";
import { validateJsonFileHasFields, validateSourceConfigBasic } from "../../validation.ts";
import { sourceExists, getSourceConfigPath, getSourcePath } from "../../source-helpers.ts";
import { checkAuthStatus } from './auth-status.ts';
import { testConnection } from './connection-test.ts';
import { checkCompleteness, handleIconCheck } from './source-diagnostics.ts';
import type { SourceTestArgs } from './test-types.ts';

/**
 * Handle the source_test tool call.
 *
 * Performs:
 * 1. Schema validation - validates config.json structure
 * 2. Icon handling - checks/downloads icon
 * 3. Completeness check - warns about missing guide.md/icon/tagline
 * 4. Connection test - tests if source endpoint is reachable
 * 5. Auth status check - verifies authentication
 * 6. Metadata update - updates lastTestedAt, connectionStatus
 */
export async function handleSourceTest(
  ctx: SessionToolContext,
  args: SourceTestArgs
): Promise<ToolResult> {
  const { sourceSlug } = args;
  const lines: string[] = [];
  let hasErrors = false;
  let hasWarnings = false;
  let connectionStatus: ConnectionStatus = 'unknown';
  let connectionError: string | undefined;

  // 1. Check source exists
  if (!sourceExists(ctx.workspacePath, sourceSlug)) {
    return errorResponse(`Source '${sourceSlug}' not found in workspace.`);
  }

  // 2. Schema validation
  lines.push('## Schema Validation');
  const configPath = getSourceConfigPath(ctx.workspacePath, sourceSlug);
  const schemaResult = validateJsonFileHasFields(configPath, ['slug', 'name', 'type']);

  if (schemaResult.valid) {
    lines.push('✓ Config schema valid');
  } else {
    hasErrors = true;
    lines.push('✗ Config schema invalid:');
    for (const error of schemaResult.errors) {
      lines.push(`  - ${error.message}`);
    }
  }

  // 3. Load config for further checks
  const source = ctx.loadSourceConfig(sourceSlug);
  if (!source) {
    return errorResponse(`Failed to load source config for '${sourceSlug}'.`);
  }

  // Validate loaded config with basic validator
  const configValidation = validateSourceConfigBasic(source);
  if (!configValidation.valid) {
    hasErrors = true;
    for (const error of configValidation.errors) {
      lines.push(`  - ${error.path}: ${error.message}`);
    }
  }

  // 4. Icon handling
  lines.push('\n## Icon Status');
  const sourcePath = getSourcePath(ctx.workspacePath, sourceSlug);
  const iconResult = await handleIconCheck(ctx, sourcePath, sourceSlug, source);
  lines.push(...iconResult.lines);
  if (iconResult.hasWarning) hasWarnings = true;

  // 5. Completeness check
  lines.push('\n## Completeness Check');
  const completenessResult = checkCompleteness(ctx, sourcePath, source);
  lines.push(...completenessResult.lines);
  if (completenessResult.hasWarning) hasWarnings = true;

  // 6. Connection test
  lines.push('\n## Connection Test');
  const connectionResult = await testConnection(ctx, source, sourceSlug);
  lines.push(...connectionResult.lines);
  if (connectionResult.hasError) {
    hasErrors = true;
    connectionStatus = 'error';
    connectionError = connectionResult.error;
  } else if (connectionResult.success) {
    connectionStatus = 'connected';
  } else {
    // Soft failure (4xx ≠ 401/403, 5xx, etc): the probe reached the endpoint but
    // got a status we can't interpret as healthy. Demote validation to warnings
    // and refuse auto-activation — see #683 for what happens otherwise.
    connectionStatus = 'disconnected';
    hasWarnings = true;
  }

  // 7. Auth status
  lines.push('\n## Authentication');
  const authResult = await checkAuthStatus(ctx, source, sourceSlug);
  lines.push(...authResult.lines);
  if (authResult.hasWarning) hasWarnings = true;

  // 8. Auto-enable + metadata update
  // Defaults to true; pass autoEnable: false to keep pure validation behavior.
  // Gate on connectionStatus so a probe that returned 5xx/404 cannot push a
  // broken source into the live tool list. 401/403 still pass: the probe maps
  // those to connectionStatus=connected, and checkAuthStatus refreshes tokens.
  const autoEnable = args.autoEnable !== false;
  const shouldAutoEnable = autoEnable && !hasErrors && connectionStatus === 'connected';
  const willFlipEnabled = shouldAutoEnable && source.enabled === false;

  if (ctx.saveSourceConfig) {
    const sourceWithoutOverrides = { ...source };
    delete sourceWithoutOverrides.connectionError;
    const updatedSource: SourceConfig = {
      ...sourceWithoutOverrides,
      lastTestedAt: Date.now(),
      connectionStatus,
      ...(connectionError !== undefined ? { connectionError } : {}),
      // Fold enabled flip into the same save — one write, not two.
      ...(willFlipEnabled ? { enabled: true } : {}),
    };
    try {
      ctx.saveSourceConfig(updatedSource);
      lines.push('\n_Config updated with test results._');
      if (willFlipEnabled) {
        lines.push('✓ Source auto-enabled in config');
      }
    } catch {
      // Silently ignore save errors
    }
  }

  // Try to activate the source in the running session (backend may not support this).
  if (shouldAutoEnable) {
    if (ctx.activateSourceInSession) {
      try {
        const result = await ctx.activateSourceInSession(sourceSlug);
        if (result.ok) {
          // Activation succeeded — the backend will abort this turn after the
          // tool result lands, and the renderer auto-resends the original user
          // message with a "[{slug} activated]" suffix. From the model's POV,
          // the "next step" is a new turn where the tools are live.
          lines.push('✓ Source activated — the current turn will auto-restart with tools available');
        } else {
          lines.push(`⚠ Config updated, but session activation failed: ${result.reason ?? 'unknown error'}. Restart session to load tools.`);
          hasWarnings = true;
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'unknown error';
        lines.push(`⚠ Config updated, but session activation threw: ${msg}. Restart session to load tools.`);
        hasWarnings = true;
      }
    } else if (willFlipEnabled) {
      // Only nag about restart if we actually flipped the flag.
      lines.push('ℹ Config updated. Restart session to load tools (mid-session activation not available in this backend).');
    }
  } else if (autoEnable && !hasErrors && connectionStatus !== 'connected') {
    // The user asked to auto-enable but the connection probe didn't pass.
    // Tell them why activation is being skipped so they can act on it.
    lines.push(`ℹ Skipping activation because connection test did not succeed (status: ${connectionStatus}). Re-run source_test once the endpoint is reachable.`);
  }

  // Summary
  lines.push('\n---');
  if (hasErrors) {
    lines.push('**Result: ✗ Validation failed with errors**');
  } else if (hasWarnings) {
    lines.push('**Result: ⚠ Validation passed with warnings**');
  } else {
    lines.push('**Result: ✓ Validation passed**');
  }

  return {
    content: [{ type: 'text', text: lines.join('\n') }],
    isError: hasErrors,
  };
}
