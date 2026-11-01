/// <reference path="../bash-parser.d.ts" />

// ============================================================
// Types
// ============================================================

/**
 * Result of validating a bash command AST.
 * Tracks which subcommands passed/failed for detailed error messages.
 */
export interface BashValidationResult {
  allowed: boolean;
  /** Primary reason for rejection (if not allowed) */
  reason?: BashValidationReason;
  /** Individual results for compound commands */
  subcommandResults?: SubcommandResult[];
}

export interface SubcommandResult {
  /** The command text that was validated */
  command: string;
  allowed: boolean;
  reason?: string;
}

/**
 * Detailed reason why validation failed.
 * Used to generate helpful error messages.
 */
export type BashValidationReason =
  | { type: 'pipeline'; explanation: string }
  | { type: 'redirect'; op: string; explanation: string }
  | { type: 'command_expansion'; explanation: string }
  | { type: 'process_substitution'; explanation: string }
  | { type: 'parameter_expansion'; explanation: string }
  | { type: 'env_assignment'; explanation: string }
  | { type: 'unsafe_command'; command: string; explanation: string }
  | { type: 'parse_error'; error: string }
  | { type: 'compound_partial_fail'; failedCommands: string[]; passedCommands: string[] }
  | { type: 'background_execution'; explanation: string };

// ============================================================
// AST Node Types (from bash-parser)
// ============================================================

export interface ASTNode {
  type: string;
}

export interface WordNode extends ASTNode {
  type: 'Word';
  text: string;
  expansion?: ExpansionNode[];
}

export interface CommandNode extends ASTNode {
  type: 'Command';
  name?: WordNode;
  prefix?: ASTNode[];
  suffix?: ASTNode[];
  /** True if command runs in background with & operator */
  async?: boolean;
}

export interface LogicalExpressionNode extends ASTNode {
  type: 'LogicalExpression';
  op: 'and' | 'or';
  left: ASTNode;
  right: ASTNode;
}

export interface PipelineNode extends ASTNode {
  type: 'Pipeline';
  commands: ASTNode[];
}

export interface SubshellNode extends ASTNode {
  type: 'Subshell';
  list: CompoundListNode;
}

export interface CompoundListNode extends ASTNode {
  type: 'CompoundList';
  commands: ASTNode[];
}

export interface RedirectNode extends ASTNode {
  type: 'Redirect';
  op: { text: string; type: string };
  file: WordNode;
}

interface ExpansionNode {
  type: string;
  command?: string;
  commandAST?: ScriptNode;
}

export interface ScriptNode extends ASTNode {
  type: 'Script';
  commands: ASTNode[];
}
