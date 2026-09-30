const forbiddenKeys = new Set(['__proto__', 'prototype', 'constructor']);

/** Only property names and nonnegative indexes; never JSONPath expressions. */
export function completionCriterionPathKeys(path: string): string[] | undefined {
  if (typeof path !== 'string' || !path || path.length > 256) return undefined;
  let cursor = 0;
  const keys: string[] = [];
  if (path[0] === '$') {
    cursor = 1;
    if (cursor === path.length) return keys;
    if (path[cursor] === '.') cursor += 1;
    else if (path[cursor] !== '[') return undefined;
  }
  let requireProperty = path[cursor - 1] === '.';
  while (cursor < path.length) {
    const match = !requireProperty && path[cursor] === '['
      ? /^\[(0|[1-9]\d*)\]/.exec(path.slice(cursor))
      : /^([A-Za-z_][A-Za-z0-9_-]*|0|[1-9]\d*)/.exec(path.slice(cursor));
    if (!match || forbiddenKeys.has(match[1]!)) return undefined;
    keys.push(match[1]!);
    cursor += match[0].length;
    if (cursor === path.length) return keys;
    requireProperty = path[cursor] === '.';
    if (requireProperty) cursor += 1;
    else if (path[cursor] !== '[') return undefined;
  }
  return undefined; // Trailing dot or empty property.
}

