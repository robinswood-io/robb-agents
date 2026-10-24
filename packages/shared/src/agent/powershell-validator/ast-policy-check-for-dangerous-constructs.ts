import type { ASTNode, ExpandableStringExpressionAst, InvokeMemberExpressionAst, PowerShellValidationReason } from './ast-types.ts';

/**
 * Check an AST node for dangerous constructs.
 */
export function checkForDangerousConstructs(node: ASTNode): PowerShellValidationReason | null {
  if (!node) {
    return null;
  }

  switch (node.Type) {
    case 'SubExpressionAst':
      return {
        type: 'subexpression',
        explanation: `$(...) subexpression executes embedded commands (found: ${node.Text})`,
      };

    case 'ScriptBlockExpressionAst':
      return {
        type: 'script_block',
        explanation: `Script block { } can execute arbitrary code (found: ${node.Text})`,
      };

    case 'ExpandableStringExpressionAst': {
      const expandable = node as ExpandableStringExpressionAst;
      // Check for subexpressions in the string
      for (const nested of expandable.NestedExpressions || []) {
        if (nested.Type === 'SubExpressionAst') {
          return {
            type: 'subexpression',
            explanation: `String contains $(...) subexpression (found: ${node.Text})`,
          };
        }
      }
      break;
    }

    case 'InvokeMemberExpressionAst': {
      // Method invocation could be dangerous
      const invoke = node as InvokeMemberExpressionAst;
      const memberText = invoke.Member?.Text?.toLowerCase() || '';

      // Block potentially dangerous method calls
      const dangerousMethods = ['invoke', 'invokescript', 'create', 'start'];
      if (dangerousMethods.some(m => memberText.includes(m))) {
        return {
          type: 'invoke_expression',
          explanation: `Method invocation could execute code (found: ${node.Text})`,
        };
      }
      break;
    }
  }

  return null;
}
