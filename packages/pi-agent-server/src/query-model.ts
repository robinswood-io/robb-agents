/** Resolve only explicit or inherited selection; never choose another model. */
export function resolveQueryModel(requestedModel: string | undefined, selectedModel: string | undefined): string {
  const model = requestedModel ?? selectedModel;
  if (!model?.trim()) throw new Error('A selected model is required for this query');
  return model;
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
    throw new Error(`Failed to activate selected model "${modelId}": ${detail}`, { cause: error });
  }
}

