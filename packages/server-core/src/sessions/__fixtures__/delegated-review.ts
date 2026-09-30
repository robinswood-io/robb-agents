import type { Message } from '@craft-agent/core/types'
import type { ActiveSessionObjective } from '@craft-agent/shared/sessions'
import { READ_ONLY_GIT_HARDENING_ARGS } from '@craft-agent/shared/agent/bash-validator'
import { transitionObjectiveContract } from '../objective-contract'

/** A persisted legacy reviewer, followed by a real-shaped read receipt. */
export function delegatedReviewFixture(userMessageId: string) {
  const revision = '1234567' + 'a'.repeat(33)
  const binding = { objectiveId: 'parent-objective', acceptanceSha256: 'a'.repeat(64) }
  const criteria = ['requested-outcome-delivered', 'relevant-checks-passed', 'no-safe-work-remaining']
  const template = { verdict: 'PASS|FAIL', criteria: criteria.map(id => ({ id, passed: false })), findings: [], ...binding }
  const safeGit = `git ${READ_ONLY_GIT_HARDENING_ARGS.join(' ')}`
  const reviewGit = `${safeGit} -C /srv/review-lifecycle`
  const scope = `Agis comme contre-relecteur indépendant en lecture seule. Audit du worktree /srv/review-lifecycle, commit ${revision}. Ne modifie rien. Retourne uniquement ce reçu JSON : ${JSON.stringify(template)}.`
  const objective: ActiveSessionObjective = {
    ...transitionObjectiveContract({ messageId: userMessageId, text: scope, nowMs: 1 }),
    requiresExecutionEvidence: true, evidenceRequirement: 'authoritative-sources-before-mutation', risk: 'high-stakes',
    budgetBaselineUsd: 12, tokenBaseline: 300, acceptanceRegisteredAt: 10,
    acceptanceCriteria: [{ id: 'observed-version', description: 'Read the audited version.', toolName: 'Bash',
      input: { command: `${reviewGit} rev-parse HEAD` }, checks: [{ path: '$text', equals: revision }] }],
  }
  const observation: Message = { id: 'review-observation', role: 'tool', content: '', timestamp: 20,
    toolName: 'Bash', toolUseId: 'review-read-call', toolStatus: 'completed', toolExecuted: true,
    toolInput: { command: `${reviewGit} rev-parse HEAD` }, toolResult: revision + '\n' }
  const finalText = JSON.stringify({ verdict: 'FAIL', criteria: criteria.map(id => ({ id, passed: false })),
    findings: ['Il reste à corriger le défaut observé dans la cible auditée.'], ...binding })
  return { scope, objective, observation, finalText }
}
