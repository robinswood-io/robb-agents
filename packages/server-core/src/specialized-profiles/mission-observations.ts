import { createHash } from 'node:crypto';
import type { MissionSnapshot } from '@craft-agent/shared/missions';
import type {
  RootMissionSpecializationObservation,
  SpecializationSignal,
} from '@craft-agent/shared/specialized-profiles';

export interface MissionSpecializationObservationResult {
  observations: RootMissionSpecializationObservation[];
  analyzedMissionIds: string[];
  excludedMissionCount: number;
}

const TERMINAL_ANALYSIS_STATUSES = new Set(['completed', 'failed', 'blocked']);
const FAMILY_PATTERNS: ReadonlyArray<{ family: string; patterns: readonly RegExp[] }> = [
  {
    family: 'bounded-accounting',
    patterns: [
      /\baccount(?:ing|ant|ancy)?\b/i,
      /\bcomptab/i,
      /\bfactur/i,
      /\binvoice/i,
      /\blettrage\b/i,
      /\breconcil/i,
      /\brapprochement\b/i,
    ],
  },
  {
    family: 'document-production',
    patterns: [
      /\bpdf\b/i,
      /\bdocx?\b/i,
      /\bdocument/i,
      /\bpresentation\b/i,
      /\bprésentation\b/i,
      /\breport\b/i,
      /\brapport\b/i,
      /\bslides?\b/i,
    ],
  },
  {
    family: 'software-maintenance',
    patterns: [
      /\bbug\b/i,
      /\bci\b/i,
      /\bcode\b/i,
      /\bcommit\b/i,
      /\bdeploy/i,
      /\bfix\b/i,
      /\bimpl[ée]ment/i,
      /\bmaintenance\b/i,
      /\bpr\b/i,
      /\brefactor/i,
      /\btests?\b/i,
      /\btypescript\b/i,
    ],
  },
  {
    family: 'security-review',
    patterns: [/\baudit\b/i, /\bsecurity\b/i, /\bs[ée]curit/i, /\bthreat\b/i, /\bvuln/i],
  },
  {
    family: 'research',
    patterns: [/\bbenchmark\b/i, /\brecherche\b/i, /\bresearch\b/i, /\bsources?\b/i],
  },
  {
    family: 'customer-operations',
    patterns: [/\bclient\b/i, /\bcrm\b/i, /\bprospect/i, /\bsales\b/i, /\bcommercial/i],
  },
  {
    family: 'infrastructure-operations',
    patterns: [/\bdocker\b/i, /\binfra/i, /\bserver\b/i, /\bserveur\b/i, /\bssh\b/i],
  },
  {
    family: 'data-analysis',
    patterns: [/\banaly[sz]/i, /\bdataset\b/i, /\bdonn[ée]es?\b/i, /\bmetrics?\b/i, /\bsql\b/i],
  },
];

const PLATFORM_DEFECT_RE = /(?:schema|runtime|tool).*(?:invalid|missing|not found|unavailable)|(?:guide|status).*(?:required|unknown)/i;
const CONTEXT_GAP_RE = /compaction|context.*(?:missing|lost|unavailable)|objective.*(?:missing|lost)/i;

/**
 * Convert durable Mission snapshots into privacy-minimal, root-level signals.
 * No transcript, prompt, output, route, model, or permission is returned.
 */
export function buildMissionSpecializationObservations(
  snapshots: readonly MissionSnapshot[],
): MissionSpecializationObservationResult {
  const observations: RootMissionSpecializationObservation[] = [];
  const analyzedMissionIds: string[] = [];
  let excludedMissionCount = 0;

  for (const snapshot of [...snapshots].sort((left, right) =>
    left.spec.id.localeCompare(right.spec.id))) {
    const executable = Object.values(snapshot.workItems).filter(({ definition }) =>
      ['task', 'subtask', 'integration', 'correction'].includes(definition.kind));
    if (!TERMINAL_ANALYSIS_STATUSES.has(snapshot.status) || executable.length === 0) {
      excludedMissionCount += 1;
      continue;
    }

    const family = inferMissionFamily(snapshot);
    const signals = inferSignals(snapshot, executable);
    observations.push({
      observationId: `mission:${snapshot.spec.id}`,
      // Bind deduplication to the durable root mission identity as well as its
      // objective. Two distinct missions with identical wording are genuine
      // recurrence; duplicate observations of one mission are not.
      rootObjective: `sha256:${sha256(normalizeText(
        `${snapshot.spec.id}\n${snapshot.spec.objective}`,
      ))}`,
      family,
      signals,
    });
    analyzedMissionIds.push(snapshot.spec.id);
  }

  return { observations, analyzedMissionIds, excludedMissionCount };
}

function inferMissionFamily(snapshot: MissionSnapshot): string {
  // Mission titles and objectives are untrusted evidence. They may influence
  // which host-owned classifier matches, but their text is never copied into
  // a generated profile prompt or lifecycle contract.
  const structuredText = [
    snapshot.spec.title,
    snapshot.spec.objective,
    ...snapshot.spec.workItems.map((item) => item.title),
  ].join(' ');
  for (const candidate of FAMILY_PATTERNS) {
    if (candidate.patterns.some((pattern) => pattern.test(structuredText))) return candidate.family;
  }
  return 'general-workflow';
}

function inferSignals(
  snapshot: MissionSnapshot,
  executable: Array<MissionSnapshot['workItems'][string]>,
): SpecializationSignal[] {
  const signals = new Set<SpecializationSignal>();
  const reasons = [
    snapshot.statusReason,
    ...Object.values(snapshot.workItems).map((item) => item.statusReason),
  ].filter((value): value is string => Boolean(value)).join(' ');

  if (PLATFORM_DEFECT_RE.test(reasons)) signals.add('platform-defect');
  if (CONTEXT_GAP_RE.test(reasons)) signals.add('context-retrieval-gap');

  const deterministic = executable.every(({ definition }) =>
    Boolean(definition.execution || definition.connectorInvocation));
  signals.add(deterministic ? 'deterministic-procedure' : 'stable-variable-workflow');

  const referencedProfileIds = new Set(executable.map(({ agentProfileId, definition }) =>
    agentProfileId ?? definition.agentProfileId ?? snapshot.spec.defaultWorkerProfileId));
  const referencedProfiles = snapshot.spec.agentProfiles.filter((profile) =>
    referencedProfileIds.has(profile.id));
  if (referencedProfiles.some((profile) =>
    profile.skills.length > 0 || profile.tools.length > 0 || profile.sources.length > 0)
    || executable.some(({ definition }) => Boolean(definition.execution || definition.connectorInvocation))) {
    signals.add('stable-tool-boundary');
  }

  if (executable.every(({ definition }) => Boolean(definition.effect))) {
    signals.add('stable-risk-boundary');
  }
  if (executable.every(({ definition }) =>
    definition.acceptanceCriteria.length > 0 && definition.requiredEvidence.length > 0)
    && snapshot.spec.policy.requireIndependentReview
    && snapshot.spec.policy.requireIndependentSupervisor) {
    signals.add('stable-verification-boundary');
  }
  if (snapshot.spec.acceptanceCriteria.length > 0
    && snapshot.spec.policy.requireIndependentReview
    && snapshot.spec.policy.requireIndependentSupervisor) {
    signals.add('domain-judgment');
  }

  return [...signals].sort();
}

function normalizeText(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
