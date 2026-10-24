
function isBoundedPostgresInspectionArgs(
  sourceArgs: string[],
  scope: { user: string; database: string },
): boolean {
  const query = extractBoundedPostgresInspectionQuery(sourceArgs, scope);
  return query !== undefined && isBoundedReadOnlyPostgresQuery(query);
}

/** Parse the exact audited psql CLI envelope independently from the SQL
 * grammar. The repair classifier may relax only the query, never executable,
 * identity, duplicate flags, extra payloads or positional arguments. */
function extractBoundedPostgresInspectionQuery(
  sourceArgs: string[],
  scope: { user: string; database: string },
): string | undefined {
  const args = [...sourceArgs];
  const outputOptions = new Set<string>();
  let query: string | undefined;
  let noPsqlRc = false;
  let singleTransaction = false;
  let stopOnError = false;
  let user: string | undefined;
  let database: string | undefined;
  while (args.length) {
    const arg = args.shift()!;
    if (['-A', '-t', '-q', '-x'].includes(arg)) {
      if (outputOptions.has(arg)) return undefined;
      outputOptions.add(arg);
      continue;
    }
    if (arg === '-X') {
      if (noPsqlRc) return undefined;
      noPsqlRc = true;
      continue;
    }
    if (arg === '--single-transaction') {
      if (singleTransaction) return undefined;
      singleTransaction = true;
      continue;
    }
    if (arg === '-c' || arg === '--command') {
      if (query !== undefined || args.length !== 1) return undefined;
      query = args.shift();
      break;
    }
    if (arg.startsWith('--command=')) {
      if (query !== undefined || args.length !== 0) return undefined;
      query = arg.slice('--command='.length);
      break;
    }
    if (arg === '-U') {
      const value = args.shift();
      if (user !== undefined || !isLiteralPostgresIdentifier(value)) return undefined;
      user = value;
      continue;
    }
    if (arg === '-d') {
      const value = args.shift();
      if (database !== undefined || !isLiteralPostgresIdentifier(value)) return undefined;
      database = value;
      continue;
    }
    if (arg === '--set=ON_ERROR_STOP=1') {
      if (stopOnError) return undefined;
      stopOnError = true;
      continue;
    }
    return undefined;
  }
  if (!noPsqlRc || !singleTransaction || !stopOnError
    || user !== scope.user || database !== scope.database
    || query === undefined) return undefined;
  return query;
}

function isLiteralPostgresIdentifier(value: string | undefined): value is string {
  return !!value && /^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(value);
}

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

function isBoundedReadOnlyPostgresQuery(query: string): boolean {
  const trimmed = query.trim();
  if (!trimmed || trimmed.length > 16_384 || /[\u0000\u007f\\"$]/.test(trimmed)
    || /--|\/\*|\*\//.test(trimmed)) return false;
  const code = sqlCodeOutsideQuotes(trimmed);
  if (!code || /[^\x09\x0a\x0d\x20-\x7e]/.test(code)) return false;
  const statements = code.split(';').map(statement => statement.trim()).filter(Boolean);
  if (statements.length !== 3 || !/^set\s+transaction\s+read\s+only$/i.test(statements[0]!)) {
    return false;
  }
  const timeout = /^set\s+local\s+statement_timeout\s*=\s*([1-9]\d*)$/i.exec(statements[1]!);
  if (!timeout || Number(timeout[1]) > 60_000) return false;

  const select = statements[2]!;
  if (!/^select\b/i.test(select)
    || [...select.matchAll(/\bselect\b/gi)].length !== 1
    || /::|:|\b(?:alter|analyze|call|cluster|collate|comment|copy|create|deallocate|delete|do|drop|execute|grant|insert|intersect|listen|lock|merge|notify|offset|operator|prepare|refresh|reindex|reset|revoke|set|truncate|union|unlisten|update|vacuum|values|with)\b/i.test(select)
    || /\binto\b|\bfor\s+(?:update|share|no\s+key\s+update|key\s+share)\b/i.test(select)
    || /\b(?:from|join)\s*\(/i.test(select)) {
    return false;
  }

  // Any identifier immediately followed by an opening parenthesis is either a
  // function call or a syntax extension outside this deliberately small
  // grammar. Standalone parenthesized boolean expressions remain valid.
  if (/\b[A-Za-z_][A-Za-z0-9_$.]*\s*\(/.test(select)) return false;
  const operators = select.match(/[+\-*/<>=~!@#%^&|?]+/g) ?? [];
  if (operators.some(operator => !['=', '<', '>', '<=', '>=', '<>', '!='].includes(operator))) return false;

  const relationKeywords = [...select.matchAll(/\b(?:from|join)\b/gi)];
  const relations = [...select.matchAll(/\b(?:from|join)\s+([A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*)\b/gi)];
  if (relations.length === 0 || relations.length !== relationKeywords.length) return false;

  // Comma joins hide additional relation targets from the FROM/JOIN checks.
  // A comma after the first FROM is therefore rejected, even inside an
  // expression; callers can express such predicates without widening this
  // security boundary.
  const firstFrom = select.search(/\bfrom\b/i);
  if (firstFrom < 0 || select.slice(firstFrom).includes(',')) return false;

  const limit = /\blimit\s+([1-9]\d*)$/i.exec(select);
  if (!limit || Number(limit[1]) > 1_000) return false;
  if ([...select.matchAll(/\blimit\b/gi)].length !== 1) return false;

  for (const relation of relations) {
    const [schema, table] = relation[1]!.split('.');
    if (!isLiteralPostgresIdentifier(schema) || !isLiteralPostgresIdentifier(table)) return false;
  }
  return isAuditedPnsPostgresSelect(select, relations.map(relation => relation[1]!.toLowerCase()));
}

function isAuditedPnsPostgresSelect(select: string, relations: string[]): boolean {
  if (relations.length !== 1) return false;
  const [relation] = relations;
  // These are PostgreSQL-owned catalog views whose definitions and scalar
  // types are part of the reviewed server contract. Arbitrary application
  // views remain rejected even when their name looks read-only.
  if (relation === 'information_schema.columns' || relation === 'information_schema.tables') {
    return true;
  }
  if (relation !== 'public.contracts') return false;

  // The only application-table read currently approved is a numeric primary
  // key existence check. Keeping its selected column, predicate and alias
  // identical prevents RLS/operator/type surprises from a model-authored
  // projection. Broaden only after auditing the concrete PNS schema.
  const normalized = select.replace(/\s+/g, ' ').trim();
  const match = /^select\s+([a-z_][a-z0-9_]*)\.(contract_id|id)\s+from\s+public\.contracts\s+(?:as\s+)?([a-z_][a-z0-9_]*)\s+where\s+([a-z_][a-z0-9_]*)\.(contract_id|id)\s*=\s*[1-9]\d{0,17}\s+limit\s+(?:[1-9]\d{0,2}|1000)$/i.exec(normalized);
  return !!match && match[1]?.toLowerCase() === match[3]?.toLowerCase()
    && match[3]?.toLowerCase() === match[4]?.toLowerCase()
    && match[2]?.toLowerCase() === match[5]?.toLowerCase();
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
