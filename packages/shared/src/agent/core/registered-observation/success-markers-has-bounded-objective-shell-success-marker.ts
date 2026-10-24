import { validateBashCommand } from "../../bash-validator.ts";
import { isProvablyReadOnlyShellCommand, isRegisteredShellObservation } from './git-observations.ts';
import { isBoundedRegisteredInspection } from './operational-inspection.ts';
import { OBJECTIVE_TEST_SHELL_PATTERNS } from './shell-vocabulary.ts';
import { hasLiteralSuccessMarker, serializeLiteralCommand } from './success-markers.ts';

/** True only when a shell evidence command ends in a literal bounded marker
 * that can run solely after every preceding observation succeeds. */
export function hasBoundedObjectiveShellSuccessMarker(command: string): boolean {
  return hasLiteralSuccessMarker(command, invocation => {
    const literal = serializeLiteralCommand(invocation);
    return isProvablyReadOnlyShellCommand(literal)
      || (isRegisteredShellObservation(literal) && !isBoundedRegisteredInspection(invocation))
      || validateBashCommand(literal, OBJECTIVE_TEST_SHELL_PATTERNS).allowed;
  });
}
