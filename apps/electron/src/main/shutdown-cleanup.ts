/** A failed disposal must not strand the app after before-quit was prevented. */
export async function runShutdownCleanup(
  steps: ReadonlyArray<readonly [string, () => unknown | Promise<unknown>]>,
  onError: (step: string, error: unknown) => void,
): Promise<void> {
  for (const [name, run] of steps) {
    try { await run(); } catch (error) { onError(name, error); }
  }
}
