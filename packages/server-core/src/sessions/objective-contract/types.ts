import type { ActiveSessionObjective } from "@craft-agent/shared/sessions";

export interface ObjectiveTransitionInput {
  existing?: ActiveSessionObjective;
  messageId: string;
  text: string;
  lifetimeCostUsd?: number;
  lifetimeTokens?: number;
  nowMs?: number;
  delegatedRole?: 'worker' | 'reviewer';
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
