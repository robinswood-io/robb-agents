
export const sampleMarkdown = `# Welcome to Markdown

This is a **bold** statement and this is *italic*.

## Code Examples

Here's some inline code: \`const x = 42\`

\`\`\`typescript
function greet(name: string): string {
  return \`Hello, \${name}!\`
}

// Call the function
console.log(greet("World"))
\`\`\`

## Lists

- First item
- Second item
  - Nested item
- Third item

1. Numbered one
2. Numbered two
3. Numbered three

## Table

| Name | Role | Status |
|------|------|--------|
| Alice | Developer | Active |
| Bob | Designer | Away |

## Blockquote

> This is a blockquote with some important information
> that spans multiple lines.

---

That's all folks!`

export const codeHeavyMarkdown = `# API Response

The endpoint returned:

\`\`\`json
{
  "status": "success",
  "data": {
    "users": [
      { "id": 1, "name": "Alice" },
      { "id": 2, "name": "Bob" }
    ]
  }
}
\`\`\`

Process with:

\`\`\`python
import json

def process_response(data: dict) -> list:
    return [user["name"] for user in data["users"]]
\`\`\`

Or in TypeScript:

\`\`\`typescript
interface User {
  id: number
  name: string
}

const getNames = (users: User[]): string[] =>
  users.map(u => u.name)
\`\`\``

export const typescriptCode = `import { useState, useEffect } from 'react'

interface Todo {
  id: number
  title: string
  completed: boolean
}

export function useTodos() {
  const [todos, setTodos] = useState<Todo[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/todos')
      .then(res => res.json())
      .then(data => {
        setTodos(data)
        setLoading(false)
      })
  }, [])

  return { todos, loading }
}`

export const pythonCode = `from dataclasses import dataclass
from typing import Optional

@dataclass
class User:
    id: int
    name: str
    email: Optional[str] = None

def get_user_by_id(user_id: int) -> Optional[User]:
    """Fetch user from database."""
    # Simulated database lookup
    users = {
        1: User(1, "Alice", "alice@example.com"),
        2: User(2, "Bob"),
    }
    return users.get(user_id)`

export const jsonCode = `{
  "name": "craft-agent",
  "version": "1.0.0",
  "dependencies": {
    "react": "^18.2.0",
    "typescript": "^5.0.0"
  },
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build"
  }
}`

export const richBlockParityMarkdown = `# Rich Block Interaction Parity

Use this fixture to compare **inline** and **fullscreen** interactions for Mermaid and image blocks.

- Tap/click inline content to open fullscreen
- In fullscreen: wheel/pinch zoom, drag pan, double-click reset
- Keyboard: Cmd/Ctrl +, -, 0

## Mermaid block

\`\`\`mermaid
graph LR
    A[Input] --> B{Validate}
    B -->|Valid| C[Persist]
    B -->|Invalid| D[Show Error]
    C --> E[Notify]
\`\`\`

## Image block

\`\`\`image-preview
{
  "title": "Parity Check",
  "items": [
    { "src": "/mock/images/gallery-1.png", "label": "Lake" },
    { "src": "/mock/images/gallery-2.png", "label": "Forest" }
  ]
}
\`\`\`
`

export const MOCK_IMAGE_DATA: Record<string, string> = {
  '/mock/images/gallery-1.png': 'https://picsum.photos/id/1015/1200/900',
  '/mock/images/gallery-2.png': 'https://picsum.photos/id/1025/900/1200',
  '/mock/images/gallery-3.png': 'https://picsum.photos/id/1035/1400/900',
  '/mock/images/gallery-4.png': 'https://picsum.photos/id/1043/1200/900',
  '/mock/images/gallery-5.png': 'https://picsum.photos/id/1067/1200/900',
}
