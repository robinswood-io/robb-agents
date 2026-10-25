import { type ActivityItem, type ResponseContent, type TodoItem } from "@craft-agent/ui";

// ============================================================================
// Sample Data
// ============================================================================

const now = Date.now()

// Completed tool activities
export const completedGrepActivity: ActivityItem = {
  id: 'tool-1',
  type: 'tool',
  status: 'completed',
  toolName: 'Grep',
  toolInput: { pattern: 'AuthHandler', path: 'src/' },
  intent: 'Searching for authentication handlers',
  timestamp: now - 5000,
}

export const completedReadActivity1: ActivityItem = {
  id: 'tool-2',
  type: 'tool',
  status: 'completed',
  toolName: 'Read',
  toolInput: { file_path: '/src/auth/index.ts' },
  timestamp: now - 4000,
}

export const completedReadActivity2: ActivityItem = {
  id: 'tool-3',
  type: 'tool',
  status: 'completed',
  toolName: 'Read',
  toolInput: { file_path: '/src/auth/oauth.ts' },
  timestamp: now - 3000,
}

export const completedBashActivity: ActivityItem = {
  id: 'tool-4',
  type: 'tool',
  status: 'completed',
  toolName: 'Bash',
  toolInput: { command: 'npm test', description: 'Running tests' },
  intent: 'Running the test suite',
  timestamp: now - 2000,
}

// Running tool activities
export const runningGrepActivity: ActivityItem = {
  id: 'tool-running-1',
  type: 'tool',
  status: 'running',
  toolName: 'Grep',
  toolInput: { pattern: 'handleError', path: 'src/' },
  intent: 'Finding error handling patterns',
  timestamp: now - 1000,
}

export const runningReadActivity: ActivityItem = {
  id: 'tool-running-2',
  type: 'tool',
  status: 'running',
  toolName: 'Read',
  toolInput: { file_path: '/src/lib/errors.ts' },
  timestamp: now - 500,
}

// Error activity
export const errorActivity: ActivityItem = {
  id: 'tool-error-1',
  type: 'tool',
  status: 'error',
  toolName: 'Bash',
  toolInput: { command: 'npm run deploy' },
  error: 'Permission denied',
  timestamp: now - 1000,
}

// Pending activities
export const pendingActivity: ActivityItem = {
  id: 'tool-pending-1',
  type: 'tool',
  status: 'pending',
  toolName: 'Write',
  toolInput: { file_path: '/src/auth/new-handler.ts' },
  timestamp: now,
}

// Intermediate messages (LLM commentary between tool calls)
export const intermediateMessage1: ActivityItem = {
  id: 'intermediate-1',
  type: 'intermediate',
  status: 'completed',
  content: "Let me search for the authentication handlers in your codebase...",
  timestamp: now - 6000,
}

export const intermediateMessage2: ActivityItem = {
  id: 'intermediate-2',
  type: 'intermediate',
  status: 'completed',
  content: "Found some matches. Now let me read the main auth file to understand the implementation.",
  timestamp: now - 3500,
}

export const intermediateMessage3: ActivityItem = {
  id: 'intermediate-3',
  type: 'intermediate',
  status: 'completed',
  content: "I see this uses OAuth 2.0. Let me also check how tokens are managed.",
  timestamp: now - 2500,
}

export const intermediateMessageRunning: ActivityItem = {
  id: 'intermediate-running',
  type: 'intermediate',
  status: 'completed',
  content: "Let me run the tests to make sure everything works correctly...",
  timestamp: now - 1500,
}

export const intermediateMessageStreaming: ActivityItem = {
  id: 'intermediate-streaming',
  type: 'intermediate',
  status: 'running',  // Still streaming - will show "Thinking..."
  content: "",  // Content not shown while streaming
  timestamp: now,
}

// Sample responses
export const shortResponse: ResponseContent = {
  text: "I found the authentication handlers in `src/auth/`. The main handler is `AuthHandler` which manages OAuth flows and token validation.",
  isStreaming: false,
}

export const longResponse: ResponseContent = {
  text: `I've analyzed the authentication system and here's what I found:

## Authentication Architecture

The authentication system is built around three main components:

### 1. AuthHandler (\`src/auth/index.ts\`)
- Manages the OAuth 2.0 flow
- Handles token validation and refresh
- Provides session management

\`\`\`typescript
export class AuthHandler {
  async authenticate(credentials: Credentials): Promise<Session> {
    // OAuth flow implementation
    const token = await this.oauth.getToken(credentials);
    return this.createSession(token);
  }
}
\`\`\`

### 2. TokenManager (\`src/auth/tokens.ts\`)
- Stores tokens securely using encryption
- Handles automatic token refresh before expiry
- Provides token revocation

### 3. SessionStore (\`src/auth/sessions.ts\`)
- Maintains active user sessions
- Handles session timeout and cleanup
- Provides session restoration on app restart

## Recommendations

1. **Add refresh token rotation** - Currently tokens are reused until expiry
2. **Implement PKCE** - For better security in public clients
3. **Add audit logging** - Track authentication events for security monitoring

Would you like me to implement any of these improvements?`,
  isStreaming: false,
}

export const streamingResponse: ResponseContent = {
  text: "I'm analyzing the codebase and looking for",
  isStreaming: true,
  streamStartTime: now - 500,
}

export const emptyStreamingResponse: ResponseContent = {
  text: '',
  isStreaming: true,
  streamStartTime: now,
}

// ============================================================================
// Helper: Generate many activities for stress testing
// ============================================================================

