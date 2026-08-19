import { isModelNotFoundError } from './model-resolution.ts';

interface QueryModelSelectionOptions {
  modelId: string;
  explicitlyRequested: boolean;
  compatible: boolean;
  authProvider?: string;
  resolvedProvider?: string;
  getFallbackModel: () => string;
}

/**
 * Keep automatic mini-model recovery for implicit requests, but never replace a
 * model explicitly selected by a caller.
 */
export function selectCompatibleQueryModel(options: QueryModelSelectionOptions): string {
  if (options.compatible) return options.modelId;

  if (options.explicitlyRequested) {
    throw new Error(
      `Explicit mini model "${options.modelId}" is unavailable or incompatible with provider ` +
      `"${options.authProvider ?? '(unknown)'}"` +
      (options.resolvedProvider ? ` (resolved provider: "${options.resolvedProvider}")` : ''),
    );
  }

  return options.getFallbackModel();
}

interface EphemeralModelSession<TModel> {
  setModel(model: TModel): Promise<void>;
  dispose(): void;
}

/**
 * Pi ignores `CreateAgentSessionOptions.model` for some ephemeral sessions, so
 * activation must be acknowledged before any prompt is sent. A failed session
 * is disposed here because the normal prompt lifecycle has not started yet.
 */
export async function activateEphemeralQueryModel<TModel>(
  session: EphemeralModelSession<TModel>,
  model: TModel,
  modelId: string,
): Promise<void> {
  try {
    await session.setModel(model);
  } catch (error) {
    session.dispose();
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to activate mini model "${modelId}": ${detail}`, { cause: error });
  }
}

/** Explicit requests are fail-closed; only implicit mini-model selection retries. */
export function shouldRetryQueryModel(error: unknown, explicitlyRequested: boolean): boolean {
  if (explicitlyRequested) return false;
  const message = error instanceof Error ? error.message : String(error);
  return isModelNotFoundError(message);
}
