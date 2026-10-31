
const MUTATION_BASH_PATTERN = /(?:^|\s)(?:apply_patch|chmod|chown|cp|install|ln|mkdir|mv|rm|rmdir|sed\s+-i|touch|truncate|deploy|git\s+(?:commit|merge|push)(?![-\w])|systemctl\s+(?:disable|enable|restart|start|stop)|(?:npm|bun|pnpm|yarn)\s+(?:install|publish)|docx-tool|xlsx-tool|pptx-tool|pdf-tool)\b/i;

/** Scan interpreter invocations and mutation verbs once, without rescanning each line. */
export function hasShellMutationCommand(command: string): boolean {
  if (MUTATION_BASH_PATTERN.test(command)) return true;
  const actions = command.matchAll(/(?:build|generate|write|create)\b/gi);
  let action = actions.next();
  let lineEnd = -1;
  for (const invocation of command.matchAll(/(?:^|\s)(?:python\d*|bun|node)\s+/gi)) {
    const start = invocation.index + invocation[0].length;
    while (!action.done && action.value.index < start) action = actions.next();
    if (action.done) return false;
    if (start > lineEnd) {
      const newline = command.indexOf('\n', start);
      lineEnd = newline < 0 ? command.length : newline;
    }
    if (action.value.index < lineEnd) return true;
  }
  return false;
}
