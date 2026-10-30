import type { Identifier } from 'estree';
import type { Rule, Scope } from 'eslint';
/**
 * Renderer storage boundary: durable settings use file preferences; ephemeral UI
 * caches use the existing typed local-storage utility. Raw browser access belongs
 * only to that utility, including its Jotai adapter.
 */

/** @type {import('eslint').Rule.RuleModule} */
const rule: Rule.RuleModule = {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Keep raw browser storage inside the typed UI cache utility.',
      recommended: true,
    },
    messages: {
      noLocalStorage:
        'Use file-based preferences for durable settings or @/lib/local-storage for UI cache. Raw localStorage access belongs to that utility.',
    },
    schema: [],
  },

  create(context) {
    const filename = context.filename.replaceAll('\\', '/')
    if (filename.endsWith('/apps/electron/src/renderer/lib/local-storage.ts')) return {}

    function isGlobal(node: Identifier) {
      let scope: Scope.Scope | null = context.sourceCode.getScope(node)
      while (scope) {
        const variable = scope.set.get(node.name)
        if (variable) return variable.defs.length === 0
        scope = scope.upper
      }
      return true
    }

    return {
      MemberExpression(node) {
        const property = node.computed
          ? node.property.type === 'Literal' && node.property.value
          : node.property.type === 'Identifier' && node.property.name
        if (property === 'localStorage' && node.object.type === 'Identifier'
          && ['window', 'globalThis', 'self'].includes(node.object.name)
          && isGlobal(node.object)) {
          context.report({ node, messageId: 'noLocalStorage' })
        }
      },
      Identifier(node) {
        if (node.name !== 'localStorage' || !isGlobal(node)) return
        const scope = context.sourceCode.getScope(node)
        if (!scope.references.some(reference => reference.identifier === node)) return
        context.report({ node, messageId: 'noLocalStorage' })
      },
    }
  },
}

export default rule;
