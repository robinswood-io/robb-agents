import { completionCriterionPathKeys as pathKeys } from "@craft-agent/session-tools-core";
import type { ObjectiveAcceptanceCriterion } from "@craft-agent/core/types";
import { isObjectiveShellExecutorToolName, isObjectiveShellEvidenceCommand, isProvablyReadOnlyShellCommand, isReadOnlyRegisteredShellObservation, objectiveShellExitZeroProvesSuccess } from "@craft-agent/shared/agent";
import { DISTINCT_OPAQUE_TARGET_KEY_PATTERN, canonicalToolName, criterionTargetIdentities, selectorIdentity } from './criterion-identities.ts';

function criterionShellCommand(criterion: ObjectiveAcceptanceCriterion): string | undefined {
  const commands: string[] = [];
  for (const path of Object.keys(criterion.input)) {
    const keys = pathKeys(path);
    if (keys?.length !== 1 || typeof keys[0] !== 'string'
      || !/^(?:command|cmd|script)$/.test(keys[0])) continue;
    const descriptor = Object.getOwnPropertyDescriptor(criterion.input, path);
    if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'string') return undefined;
    commands.push(descriptor.value);
  }
  return commands.length === 1 ? commands[0] : undefined;
}

export function assertAdmissibleShellCriteria(criteria: readonly ObjectiveAcceptanceCriterion[]): void {
  for (const criterion of criteria) {
    if (!isObjectiveShellExecutorToolName(criterion.toolName)) continue;
    const command = criterionShellCommand(criterion);
    if (command && isObjectiveShellEvidenceCommand(command)) continue;
    throw new Error(`Criterion ${criterion.id} uses a shell-executor command that cannot serve as host-observed acceptance evidence. Use a read-only inspection, a named validate/verify/check/test script, a test/check command, or curl GET/HEAD. Inline interpreter/eval/stdin programs, output-only commands and mutating commands are not accepted. Nothing was registered.`);
  }

  for (const criterion of criteria) {
    if (!isObjectiveShellExecutorToolName(criterion.toolName)
      || !criterion.checks.some(check => {
        const keys = pathKeys(check.path);
        return keys?.length === 1 && (keys[0] === 'stdout' || keys[0] === 'stderr');
      })) continue;
    throw new Error(`Criterion ${criterion.id} binds stdout/stderr, but shell output is not a structured result field. Use $text for exact whole-output equality or $.transport.code for successful execution. Nothing was registered.`);
  }

  for (const criterion of criteria) {
    if (!isObjectiveShellExecutorToolName(criterion.toolName)) continue;
    const command = criterionShellCommand(criterion);
    for (const check of criterion.checks) {
      const keys = pathKeys(check.path);
      if (keys?.[0] !== 'transport') continue;
      const codeIsValid = keys.length === 2 && keys[1] === 'code' && check.equals === 0;
      const successIsValid = keys.length === 2 && keys[1] === 'success' && check.equals === true
        && !!command && objectiveShellExitZeroProvesSuccess(command);
      if (codeIsValid || successIsValid) continue;
      throw new Error(`Criterion ${criterion.id} uses an unsupported shell transport predicate. Use exactly $.transport.code == 0, or $.transport.success == true only for a command whose zero exit proves success (for example curl --fail). Nothing was registered.`);
    }
  }
}

export function criterionInvocationIdentity(criterion: ObjectiveAcceptanceCriterion): string {
  const input = Object.entries(criterion.input)
    .map(([path, value]) => [selectorIdentity(path), value] as [string, unknown])
    .sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify([canonicalToolName(criterion.toolName), input]);
}

function shellCriterionMayAffect(
  executing: ObjectiveAcceptanceCriterion,
  target: ObjectiveAcceptanceCriterion,
): boolean {
  const expected = criterionTargetIdentities(target);
  const actual = criterionTargetIdentities(executing);
  const sharedKeys = [...expected.keys()].filter(key => actual.has(key));
  const opaqueKeys = sharedKeys.filter(key => DISTINCT_OPAQUE_TARGET_KEY_PATTERN.test(key));
  if (opaqueKeys.some(key => [...expected.get(key)!].some(value => actual.get(key)!.has(value)))) return true;
  if (opaqueKeys.length > 0) return false;
  return true;
}

/**
 * Two distinct opaque validators may each mutate the state observed by the
 * other. Their immutable criteria then form a chronology cycle: whichever one
 * runs last invalidates an earlier sibling. Reject only newly introduced
 * cycles and direct the caller toward one consolidated receipt or bounded
 * reads; historical contracts remain readable and retryable.
 */
export function assertSatisfiableShellCriteria(
  criteria: readonly ObjectiveAcceptanceCriterion[],
  additionIds: ReadonlySet<string>,
): void {
  const groups = new Map<string, ObjectiveAcceptanceCriterion[]>();
  for (const criterion of criteria) {
    if (!isObjectiveShellExecutorToolName(criterion.toolName)) continue;
    const command = criterionShellCommand(criterion);
    if (!command || isProvablyReadOnlyShellCommand(command)
      || isReadOnlyRegisteredShellObservation(command)) continue;
    const identity = criterionInvocationIdentity(criterion);
    const group = groups.get(identity) ?? [];
    group.push(criterion);
    groups.set(identity, group);
  }
  if (groups.size < 2) return;

  const entries = [...groups.entries()];
  const edges = new Map(entries.map(([identity]) => [identity, new Set<string>()]));
  for (const [sourceIdentity, source] of entries) {
    for (const [targetIdentity, target] of entries) {
      if (sourceIdentity !== targetIdentity && shellCriterionMayAffect(source[0]!, target[0]!)) {
        edges.get(sourceIdentity)!.add(targetIdentity);
      }
    }
  }
  const reaches = (from: string, target: string, visited = new Set<string>()): boolean => {
    if (!visited.add(from)) return false;
    for (const next of edges.get(from) ?? []) {
      if (next === target || reaches(next, target, visited)) return true;
    }
    return false;
  };
  const cyclicAddition = entries.find(([identity, group]) => (
    group.some(criterion => additionIds.has(criterion.id))
    && [...(edges.get(identity) ?? [])].some(next => reaches(next, identity))
  ));
  if (!cyclicAddition) return;
  const ids = cyclicAddition[1].map(criterion => criterion.id).join(', ');
  throw new Error(`Opaque shell acceptance criteria cannot be satisfied across distinct invocations (including: ${ids}) because their observations may invalidate each other. Consolidate them into one read-only invocation that returns all required fields, or use separate bounded reads such as curl GET/HEAD, docker inspect/ps, systemctl is-active, or gh pr view. Nothing was registered.`);
}
