import type { ComponentEntry } from "../types";
import { sampleMarkdownContent, samplePlanContent } from "./document-fixtures";
import { DocumentFormattedMarkdownOverlayPlayground, CodePreviewOverlayPlayground } from "./overlays";
import { sampleTypeScriptCode, samplePythonCode } from "./code-fixtures";

// ============================================================================
// Fullscreen Overlay Component Registry
// ============================================================================

/** Export all fullscreen overlay components */
export const documentOverlayEntry: ComponentEntry = {
    id: 'document-overlay',
    name: 'DocumentFormattedMarkdownOverlay',
    category: 'Fullscreen',
    description: 'Fullscreen document view for reading AI responses and plans',
    component: DocumentFormattedMarkdownOverlayPlayground,
    layout: 'top',
    props: [
      {
        name: 'variant',
        description: 'Style variant: response (default) or plan (shows header)',
        control: {
          type: 'select',
          options: [
            { label: 'Response', value: 'response' },
            { label: 'Plan', value: 'plan' },
          ],
        },
        defaultValue: 'response',
      },
    ],
    variants: [
      {
        name: 'Response (Default)',
        description: 'Standard response view with commenting support',
        props: {
          content: sampleMarkdownContent,
          variant: 'response',
        },
      },
      {
        name: 'Plan Variant',
        description: 'Plan view with green header badge',
        props: {
          content: samplePlanContent,
          variant: 'plan',
        },
      },
      {
        name: 'Short Content',
        description: 'Minimal content to test layout',
        props: {
          content: '# Quick Response\n\nThis is a short response to test the layout with minimal content.\n\nLooks good!',
          variant: 'response',
        },
      },
      {
        name: 'Code Heavy',
        description: 'Content with lots of code blocks',
        props: {
          content: `# Code Examples

Here are some code examples:

\`\`\`typescript
// TypeScript example
interface User {
  id: string;
  name: string;
  email: string;
}

async function getUser(id: string): Promise<User> {
  const response = await fetch(\`/api/users/\${id}\`);
  return response.json();
}
\`\`\`

\`\`\`python
# Python example
def fibonacci(n: int) -> int:
    if n <= 1:
        return n
    return fibonacci(n - 1) + fibonacci(n - 2)
\`\`\`

\`\`\`rust
// Rust example
fn main() {
    let numbers: Vec<i32> = (1..=10).collect();
    let sum: i32 = numbers.iter().sum();
    println!("Sum: {}", sum);
}
\`\`\`

These examples demonstrate different syntax highlighting.`,
          variant: 'response',
        },
      },
    ],
    mockData: () => ({
      content: sampleMarkdownContent,
    }),
  };

export const codePreviewOverlayEntry: ComponentEntry = {
    id: 'code-preview-overlay',
    name: 'CodePreviewOverlay',
    category: 'Fullscreen',
    description: 'Syntax-highlighted code file preview (Read/Write tools)',
    component: CodePreviewOverlayPlayground,
    layout: 'top',
    props: [
      {
        name: 'mode',
        description: 'Display mode: read or write',
        control: {
          type: 'select',
          options: [
            { label: 'Read', value: 'read' },
            { label: 'Write', value: 'write' },
          ],
        },
        defaultValue: 'read',
      },
    ],
    variants: [
      {
        name: 'TypeScript File (Read)',
        description: 'Reading a TypeScript source file',
        props: {
          content: sampleTypeScriptCode,
          filePath: '/src/auth/tokens.ts',
          mode: 'read',
          startLine: 1,
          totalLines: 98,
          numLines: 98,
        },
      },
      {
        name: 'Python File (Read)',
        description: 'Reading a Python ML pipeline',
        props: {
          content: samplePythonCode,
          filePath: '/src/ml/pipeline.py',
          mode: 'read',
          startLine: 1,
          totalLines: 85,
          numLines: 85,
        },
      },
      {
        name: 'Partial Read (Lines 15-45)',
        description: 'Reading a subset of lines from a large file',
        props: {
          content: sampleTypeScriptCode.split('\n').slice(14, 45).join('\n'),
          filePath: '/src/auth/tokens.ts',
          mode: 'read',
          startLine: 15,
          totalLines: 98,
          numLines: 31,
        },
      },
      {
        name: 'Write Mode',
        description: 'Showing a file being written',
        props: {
          content: sampleTypeScriptCode,
          filePath: '/src/auth/tokens.ts',
          mode: 'write',
        },
      },
      {
        name: 'Read Failed',
        description: 'Error state when file read fails',
        props: {
          content: '',
          filePath: './apps/electron/src/main/sessions.ts',
          mode: 'read',
          error: "Bash command `python3 -c import re; f=open('./node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs','r'); content=f.read(); f.close(); [print(m.group(),'---') for m in list(re.finditer(r'.{0,150}AbortError.{0,150}', content))[:5]]` is not in the read-only allowlist.\n\nMatched: `python3 -` (9 chars)\nFailed at: `c` (position 9)\n\nPattern: Python 3 version",
        },
      },
    ],
    mockData: () => ({
      content: sampleTypeScriptCode,
      filePath: '/src/auth/tokens.ts',
    }),
  };
