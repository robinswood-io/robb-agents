import { debug } from "../../utils/debug.ts";
import type { ASTNode, CommandAst, CommandParameterAst, ExpandableStringExpressionAst, NamedBlockAst, PipelineAst, ScriptBlockAst, StringConstantExpressionAst } from './ast-types.ts';
import { unwrapPowerShellCommand } from './command-syntax.ts';
import { isPowerShellAvailable, parseCommand } from './parser-process.ts';

/** Read cmdlets that read files */
const READ_CMDLETS = ['get-content', 'gc', 'type'];

/** Write cmdlets that output to files */
const WRITE_CMDLETS = ['out-file', 'set-content', 'add-content'];

/**
 * Extract file path from PowerShell write commands using AST analysis.
 * Used to check if a write command targets the plans folder.
 *
 * @param command - The PowerShell command string
 * @returns The file path if a write cmdlet is detected, null otherwise
 */
export function extractPowerShellWriteTarget(command: string): string | null {
  if (!isPowerShellAvailable()) return null;

  // If wrapped in powershell.exe -Command "...", unwrap and re-parse the inner command.
  // The PS AST parser would see powershell.exe as the top-level command (not the write cmdlet).
  const innerCommand = unwrapPowerShellCommand(command);
  if (innerCommand) {
    return extractPowerShellWriteTarget(innerCommand);
  }

  const parseResult = parseCommand(command);
  if (!parseResult.success || !parseResult.ast) return null;

  // Find the last command in any pipeline (where write cmdlets typically appear)
  const lastCmd = findLastPipelineCommand(parseResult.ast);
  if (!lastCmd) return null;

  // Check if it's a write cmdlet
  const cmdName = getCommandName(lastCmd);
  if (!cmdName || !WRITE_CMDLETS.includes(cmdName.toLowerCase())) return null;

  // Extract -FilePath or -Path parameter value
  let targetPath = extractParameterValue(lastCmd, ['FilePath', 'Path']);

  // Fallback: check for positional parameter (e.g. Out-File C:\temp\file.txt)
  if (!targetPath) {
    targetPath = extractFirstPositionalArg(lastCmd);
  }

  if (targetPath) {
    debug('[PowerShellValidator] Extracted write target:', targetPath);
  }
  return targetPath;
}

/**
 * Extract file path from PowerShell read commands using AST analysis.
 * Used to detect file reads (Get-Content, gc, type) for prerequisite tracking.
 *
 * Handles complex cases like:
 * - Get-Content -Path "file.txt" -Encoding UTF8
 * - gc file.txt | Select-String "pattern"
 * - powershell.exe -Command "Get-Content file.txt"
 *
 * @param command - The PowerShell command string
 * @returns The file path if a read cmdlet is detected, null otherwise
 */
export function extractPowerShellReadTarget(command: string): string | null {
  if (!isPowerShellAvailable()) return null;

  // If wrapped in powershell.exe -Command "...", unwrap and re-parse the inner command.
  const innerCommand = unwrapPowerShellCommand(command);
  if (innerCommand) {
    return extractPowerShellReadTarget(innerCommand);
  }

  const parseResult = parseCommand(command);
  if (!parseResult.success || !parseResult.ast) return null;

  // Find the first command in any pipeline (where read cmdlets appear as data source)
  const firstCmd = findFirstPipelineCommand(parseResult.ast);
  if (!firstCmd) return null;

  // Check if it's a read cmdlet
  const cmdName = getCommandName(firstCmd);
  if (!cmdName || !READ_CMDLETS.includes(cmdName.toLowerCase())) return null;

  // Extract -Path or -LiteralPath parameter value
  let targetPath = extractParameterValue(firstCmd, ['Path', 'LiteralPath']);

  // Fallback: positional parameter (e.g. Get-Content C:\temp\file.txt)
  if (!targetPath) {
    targetPath = extractFirstPositionalArg(firstCmd);
  }

  return targetPath;
}

/**
 * Find the first CommandAst in a pipeline within the AST.
 * Read cmdlets are typically the data source (first in pipeline).
 */
function findFirstPipelineCommand(ast: ASTNode): CommandAst | null {
  const pipeline = findFirstPipeline(ast);
  if (!pipeline || !pipeline.PipelineElements?.length) return null;

  const firstElement = pipeline.PipelineElements[0];
  if (firstElement?.Type === 'CommandAst') {
    return firstElement as CommandAst;
  }
  return null;
}

