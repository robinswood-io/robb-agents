/** Bash validation: bounded review commands, AST policy and redirects. */
export { READ_ONLY_GIT_HARDENING_ARGS, isAllowlistedReadOnlyGitArguments, inspectReadOnlyReviewCommand, hasShellOutputRedirection } from './bash-validator/read-only-review.ts';
export type { BashValidationResult, SubcommandResult, BashValidationReason } from './bash-validator/ast-types.ts';
export { validateBashCommand } from './bash-validator/ast-policy.ts';
export { hasControlCharacters } from './bash-validator/redirect-policy.ts';
