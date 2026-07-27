export interface CompactCommand {
  customInstructions?: string;
}

/** Parse Pi's /compact command without applying a backtracking expression. */
export function parseCompactCommand(message: string): CompactCommand | null {
  const command = '/compact';
  if (message.slice(0, command.length).toLowerCase() !== command) return null;
  if (message.length === command.length) return {};

  const separator = message[command.length];
  if (separator === undefined || separator.trim() !== '') return null;

  const customInstructions = message.slice(command.length).trim();
  return customInstructions ? { customInstructions } : {};
}
