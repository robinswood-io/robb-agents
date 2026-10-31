import type { ConditionContext } from "../conditions.ts";



// ============================================================================
// Helpers
// ============================================================================

export function ctx(payload: Record<string, unknown>, overrides?: Partial<ConditionContext>): ConditionContext {
  return { payload, ...overrides };
}

/** Create a Date at a specific time on a known day (2026-03-13 is a Friday) */
export function friday(hours: number, minutes: number): Date {
  return new Date(2026, 2, 13, hours, minutes, 0, 0); // March 13, 2026
}

export function monday(hours: number, minutes: number): Date {
  return new Date(2026, 2, 9, hours, minutes, 0, 0); // March 9, 2026
}
