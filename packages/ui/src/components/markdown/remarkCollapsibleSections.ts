
import type { Plugin } from 'unified'
import type { Root, Content, Heading, Parent } from 'mdast'

interface SectionNode extends Parent {
  type: 'section'
  depth: number
  data: {
    hName: 'div'
    hProperties: {
      'data-section-id': string
      'data-heading-level': number
      className: string[]
    }
  }
  children: Content[]
}

// Register the custom node with mdast so nesting remains type checked.
declare module 'mdast' {
  interface RootContentMap { section: SectionNode }
  interface BlockContentMap { section: SectionNode }
}

// Module-level counter reset for each parse
let sectionCounter = 0

/**
 * remarkCollapsibleSections
 *
 * Transforms the markdown AST to wrap heading+content groups into
 * section nodes that can be rendered as collapsible sections.
 */
const remarkCollapsibleSections: Plugin<[], Root> = () => {
  return (tree: Root) => {
    // Reset counter for each document
    sectionCounter = 0

    // Process from deepest to shallowest (6 -> 1)
    // This ensures nested sections are created before their parents
    for (let depth = 6; depth >= 1; depth--) {
      wrapHeadingsAtDepth(tree, depth)
    }
  }
}

function wrapHeadingsAtDepth(tree: Root, depth: number): void {
  // We need to iterate manually because we're modifying the tree
  const processNode = (parent: Parent) => {
    let i = 0
    while (i < parent.children.length) {
      const node = parent.children[i]
      if (!node) {
        i++
        continue
      }

      // Recursively process existing sections (for nested content)
      // Note: 'section' is our custom node type, not in mdast types
      if (node.type === 'section') {
        processNode(node)
        i++
        continue
      }

      // Found a heading at our target depth
      if (node.type === 'heading' && (node as Heading).depth === depth) {
        const sectionId = `section-${++sectionCounter}`

        // Find where this section ends (next same-or-higher level heading)
        let endIndex = i + 1
        while (endIndex < parent.children.length) {
          const sibling = parent.children[endIndex]
          if (!sibling) break

          // Stop at another heading of same or higher level (lower number)
          if (sibling.type === 'heading' && (sibling as Heading).depth <= depth) {
            break
          }

          // Stop at a section that contains a same-or-higher level heading
          // (already processed deeper sections)
          // Note: 'section' is our custom node type, not in mdast types
          if (sibling.type === 'section' && sibling.depth <= depth) {
            break
          }

          endIndex++
        }

        // Extract nodes for this section
        const sectionChildren = parent.children.slice(i, endIndex) as Content[]

        // Create section wrapper
        const section: SectionNode = {
          type: 'section',
          depth,
          children: sectionChildren,
          data: {
            hName: 'div',
            hProperties: {
              'data-section-id': sectionId,
              'data-heading-level': depth,
              className: ['markdown-section'],
            },
          },
        }

        // Replace the heading and its content with the section
        parent.children.splice(i, sectionChildren.length, section)
      }

      i++
    }
  }

  processNode(tree)
}

export default remarkCollapsibleSections
