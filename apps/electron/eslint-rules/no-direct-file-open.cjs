/**
 * ESLint Rule: no-direct-file-open
 *
 * Prevents calling window.electronAPI.openFile() directly in renderer code.
 * All file-open calls should go through the link interceptor (via AppShellContext
 * or PlatformContext's onOpenFile) so the app can show in-app previews for
 * supported file types instead of always opening in the default external app.
 *
 * Allowed in:
 *   - App.tsx (link interceptor implementation)
 *   - useLinkInterceptor.ts (link interceptor fallback)
 *
 * Bad:
 *   window.electronAPI.openFile(path)
 *
 * Good:
 *   const { onOpenFile } = useAppShellContext()
 *   onOpenFile(path)
 */

/** The sole effect in a directory branch may open that directory's path. */
function isDirectoryOnlyCall(node) {
  const statement = node.parent
  const block = statement?.parent
  const branch = block?.parent
  if (statement?.type !== 'ExpressionStatement' || block?.type !== 'BlockStatement'
    || branch?.type !== 'IfStatement' || branch.consequent !== block
    || block.body.length !== 1 || block.body[0] !== statement || node.arguments.length !== 1) return false
  const test = branch.test
  const argument = node.arguments[0]
  return test.type === 'BinaryExpression' && test.operator === '==='
    && test.left.type === 'MemberExpression' && !test.left.computed
    && test.left.object.type === 'Identifier' && test.left.property.type === 'Identifier'
    && test.left.property.name === 'type' && test.right.type === 'Literal'
    && test.right.value === 'directory' && argument?.type === 'MemberExpression'
    && !argument.computed && argument.object.type === 'Identifier'
    && argument.object.name === test.left.object.name
    && argument.property.type === 'Identifier' && argument.property.name === 'path'
}

/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow direct window.electronAPI.openFile() calls. Use onOpenFile from context instead.',
      category: 'Best Practices',
      recommended: true,
    },
    messages: {
      noDirectFileOpen:
        'Use onOpenFile from AppShellContext or PlatformContext instead of calling window.electronAPI.openFile() directly. This ensures the link interceptor can show in-app previews for supported file types.',
    },
    schema: [],
  },

  create(context) {
    // Allow direct calls in the interceptor implementation files
    const filename = context.filename || context.getFilename()
    const basename = filename.split('/').pop() || ''
    if (basename === 'App.tsx' || basename === 'useLinkInterceptor.ts') {
      return {}
    }

    return {
      // Match: window.electronAPI.openFile(...)
      CallExpression(node) {
        const callee = node.callee
        if (
          callee.type === 'MemberExpression' &&
          callee.property.type === 'Identifier' &&
          callee.property.name === 'openFile' &&
          callee.object.type === 'MemberExpression' &&
          callee.object.property.type === 'Identifier' &&
          callee.object.property.name === 'electronAPI'
        ) {
          if (isDirectoryOnlyCall(node)) return
          context.report({
            node,
            messageId: 'noDirectFileOpen',
          })
        }
      },
    }
  },
}
