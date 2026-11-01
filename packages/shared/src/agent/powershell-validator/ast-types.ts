
// ============================================================
// Types
// ============================================================

/**
 * Result of validating a PowerShell command AST.
 */
export interface PowerShellValidationResult {
  allowed: boolean;
  /** Primary reason for rejection (if not allowed) */
  reason?: PowerShellValidationReason;
  /** Individual results for compound commands */
  subcommandResults?: SubcommandResult[];
}

export interface SubcommandResult {
  command: string;
  allowed: boolean;
  reason?: string;
}

export type PowerShellValidationReason =
  | { type: 'pipeline'; explanation: string }
  | { type: 'redirect'; target: string; explanation: string }
  | { type: 'subexpression'; explanation: string }
  | { type: 'script_block'; explanation: string }
  | { type: 'invoke_expression'; explanation: string }
  | { type: 'dot_sourcing'; explanation: string }
  | { type: 'unsafe_command'; command: string; explanation: string }
  | { type: 'parse_error'; error: string }
  | { type: 'background_execution'; explanation: string }
  | { type: 'assignment'; explanation: string }
  | { type: 'powershell_unavailable'; explanation: string };

// ============================================================
// AST Node Types (from PowerShell parser output)
// ============================================================

export interface ASTNode {
  Type: string;
  Text: string;
}

export interface ScriptBlockAst extends ASTNode {
  Type: 'ScriptBlockAst';
  BeginBlock?: NamedBlockAst;
  ProcessBlock?: NamedBlockAst;
  EndBlock?: NamedBlockAst;
}

export interface NamedBlockAst extends ASTNode {
  Type: 'NamedBlockAst';
  Statements: ASTNode[];
  Unnamed: boolean;
}

export interface PipelineAst extends ASTNode {
  Type: 'PipelineAst';
  PipelineElements: ASTNode[];
  Background: boolean;
}

export interface CommandAst extends ASTNode {
  Type: 'CommandAst';
  CommandElements: ASTNode[];
  Redirections: ASTNode[];
  InvocationOperator: string;
}

export interface CommandExpressionAst extends ASTNode {
  Type: 'CommandExpressionAst';
  Expression: ASTNode;
}

export interface StringConstantExpressionAst extends ASTNode {
  Type: 'StringConstantExpressionAst';
  Value: string;
  StringConstantType: string;
}

export interface VariableExpressionAst extends ASTNode {
  Type: 'VariableExpressionAst';
  VariablePath: string;
  Splatted: boolean;
}



export interface FileRedirectionAst extends ASTNode {
  Type: 'FileRedirectionAst';
  Location: ASTNode;
  Append: boolean;
  FromStream: string;
}


export interface ExpandableStringExpressionAst extends ASTNode {
  Type: 'ExpandableStringExpressionAst';
  Value: string;
  NestedExpressions: ASTNode[];
}

export interface CommandParameterAst extends ASTNode {
  Type: 'CommandParameterAst';
  ParameterName: string;
  Argument?: ASTNode;
}

export interface InvokeMemberExpressionAst extends ASTNode {
  Type: 'InvokeMemberExpressionAst';
  Expression: ASTNode;
  Member: ASTNode;
  Arguments: ASTNode[];
  Static: boolean;
}

export interface ParseResult {
  success: boolean;
  ast?: ScriptBlockAst;
  parseErrors?: Array<{ Message: string; Text: string; ErrorId: string }>;
  error?: string;
}
