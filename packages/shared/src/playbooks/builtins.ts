import type { LoadedPlaybook } from './types.ts'

function builtin(manifest: LoadedPlaybook['manifest'], instructions: string): LoadedPlaybook {
  return { manifest, instructions, path: `builtin:${manifest.slug}` }
}

export const BUILTIN_PLAYBOOKS: LoadedPlaybook[] = [
  builtin({
    version: 1, slug: 'source-api-diagnostic', name: 'Source & API diagnostic',
    description: 'Resolve an unavailable source before escalating to a human.',
    allowedTools: ['browser_tool', 'source_test'],
    humanGates: ['oauth_or_mfa', 'credential_required'],
    proofs: [{ id: 'final-status', description: 'Record the final user-visible outcome and evidence.', required: true }],
  }, 'Identify the exact source and target first. Diagnose the first failure, use the integrated browser as the safe fallback when appropriate, and escalate only a classified human-only blocker.'),
  builtin({
    version: 1, slug: 'website-form-control', name: 'Website & form control',
    description: 'Verify a public page and its end-to-end form journey.',
    allowedTools: ['browser_tool'],
    humanGates: ['external_authorization_required'],
    proofs: [{ id: 'public-url', description: 'Capture the final public URL result.', required: true }, { id: 'form-result', description: 'Capture the submitted form outcome.', required: true }],
  }, 'Open the final public URL in the browser. Inspect console and network, complete the intended journey, and report only observed end-user evidence.'),
  builtin({
    version: 1, slug: 'inbound-lead-qualification', name: 'Inbound lead qualification',
    description: 'Build an internal ICP, mandate and budget evidence profile before outreach.',
    allowedTools: ['browser_tool', 'search_all'],
    humanGates: ['business_decision_required', 'external_authorization_required'],
    proofs: [{ id: 'profile', description: 'Record contact, company, mandate and budget evidence.', required: true }, { id: 'recommendation', description: 'Record the internal qualification recommendation.', required: true }],
  }, 'Do not infer commercial seriousness. Build a factual internal profile, compare it to the paid ICP, and request a business decision only when evidence is insufficient.'),
  builtin({
    version: 1, procedure: 'document-package', slug: 'client-delivery-preflight', name: 'Client delivery preflight',
    description: 'Verify a client deliverable, its definitive attachment and final link before sending.',
    allowedTools: ['browser_tool'],
    humanGates: ['external_authorization_required'],
    proofs: [{ id: 'artifact', description: 'Verify the definitive client-facing artifact.', required: true }, { id: 'delivery', description: 'Verify recipient, attachment count and final link.', required: true }],
  }, 'Verify the exact artifact as the recipient sees it. Inventory all controlling sources and nested attachments. Reconcile every expected item with the definitive package, render and inspect its readability, and verify recipient access. If sending is authorized and requested, select the document-delivery playbook for the full delivery contract; preflight alone does not authorize sending.'),
  builtin({
    version: 1, slug: 'document-classification', name: 'Document classification',
    description: 'Classify documents into the approved workspace taxonomy with evidence.',
    allowedTools: ['search_drive'],
    humanGates: ['business_decision_required'],
    proofs: [{ id: 'routing', description: 'Record the recommended taxonomy route and rationale.', required: true }],
  }, 'Read the authoritative taxonomy, identify the exact document metadata, and classify conservatively. Escalate only an unresolved business classification decision.'),
  builtin({
    version: 1, procedure: 'document-delivery', slug: 'complete-document-delivery', name: 'Complete document delivery',
    description: 'Deliver an inventoried, readable package with evidence of completeness and authorized delivery.',
    allowedTools: ['Read', 'browser_tool', 'set_completion_criteria'],
    humanGates: ['external_authorization_required', 'credential_required'],
    proofs: [{ id: 'source-inventory', description: 'Controlling source inventory and explicit omissions.', required: true }, { id: 'content-completeness', description: 'Reconciliation against the exact attachment.', required: true }, { id: 'recipient-usability', description: 'Opened, rendered package and accessible recipient links.', required: true }, { id: 'delivery-receipt', description: 'Authorized recipient and definitive version actually delivered.', required: true }],
  }, 'Verify subject, dates, audience, exclusions and exact sources. Inventory, reconcile, render and inspect before an authorized send. Reuse existing valid delivery evidence and never resend merely to fix a receipt. Tools and this playbook confer no permissions.'),
  builtin({
    version: 1, procedure: 'campaign-preparation', slug: 'evidence-based-campaign', name: 'Evidence-based campaign preparation',
    description: 'Prepare relevant targets and messages with explicit coverage and measurement.',
    allowedTools: ['browser_tool', 'Read', 'set_completion_criteria'],
    proofs: [{ id: 'coverage', description: 'Coverage denominator, segments, exclusions and deduplicated target relevance.', required: true }, { id: 'message-quality', description: 'Observed artifact respects audience, dates and call to action.', required: true }, { id: 'measurement', description: 'Observable outcome, attribution and time horizon.', required: true }],
  }, 'Define the audience and denominator before choosing a contact count. Validate current relevance and usable contact channels, compare approaches, inspect the final messages and define how results will be measured. Preparation authorizes no outreach; future commercial performance is not an observed result.'),
  builtin({
    version: 1, procedure: 'software-change', slug: 'verified-software-change', name: 'Verified software change',
    description: 'Change the exact target and verify regressions and the real user interaction.',
    allowedTools: ['Read', 'Bash', 'browser_tool', 'set_completion_criteria'],
    proofs: [{ id: 'revision', description: 'Exact target and changed revision.', required: true }, { id: 'checks', description: 'Relevant regression results and measured user journey.', required: true }],
  }, 'Reproduce the concrete failure, identify the target and revision, preserve existing work, implement and check the requested behavior. Inspect the final interaction with expected access conditions; measure requested latency. A local change does not authorize production deployment.'),
  builtin({
    version: 1, procedure: 'software-deployment', slug: 'verified-software-deployment', name: 'Verified software deployment',
    description: 'Verify an authorized deployment against its running revision and real user access.',
    allowedTools: ['Read', 'Bash', 'browser_tool', 'set_completion_criteria'],
    humanGates: ['external_authorization_required', 'credential_required'],
    proofs: [{ id: 'revision', description: 'Authorized candidate matches the running build.', required: true }, { id: 'journey', description: 'User access, runtime health and final interaction are observed.', required: true }],
  }, 'Resolve the precise authorized target and rollback requirements. Verify the candidate, perform only authorized deployment steps, then verify running revision, authentication, network access and real behavior. CI green alone is insufficient. Do not alter infrastructure or restart unrelated services.'),
]

export function getBuiltinPlaybook(slug: string): LoadedPlaybook | null {
  return BUILTIN_PLAYBOOKS.find(playbook => playbook.manifest.slug === slug) ?? null
}
