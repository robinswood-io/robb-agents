
export const NAVIGATION_COMMANDS = new Set([
  'navigate',
  'click',
  'back',
  'forward',
]);

function decodeEscapes(input: string): string {
  return input.replace(/\\(.)/g, (_match, ch: string) => {
    if (ch === 'n') return '\n';
    if (ch === 't') return '\t';
    if (ch === 'r') return '\r';
    if (ch === '"') return '"';
    if (ch === "'") return "'";
    if (ch === '\\') return '\\';
    return `\\${ch}`;
  });
}

export function splitBatchCommands(input: string): string[] {
  const commands: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]!;

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (ch === '\\') {
      current += ch;
      escaped = true;
      continue;
    }

    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      current += ch;
      continue;
    }

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      current += ch;
      continue;
    }

    if (ch === ';' && !inSingle && !inDouble) {
      const trimmed = current.trim();
      if (trimmed.length > 0) commands.push(trimmed);
      current = '';
      continue;
    }

    current += ch;
  }

  if (escaped) {
    current += '\\';
  }

  if (inSingle || inDouble) {
    throw new Error('Parse error: unclosed quote in browser_tool command.');
  }

  const trimmed = current.trim();
  if (trimmed.length > 0) commands.push(trimmed);
  return commands;
}

export function tokenizeCommand(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let tokenStarted = false;
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  const pushCurrent = () => {
    if (!tokenStarted) return;
    tokens.push(decodeEscapes(current));
    current = '';
    tokenStarted = false;
  };

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]!;

    if (escaped) {
      current += `\\${ch}`;
      tokenStarted = true;
      escaped = false;
      continue;
    }

    if (ch === '\\') {
      escaped = true;
      continue;
    }

    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      tokenStarted = true;
      continue;
    }

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      tokenStarted = true;
      continue;
    }

    if (!inSingle && !inDouble && /\s/.test(ch)) {
      pushCurrent();
      continue;
    }

    current += ch;
    tokenStarted = true;
  }

  if (escaped) {
    current += '\\';
    tokenStarted = true;
  }

  if (inSingle || inDouble) {
    throw new Error('Parse error: unclosed quote in browser_tool command.');
  }

  pushCurrent();
  return tokens;
}

/** Uses exactly the executor's tokenization; quoted/array text is never an action. */
export function containsBrowserKeyboardText(command: unknown): boolean {
  if (Array.isArray(command)) return typeof command[0] === 'string' && command[0].toLowerCase() === 'type-keys';
  if (typeof command !== 'string') return false;
  try {
    return splitBatchCommands(command.trim()).some(part => tokenizeCommand(part)[0]?.toLowerCase() === 'type-keys');
  } catch {
    return false; // Malformed commands are rejected by the same parser before execution.
  }
}

const OBSERVATIONAL_BROWSER_COMMANDS = new Set([
  '--help',
  '-h',
  'help',
  'open',
  'navigate',
  'snapshot',
  'find',
  'screenshot',
  'screenshot-region',
  'console',
  'network',
  'wait',
  'resume',
  'get-clipboard',
  'downloads',
  'scroll',
  'back',
  'forward',
  'focus',
  'windows',
  'release',
  'close',
  'hide',
  'window-resize',
]);

function hasObservationalNavigationTarget(parts: string[]): boolean {
  const rawTarget = parts.slice(1).join(' ').trim();
  if (!rawTarget) return false;

  // BrowserPaneManager turns ordinary host names and free text into HTTPS
  // navigation/searches. Explicit schemes are narrower here so a future
  // runtime cannot turn `navigate javascript://...` into an evaluate bypass.
  const explicitScheme = rawTarget.match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLowerCase();
  if (!explicitScheme) return true;
  if (explicitScheme === 'http' || explicitScheme === 'https') return true;
  return explicitScheme === 'about' && rawTarget.toLowerCase() === 'about:blank';
}

export function isObservationalBrowserCommandParts(parts: string[]): boolean {
  const commandName = parts[0]?.toLowerCase();
  if (!commandName || !OBSERVATIONAL_BROWSER_COMMANDS.has(commandName)) return false;

  if (commandName === 'navigate') return hasObservationalNavigationTarget(parts);
  if (commandName === 'downloads') {
    const action = parts[1]?.toLowerCase();
    return action === undefined || action === 'list' || action === 'wait';
  }
  if (commandName === 'wait') {
    const kind = parts[1]?.toLowerCase();
    return kind === 'selector' || kind === 'text' || kind === 'url' || kind === 'network-idle';
  }
  return true;
}

/**
 * Closed authority classifier for browser_tool input.
 *
 * This deliberately shares the executor's batch splitting and tokenization so
 * quoted values, array mode, and semicolon batches cannot disguise a mutating
 * command. Unknown or malformed commands fail closed. Long waits remain
 * bounded by the browser runtime's shared five-minute ceiling.
 */
export function isObservationalBrowserCommand(command: unknown): boolean {
  let commands: string[][];
  try {
    if (Array.isArray(command)) {
      if (command.length === 0 || !command.every((part): part is string => typeof part === 'string')) {
        return false;
      }
      commands = [command];
    } else if (typeof command === 'string') {
      commands = splitBatchCommands(command.trim()).map(tokenizeCommand);
    } else {
      return false;
    }
  } catch {
    return false;
  }

  return commands.length > 0 && commands.every(isObservationalBrowserCommandParts);
}
