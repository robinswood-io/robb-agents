import type { ObjectiveAcceptanceCriterion, ObjectiveProcedureId } from '@craft-agent/core/types';
import type { ActiveSessionObjective } from '@craft-agent/shared/sessions';

export interface BusinessProcedure {
  id: ObjectiveProcedureId;
  version: 1;
  requirements: ReadonlyArray<{ id: string; description: string }>;
  instructions: string;
}

const PACKAGE_REQUIREMENTS = [
  { id: 'source-inventory', description: 'An inventory identifies the source items expected in the deliverable, including nested attachments.' },
  { id: 'content-completeness', description: 'Every expected source item is reconciled with the exact delivered package; missing and inaccessible items are reported.' },
  { id: 'recipient-usability', description: 'The exact final package opens and its content is readable and accessible without unexplained nested archives or broken links.' },
] as const;

const HANDOVER_REQUIREMENTS = [
  { id: 'infrastructure-inventory', description: 'Domain registrar, DNS management, and web/application hosting infrastructure (servers, IP, cPanel/SSH) are identified and recorded.' },
  { id: 'service-and-data-access', description: 'Databases, CMS/application codebase, and messaging/mail accounts and routing are enumerated.' },
  { id: 'credentials-and-continuity', description: 'Administrative credentials, recovery channels, and backups are verified or explicit missing items documented without guessing.' },
  { id: 'handover-dossier', description: 'A structured, actionable technical handover deliverable is produced with clear verification traces.' },
] as const;

/** Deterministic quality contracts. A requirement is satisfied by host-observed checks, not this prose. */
export const BUSINESS_PROCEDURES: Readonly<Record<ObjectiveProcedureId, BusinessProcedure>> = {
  'document-package': {
    id: 'document-package', version: 1, requirements: PACKAGE_REQUIREMENTS,
    instructions: 'Inventory the controlling sources first. Reconcile sources to the exact artifact and inspect it as the recipient will open it. Preserve dates, audience, exclusions and formatting constraints. Preparing a package does not authorize sending it.',
  },
  'document-delivery': {
    id: 'document-delivery', version: 1,
    requirements: [...PACKAGE_REQUIREMENTS, { id: 'delivery-receipt', description: 'The destination, exact attachment/version and delivery status match the authorized request.' }],
    instructions: 'Complete and inspect the package before an authorized send. Verify the exact transmitted attachment and recipient afterward. A sent receipt does not prove completeness or recipient satisfaction; never send again merely to repair a validation receipt.',
  },
  'campaign-preparation': {
    id: 'campaign-preparation', version: 1,
    requirements: [
      { id: 'audience-coverage', description: 'The target population, requested segments and coverage denominator are explicit; omissions and inaccessible segments are visible.' },
      { id: 'target-relevance', description: 'Targets are deduplicated and supported by current evidence of segment fit and usable contact channels.' },
      { id: 'message-quality', description: 'The exact campaign artifact satisfies audience, dates, proposition, format and call-to-action constraints.' },
      { id: 'measurement-plan', description: 'Objectives, observable outcomes, attribution and evaluation horizon are defined without claiming prospective commercial success.' },
    ],
    instructions: 'Define coverage before choosing an arbitrary contact count. Evaluate relevance and representative message quality. Compare alternatives against the same audience constraints. Preparing a campaign does not authorize outreach or prove future acquisition.',
  },
  'technical-handover': {
    id: 'technical-handover', version: 1,
    requirements: HANDOVER_REQUIREMENTS,
    instructions: 'Inventory registrar, DNS, web hosting, databases, CMS, and messaging channels from verified documents first. Inspect available internal archives and notes before declaring any access missing. Produce a clean handover dossier and verify recipient usability before any authorized transmission.',
  },
  'software-change': {
    id: 'software-change', version: 1,
    requirements: [
      { id: 'requested-behavior', description: 'The requested behavior is reproduced and verified against the exact changed revision.' },
      { id: 'regression-checks', description: 'Relevant regression checks pass on that revision and unrelated pre-existing failures are identified.' },
      { id: 'user-journey', description: 'The intended interaction, access conditions and final artifact are checked from the user perspective.' },
    ],
    instructions: 'Identify target and revision, reproduce the failure, implement the smallest complete change, then validate the actual interaction. If speed or fluidity is requested, measure it. A local correction does not authorize deployment.',
  },
  'software-deployment': {
    id: 'software-deployment', version: 1,
    requirements: [
      { id: 'requested-behavior', description: 'The requested behavior and regressions are tested on the exact candidate revision.' },
      { id: 'deployed-revision', description: 'The running target serves the authorized, tested revision.' },
      { id: 'user-access', description: 'The user can reach and use the target under their expected authentication and network conditions.' },
      { id: 'operational-health', description: 'Runtime health and the end-to-end journey are observed after deployment, with remaining failures explicit.' },
    ],
    instructions: 'Resolve authority and target before acting. Preserve rollback requirements, deploy only when authorized, match the running revision, and verify user access and real behavior. CI success alone is insufficient.',
  },
};

export function businessProcedureCoverage(id: ObjectiveProcedureId, criteria: ObjectiveAcceptanceCriterion[]): string[] {
  const covered = new Set(criteria.map(criterion => criterion.requirementId));
  return BUSINESS_PROCEDURES[id].requirements.filter(requirement => !covered.has(requirement.id)).map(requirement => requirement.id);
}

/** A selected playbook binds its quality contract before any tool is executed. */
export function bindBusinessProcedure(objective: ActiveSessionObjective, id: ObjectiveProcedureId): ActiveSessionObjective {
  if (!Object.hasOwn(BUSINESS_PROCEDURES, id)) throw new Error('Unknown business procedure');
  if (objective.terminalReconciliation) {
    if (objective.procedure?.id === id && objective.procedure.version === 1) return objective;
    throw new Error('Terminal reconciliation freezes the active business procedure');
  }
  if (objective.procedure && (objective.procedure.id !== id || objective.procedure.version !== 1)) {
    throw new Error('The selected playbook cannot replace the active business procedure');
  }
  return { ...objective, procedure: { id, version: 1 }, requiresAcceptanceCriteria: true };
}

export function businessProcedurePrompt(selected?: { id: ObjectiveProcedureId; version: 1 }): string {
  if (!selected) {
    const allowed = Object.values(BUSINESS_PROCEDURES)
      .map(procedure => `Allowed requirementId values for ${procedure.id}: ${procedure.requirements.map(requirement => requirement.id).join(', ')}`)
      .join('\n');
    return `For document packaging/delivery, campaign preparation, technical handover, software changes or deployment, select the applicable business procedure in set_completion_criteria using procedure and requirementId.\n${allowed}\nBind each requirement to actual observation checks; do not select a procedure for a simple explanation or manufacture external actions to satisfy it. The host returns missing coverage.`;
  }
  const procedure = BUSINESS_PROCEDURES[selected.id];
  if (!procedure || selected.version !== 1) return 'Unknown business procedure version: do not claim verified completion.';
  return `Business procedure ${procedure.id}@${procedure.version}: ${procedure.instructions}\nAllowed requirementId values for ${procedure.id}: ${procedure.requirements.map(requirement => requirement.id).join(', ')}\nRequired outcome coverage (one or more target-bound checks per requirementId): ${JSON.stringify(procedure.requirements)}`;
}