/**
 * Find the last CommandAst in a pipeline within the AST.
 */
function findLastPipelineCommand(ast: ASTNode): CommandAst | null {
  // Navigate to the first pipeline
  const pipeline = findFirstPipeline(ast);
  if (!pipeline || !pipeline.PipelineElements?.length) return null;

  // Get the last element in the pipeline
  const lastElement = pipeline.PipelineElements[pipeline.PipelineElements.length - 1];
  if (lastElement?.Type === 'CommandAst') {
    return lastElement as CommandAst;
  }
  return null;
}

/**
 * Recursively find the first PipelineAst in the AST.
 */
function findFirstPipeline(node: ASTNode): PipelineAst | null {
  if (!node) return null;

  if (node.Type === 'PipelineAst') {
    return node as PipelineAst;
  }

  // Check ScriptBlockAst
  if (node.Type === 'ScriptBlockAst') {
    const scriptBlock = node as ScriptBlockAst;
    for (const block of [scriptBlock.EndBlock, scriptBlock.ProcessBlock, scriptBlock.BeginBlock]) {
      if (block) {
        const result = findFirstPipeline(block);
        if (result) return result;
      }
    }
  }

  // Check NamedBlockAst
  if (node.Type === 'NamedBlockAst') {
    const namedBlock = node as NamedBlockAst;
    for (const stmt of namedBlock.Statements || []) {
      const result = findFirstPipeline(stmt);
      if (result) return result;
    }
  }

  return null;
}

/**
 * Get the command name from a CommandAst.
 */
function getCommandName(cmd: CommandAst): string | null {
  if (!cmd.CommandElements?.length) return null;

  const firstElement = cmd.CommandElements[0];
  // Command name is typically a StringConstantExpressionAst
  if (firstElement?.Type === 'StringConstantExpressionAst') {
    return (firstElement as StringConstantExpressionAst).Value || null;
  }
  return null;
}

/**
 * Extract a parameter value from a CommandAst.
 * Looks for named parameters like -FilePath or -Path.
 */
function extractParameterValue(cmd: CommandAst, paramNames: string[]): string | null {
  if (!cmd.CommandElements) return null;

  const lowerParamNames = paramNames.map(p => p.toLowerCase());

  for (let i = 0; i < cmd.CommandElements.length; i++) {
    const element = cmd.CommandElements[i];

    // Check for CommandParameterAst (named parameter)
    if (element?.Type === 'CommandParameterAst') {
      const param = element as CommandParameterAst;
      const paramName = param.ParameterName?.toLowerCase();

      if (paramName && lowerParamNames.includes(paramName)) {
        // Parameter value might be in Argument property or next element
        if (param.Argument) {
          return extractStringValue(param.Argument);
        }
        // Check next element for the value
        const nextElement = cmd.CommandElements[i + 1];
        if (nextElement && nextElement.Type !== 'CommandParameterAst') {
          return extractStringValue(nextElement);
        }
      }
    }
  }

  return null;
}

/**
 * Extract the first positional argument from a CommandAst.
 * Skips the command name (index 0) and any named parameters (CommandParameterAst)
 * along with their values. Returns the first remaining string element.
 *
 * This handles commands like: Out-File C:\temp\file.txt
 * where the path is a positional parameter (no -FilePath flag).
 */
function extractFirstPositionalArg(cmd: CommandAst): string | null {
  if (!cmd.CommandElements || cmd.CommandElements.length < 2) return null;

  let i = 1; // Skip index 0 (cmdlet name)
  while (i < cmd.CommandElements.length) {
    const element = cmd.CommandElements[i];
    if (element?.Type === 'CommandParameterAst') {
      // Skip the parameter name and its value (next element)
      i += 2;
      continue;
    }
    // First non-parameter element is the positional argument
    if (!element) return null;
    return extractStringValue(element);
  }
  return null;
}

/**
 * Extract string value from various AST node types.
 */
function extractStringValue(node: ASTNode): string | null {
  if (!node) return null;

  switch (node.Type) {
    case 'StringConstantExpressionAst':
      return (node as StringConstantExpressionAst).Value || null;
    case 'ExpandableStringExpressionAst':
      return (node as ExpandableStringExpressionAst).Value || null;
    default:
      // Fallback to Text property which contains the raw text
      return node.Text?.replace(/^['"]|['"]$/g, '') || null;
  }
}
