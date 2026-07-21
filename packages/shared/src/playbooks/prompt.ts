import type { LoadedPlaybook } from './types.ts'

/** Build a non-authoritative execution contract injected alongside the user goal. */
export function formatPlaybookPrompt(playbook: LoadedPlaybook): string {
  const proofs = playbook.manifest.proofs
    .map(proof => `- ${proof.required ? '[required]' : '[optional]'} ${proof.id}: ${proof.description}`)
    .join('\n')
  const gates = playbook.manifest.humanGates?.length
    ? playbook.manifest.humanGates.join(', ')
    : 'none'

  return `<robb_playbook slug="${playbook.manifest.slug}" version="1">
${playbook.instructions}

Allowed tools: ${playbook.manifest.allowedTools.join(', ')}
Human-only gates: ${gates}
Required proof:
${proofs}

Do not assume capabilities outside this playbook. Complete all available autonomous steps, record concrete evidence, and escalate only a listed human-only gate.
</robb_playbook>`
}