/** Tool names and file paths for realistic variety */
const toolVariety = [
  { tool: 'Read', getInput: (i: number) => ({ file_path: `/src/components/feature-${i}.tsx` }) },
  { tool: 'Grep', getInput: (i: number) => ({ pattern: `pattern${i}`, path: 'src/' }) },
  { tool: 'Glob', getInput: (i: number) => ({ pattern: `**/*${i}*.ts` }) },
  { tool: 'Bash', getInput: (i: number) => ({ command: `npm test -- file${i}` }) },
  { tool: 'Write', getInput: (i: number) => ({ file_path: `/src/utils/helper-${i}.ts` }) },
  { tool: 'Edit', getInput: (i: number) => ({ file_path: `/src/lib/module-${i}.ts` }) },
]

const commentaryVariety = [
  "Let me check this file for relevant code...",
  "I found some interesting patterns here.",
  "This looks like what we need.",
  "Searching for related implementations...",
  "Found a match, examining the details.",
  "This module handles the core logic.",
  "Let me verify this works correctly.",
  "Checking for any edge cases...",
]

/**
 * Generate a realistic sequence of activities with mixed tools and commentary.
 * Alternates between tool calls and intermediate messages for realism.
 */
function generateManyActivities(count: number): ActivityItem[] {
  const activities: ActivityItem[] = []
  let timestamp = now - (count * 100)

  for (let i = 0; i < count; i++) {
    // Every 3rd item is an intermediate message
    if (i % 3 === 0 && i > 0) {
      activities.push({
        id: `intermediate-${i}`,
        type: 'intermediate',
        status: 'completed',
        content: commentaryVariety[i % commentaryVariety.length],
        timestamp: timestamp,
      })
    } else {
      const toolInfo = toolVariety[i % toolVariety.length]
      activities.push({
        id: `tool-${i}`,
        type: 'tool',
        status: 'completed',
        toolName: toolInfo.tool,
        toolInput: toolInfo.getInput(i),
        timestamp: timestamp,
      })
    }
    timestamp += 100
  }

  return activities
}

/** Pre-generated 75 activities for playground */
export const manyActivities75 = generateManyActivities(75)

// ============================================================================
// Sample Todos (for TodoWrite visualization)
// ============================================================================

/** Empty state - no todos */
const todosEmpty: TodoItem[] = []

/** All pending - just started planning */
export const todosAllPending: TodoItem[] = [
  { content: 'Analyze authentication system', status: 'pending', activeForm: 'Analyzing authentication system' },
  { content: 'Implement token refresh logic', status: 'pending', activeForm: 'Implementing token refresh' },
  { content: 'Add unit tests for auth flow', status: 'pending', activeForm: 'Adding unit tests' },
  { content: 'Update API documentation', status: 'pending', activeForm: 'Updating documentation' },
]

/** In progress - currently working */
export const todosInProgress: TodoItem[] = [
  { content: 'Analyze authentication system', status: 'completed', activeForm: 'Analyzing authentication system' },
  { content: 'Implement token refresh logic', status: 'in_progress', activeForm: 'Implementing token refresh' },
  { content: 'Add unit tests for auth flow', status: 'pending', activeForm: 'Adding unit tests' },
  { content: 'Update API documentation', status: 'pending', activeForm: 'Updating documentation' },
]

/** Mixed progress */
export const todosMixed: TodoItem[] = [
  { content: 'Fix critical security bug', status: 'completed', activeForm: 'Fixing security bug' },
  { content: 'Implement OAuth 2.0 flow', status: 'in_progress', activeForm: 'Implementing OAuth flow' },
  { content: 'Add session timeout handling', status: 'pending', activeForm: 'Adding timeout handling' },
  { content: 'Improve error messages', status: 'pending', activeForm: 'Improving error messages' },
  { content: 'Add telemetry events', status: 'pending', activeForm: 'Adding telemetry' },
]

/** Almost done - 1 remaining */
export const todosAlmostDone: TodoItem[] = [
  { content: 'Research authentication patterns', status: 'completed', activeForm: 'Researching patterns' },
  { content: 'Implement token validation', status: 'completed', activeForm: 'Implementing validation' },
  { content: 'Add refresh token rotation', status: 'completed', activeForm: 'Adding token rotation' },
  { content: 'Run test suite and verify', status: 'in_progress', activeForm: 'Running tests' },
]

/** All completed - task done */
export const todosAllCompleted: TodoItem[] = [
  { content: 'Analyze current implementation', status: 'completed', activeForm: 'Analyzing implementation' },
  { content: 'Implement improvements', status: 'completed', activeForm: 'Implementing improvements' },
  { content: 'Add comprehensive tests', status: 'completed', activeForm: 'Adding tests' },
  { content: 'Update documentation', status: 'completed', activeForm: 'Updating docs' },
]

/** Long task list (stress test) */
export const todosLong: TodoItem[] = [
  { content: 'Set up project structure', status: 'completed', activeForm: 'Setting up project' },
  { content: 'Configure build system', status: 'completed', activeForm: 'Configuring build' },
  { content: 'Install dependencies', status: 'completed', activeForm: 'Installing deps' },
  { content: 'Create database schema', status: 'completed', activeForm: 'Creating schema' },
  { content: 'Implement user model', status: 'completed', activeForm: 'Implementing model' },
  { content: 'Add authentication middleware', status: 'in_progress', activeForm: 'Adding auth middleware' },
  { content: 'Create API endpoints', status: 'pending', activeForm: 'Creating endpoints' },
  { content: 'Add input validation', status: 'pending', activeForm: 'Adding validation' },
  { content: 'Implement error handling', status: 'pending', activeForm: 'Implementing errors' },
  { content: 'Add rate limiting', status: 'pending', activeForm: 'Adding rate limits' },
  { content: 'Set up logging', status: 'pending', activeForm: 'Setting up logging' },
  { content: 'Write unit tests', status: 'pending', activeForm: 'Writing tests' },
]
