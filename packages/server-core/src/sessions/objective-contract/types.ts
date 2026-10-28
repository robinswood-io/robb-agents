import type { ActiveSessionObjective } from "@craft-agent/shared/sessions";

export interface ObjectiveTransitionInput {
  existing?: ActiveSessionObjective | undefined;
  messageId: string;
  text: string;
  lifetimeCostUsd?: number | undefined;
  lifetimeTokens?: number | undefined;
  nowMs?: number | undefined;
  delegatedRole?: 'worker' | 'reviewer' | undefined;
}

export function foldForIntent(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’']/g, '')
    .replace(/[^a-zA-Z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}
