



export function sqlCodeOutsideQuotes(sql: string): string | undefined {
  let code = '';
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index]!;
    if (char === '"') return undefined;
    if (char !== "'") {
      code += char;
      continue;
    }
    let previous = index - 1;
    while (previous >= 0 && /\s/.test(sql[previous]!)) previous -= 1;
    // PostgreSQL's `type 'literal'` syntax invokes the type input function
    // without parentheses. Only predicate/list literal positions are needed
    // by this inspection grammar; rejecting every other position closes that
    // hidden function-call form.
    if (previous < 0 || !/[=<>!(,]/.test(sql[previous]!)) return undefined;
    const quote = char;
    code += ' ';
    let closed = false;
    while (++index < sql.length) {
      if (sql[index] !== quote) continue;
      if (sql[index + 1] === quote) {
        index += 1;
        continue;
      }
      closed = true;
      break;
    }
    if (!closed) return undefined;
  }
  return code;
}



export function isBoundedSystemctlInspection(args: string[]): boolean {
  const [operation, ...sourceRest] = args;
  const rest = [...sourceRest];
  const literalUnit = (value: string | undefined): value is string => !!value
    && /^[A-Za-z0-9][A-Za-z0-9_.@:-]{0,255}$/.test(value);

  if (operation === 'is-active' || operation === 'is-enabled' || operation === 'is-failed') {
    if (rest[0] === '--quiet') rest.shift();
    return rest.length > 0 && rest.every(literalUnit);
  }

  if (operation !== 'show') return false;
  const units: string[] = [];
  while (rest.length) {
    const arg = rest.shift()!;
    if (arg === '--all' || arg === '--value' || arg === '--no-pager') continue;
    if (arg === '-p' || arg === '--property') {
      if (!/^[A-Za-z][A-Za-z0-9]*(?:,[A-Za-z][A-Za-z0-9]*)*$/.test(rest.shift() ?? '')) return false;
      continue;
    }
    if (arg.startsWith('--property=')) {
      if (!/^[A-Za-z][A-Za-z0-9]*(?:,[A-Za-z][A-Za-z0-9]*)*$/.test(arg.slice('--property='.length))) return false;
      continue;
    }
    if (!literalUnit(arg)) return false;
    units.push(arg);
  }
  return units.length > 0;
}
