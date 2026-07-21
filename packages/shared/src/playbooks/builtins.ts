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
    version: 1, slug: 'client-delivery-preflight', name: 'Client delivery preflight',
    description: 'Verify a client deliverable, its definitive attachment and final link before sending.',
    allowedTools: ['browser_tool'],
    humanGates: ['external_authorization_required'],
    proofs: [{ id: 'artifact', description: 'Verify the definitive client-facing artifact.', required: true }, { id: 'delivery', description: 'Verify recipient, attachment count and final link.', required: true }],
  }, 'Verify the exact artifact as the recipient sees it. Use one definitive attachment, inspect recipients and filenames, and do not send until all preflight evidence is present.'),
  builtin({
    version: 1, slug: 'document-classification', name: 'Document classification',
    description: 'Classify documents into the approved workspace taxonomy with evidence.',
    allowedTools: ['search_drive'],
    humanGates: ['business_decision_required'],
    proofs: [{ id: 'routing', description: 'Record the recommended taxonomy route and rationale.', required: true }],
  }, 'Read the authoritative taxonomy, identify the exact document metadata, and classify conservatively. Escalate only an unresolved business classification decision.'),
]

export function getBuiltinPlaybook(slug: string): LoadedPlaybook | null {
  return BUILTIN_PLAYBOOKS.find(playbook => playbook.manifest.slug === slug) ?? null
}
