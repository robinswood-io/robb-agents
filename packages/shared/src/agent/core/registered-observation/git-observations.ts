/// <reference path="../../bash-parser.d.ts" />
import bashParser from "bash-parser";
import { isAllowlistedReadOnlyGitArguments, READ_ONLY_GIT_HARDENING_ARGS, validateBashCommand } from "../../bash-validator.ts";
import { isBoundedRegisteredInspection, isRemoteValidation, isSingleHttpRead, isValidationScript } from './operational-inspection.ts';
import { OBJECTIVE_READ_ONLY_SHELL_PATTERNS, OBJECTIVE_TEST_SHELL_PATTERNS, isTrustedCurlExecutable, literalCommand } from './shell-vocabulary.ts';
import { hasLiteralSuccessMarker, isBoundedNodeTestCommand, serializeLiteralCommand } from './success-markers.ts';

/**
 * Conservative shell-state classifier for evidence chronology. This is not a
 * permission grant: it only decides whether a completed command can safely
 * leave an older target observation current.
 */
export function isProvablyReadOnlyShellCommand(command: string): boolean {
  return validateBashCommand(command, OBJECTIVE_READ_ONLY_SHELL_PATTERNS).allowed
    && objectiveGitReadsUseAllowlistedOptions(command);
}

function objectiveGitReadsUseAllowlistedOptions(command: string): boolean {
  let ast: unknown;
  try { ast = bashParser(command); } catch { return false; }
  let safe = true;
  const visit = (value: unknown): void => {
    if (!safe || !value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const node = value as Record<string, unknown>;
    if (node.type === 'Command') {
      const invocation = literalCommand(node, true);
      if (invocation?.name === 'git' && !isAllowlistedReadOnlyGitArguments(invocation.args)) {
        safe = false;
        return;
      }
    }
    Object.values(node).forEach(visit);
  };
  visit(ast);
  return safe;
}

export function isHardenableGitRead(invocation: { name: string; args: string[] }): boolean {
  if (invocation.name !== 'git') return false;
  const args = [...invocation.args];
  const scopedCwd: string[] = [];
  if (args[0] === '-C' && args[1]) scopedCwd.push(...args.splice(0, 2));
  return isAllowlistedReadOnlyGitArguments([
    ...READ_ONLY_GIT_HARDENING_ARGS,
    ...scopedCwd,
    ...args,
  ]);
}

export function isUnsupportedGitObservationCandidate(invocation: { name: string; args: string[] }): boolean {
  if (invocation.name !== 'git') return false;
  const args = [...invocation.args];
  if (args[0] === '-C' && args[1]) args.splice(0, 2);
  // These familiar observation subcommands are deliberately not allowlisted:
  // status/diff/show and patch/stat log can invoke repository filters. Still
  // classify their plain form as recoverable so the refusal can direct the
  // agent to target-bound Read/rg/cmp or a supported metadata Git probe.
  if (['status', 'diff', 'show'].includes(args[0] ?? '')) return true;
  if (args[0] === 'log' && args.some(argument => /^(?:-p|--patch|--stat|--numstat|--shortstat|--name-only|--name-status|--raw)$/.test(argument))) {
    return true;
  }
  return false;
}

export function isRecoverablePlainGitStatus(invocation: { name: string; args: string[] }): boolean {
  if (invocation.name !== 'git') return false;
  const args = [...invocation.args];
  if (args[0] === '-C' && args[1] && !args[1].startsWith('-')) args.splice(0, 2);
  if (args.shift() !== 'status') return false;
  return args.every(argument => /^(?:--short|--branch|--porcelain(?:=v[12])?|--untracked-files(?:=(?:no|normal|all))?|--ignored(?:=(?:traditional|matching|no))?|--ahead-behind|--no-ahead-behind|-s|-b|-u(?:no|normal|all)?)$/.test(argument));
}

/**
 * Additional shell observations usable only after an exact registered check
 * matched this invocation, target, output and chronology. This grants no tool
 * permission and is deliberately narrower than arbitrary shell execution.
 */
export function isRegisteredShellObservation(command: string): boolean {
  let ast: { commands?: Array<Record<string, unknown>> };
  try { ast = bashParser(command) as typeof ast; } catch { return false; }
  if (ast.commands?.length !== 1) return false;
  const node = ast.commands[0]!;
  if (node.async) return false;
  if (node.type === 'LogicalExpression') {
    if (node.op !== 'and') return false;
    const validator = literalCommand(node.left, true);
    const marker = literalCommand(node.right, false);
    // This marker can run only if the actual validator exited successfully.
    // It is not a substitute for the registered target/result/chronology
    // checks, and printf alone never proves an observation.
    return !!validator && isValidationScript(validator)
      && marker?.name === 'printf' && marker.args.length === 1
      && marker.args[0]!.length > 0 && marker.args[0]!.length <= 1024
      && !marker.args[0]!.includes('%');
  }
  const invocation = literalCommand(node, true);
  if (!invocation) return false;
  if (invocation.name === 'ssh' || invocation.name === '/usr/bin/ssh') {
    return command.length <= 8192 && isRemoteValidation(invocation.args);
  }
  if (isBoundedRegisteredInspection(invocation)) return true;
  return isTrustedCurlExecutable(invocation.name)
    ? isSingleHttpRead(invocation.args) : isValidationScript(invocation);
}

/**
 * Registered observations whose command grammar itself proves that they do
 * not mutate state. This deliberately excludes opaque validation scripts and
 * remote SSH validators: registration binds their target and expected result,
 * but a friendly executable name cannot prove their implementation is read
 * only.
 */
export function isReadOnlyRegisteredShellObservation(command: string): boolean {
  if (!command || command.length > 32_000) return false;
  let ast: { commands?: Array<Record<string, unknown>> };
  try { ast = bashParser(command) as typeof ast; } catch { return false; }
  if (ast.commands?.length !== 1) return false;
  const node = ast.commands[0]!;
  if (node.async || node.type !== 'Command') return false;
  const invocation = literalCommand(node, true);
  if (!invocation) return false;
  return isBoundedRegisteredInspection(invocation)
    || (isTrustedCurlExecutable(invocation.name) && isSingleHttpRead(invocation.args));
}

/**
 * Complete closed grammar for a Bash invocation that may back an objective
 * acceptance criterion. Registration and final outcome validation must both
 * use this function: accepting a command at only one of those boundaries
 * creates an immutable criterion that can never complete.
 *
 * Inline interpreter/eval/stdin programs and output-only commands are
 * deliberately absent. A named validation script can be repaired in place
 * while retaining the immutable command/target identity.
 */
export function isObjectiveShellEvidenceCommand(command: string): boolean {
  if (!command || command.length > 32_000) return false;
  if (isObjectiveShellObservationCommand(command)
    || isRegisteredShellObservation(command)) return true;

  return hasLiteralSuccessMarker(command, invocation => {
    const literal = serializeLiteralCommand(invocation);
    return isProvablyReadOnlyShellCommand(literal)
      // Target-bound operational inspections must stay standalone. A shell
      // sequence would no longer be the exact registered invocation.
      || (isRegisteredShellObservation(literal) && !isBoundedRegisteredInspection(invocation))
      || validateBashCommand(literal, OBJECTIVE_TEST_SHELL_PATTERNS).allowed;
  });
}

/**
 * Generic shell check evidence that does not rely on a registered exact
 * target/result contract. Opaque named validators and HTTP reads intentionally
 * stay in isObjectiveShellEvidenceCommand's registered-only extension.
 */
export function isObjectiveShellObservationCommand(command: string): boolean {
  if (!command || command.length > 32_000) return false;
  if (isBoundedNodeTestCommand(command)) return true;
  let standalone: { commands?: Array<Record<string, unknown>> };
  try { standalone = bashParser(command) as typeof standalone; } catch { return false; }
  if (standalone.commands?.length === 1) {
    const outputOnly = literalCommand(standalone.commands[0], false);
    if (outputOnly?.name === 'printf') return false;
  }
  if (isProvablyReadOnlyShellCommand(command)
    || validateBashCommand(command, OBJECTIVE_TEST_SHELL_PATTERNS).allowed) return true;
  return hasLiteralSuccessMarker(command, invocation => {
    const literal = serializeLiteralCommand(invocation);
    return isProvablyReadOnlyShellCommand(literal)
      || validateBashCommand(literal, OBJECTIVE_TEST_SHELL_PATTERNS).allowed;
  });
}
