import type { RoutingMeta } from '@craft-agent/core/types';
export type SourceSensitivity = 'public' | 'internal' | 'confidential' | 'restricted';
/** Read compatibility for historical receipts; no model is selected from these values. */
export type LegacyAutomaticModelTier = 'routine' | 'standard' | 'complex' | 'highRisk';
export interface SelectionSnapshot {version:2;profile:'maximum-quality'|'balanced';origin:'mission';model:string;thinkingLevel:import('../agent/thinking-levels.ts').ThinkingLevel;requestedModel?:string;}
export type AuthenticatedTaskEnvelope = 'mission-v2' | 'specialist-execution';
export function extractAuthenticatedTaskText(
  text: string,
  authenticatedEnvelope?: AuthenticatedTaskEnvelope,
): string {
  if (authenticatedEnvelope === 'mission-v2') {
    const missionObjective = text.match(
      /^Mission objective:[^\S\r\n]*([\s\S]*?)(?=^(?:Work item|Declared effect|Specialty|Role instructions|Mandatory skills|Declared tools|Assignment|Acceptance criteria|Required evidence|Upstream (?:submissions|evidence)):\s*|(?![\s\S]))/im,
    )?.[1]?.trim();
    const missionAssignment = text.match(
      /^Assignment:[^\S\r\n]*(?:\r?\n)?([\s\S]*?)(?=^(?:Acceptance criteria|Required evidence|Upstream (?:submissions|evidence)):\s*|(?![\s\S]))/im,
    )?.[1]?.trim();
    if (missionObjective || missionAssignment) {
      return [missionObjective, missionAssignment].filter(Boolean).join('\n');
    }
  }
  if (authenticatedEnvelope === 'specialist-execution') {
    return text.match(/<\/specialist_execution>\s*([\s\S]+)/i)?.[1]?.trim() || text;
  }
  return text;
}

export function maxSourceSensitivity(values: Array<SourceSensitivity | undefined>): SourceSensitivity | undefined { const order: SourceSensitivity[]=['public','internal','confidential','restricted']; return values.filter((v): v is SourceSensitivity=>v!==undefined).sort((a,b)=>order.indexOf(b)-order.indexOf(a))[0]; }
