import { TurnCard, type ActivityItem, type ResponseContent, UserMessageBubble, SystemMessage } from "@craft-agent/ui";
import { AuthRequestCard } from "@/components/chat/AuthRequestCard";
import type { Message } from "../../../../shared/types";
import { StatusMessage, CompactionDivider, ProcessingIndicator, AssistantMessage } from "./status";

// ============================================================================
// Message Gallery - All message types in one scrollable view
// ============================================================================

export function MessageGallery() {
  const now = Date.now()

  // Sample tool activities for TurnCard
  const completedGrepActivity: ActivityItem = {
    id: 'tool-1',
    type: 'tool',
    status: 'completed',
    toolName: 'Grep',
    toolInput: { pattern: 'AuthHandler', path: 'src/' },
    intent: 'Searching for authentication handlers',
    timestamp: now - 5000,
  }

  const completedReadActivity: ActivityItem = {
    id: 'tool-2',
    type: 'tool',
    status: 'completed',
    toolName: 'Read',
    toolInput: { file_path: '/src/auth/index.ts' },
    timestamp: now - 4000,
  }

  const runningGrepActivity: ActivityItem = {
    id: 'tool-running-1',
    type: 'tool',
    status: 'running',
    toolName: 'Grep',
    toolInput: { pattern: 'handleError', path: 'src/' },
    intent: 'Finding error handling patterns',
    timestamp: now - 1000,
  }

  const shortResponse: ResponseContent = {
    text: "I found the authentication handlers in `src/auth/`. The main handler is `AuthHandler` which manages OAuth flows and token validation.",
    isStreaming: false,
  }

  const streamingResponse: ResponseContent = {
    text: "I'm analyzing the codebase and looking for patterns that match your query. Let me check a few more files...",
    isStreaming: true,
    streamStartTime: now - 500,
  }

  return (
    <div className="max-w-[960px] mx-auto p-8 space-y-8">
      {/* Section: Status & Dividers (playground demo components) */}
      <section>
        <h2 className="text-lg font-semibold mb-4 text-foreground/80">Status & Dividers</h2>
        <div className="bg-muted/20 rounded-lg">
          <StatusMessage content="Compacting conversation..." />
          <CompactionDivider />
          <StatusMessage content="Connecting to server..." />
        </div>
      </section>

      {/* Section: Processing States */}
      <section>
        <h2 className="text-lg font-semibold mb-4 text-foreground/80">Processing States</h2>
        <div className="bg-muted/20 rounded-lg ">
          <ProcessingIndicator />
        </div>
      </section>

      {/* Section: User Messages */}
      <section>
        <h2 className="text-lg font-semibold mb-4 text-foreground/80">User Messages</h2>
        <div className="space-y-3">
          <UserMessageBubble content="How do I authenticate with the API?" />
          <UserMessageBubble content="Can you search for all files that contain 'handleError' and show me how they work?" />
        </div>
      </section>

      {/* Section: Assistant Messages */}
      <section>
        <h2 className="text-lg font-semibold mb-4 text-foreground/80">Assistant Messages</h2>
        <div className="space-y-3">
          <AssistantMessage content="I found the authentication handlers in `src/auth/`. The main handler is `AuthHandler` which manages OAuth flows and token validation." />
          <AssistantMessage content={`Here's a more detailed response with **markdown** formatting:

1. First, check the \`config.ts\` file
2. Then update the environment variables
3. Finally, restart the server

\`\`\`typescript
const config = {
  apiKey: process.env.API_KEY,
  secret: process.env.SECRET
};
\`\`\`
`} />
        </div>
      </section>

      {/* Section: SystemMessage (from @craft-agent/ui) */}
      <section>
        <h2 className="text-lg font-semibold mb-4 text-foreground/80">SystemMessage (Shared)</h2>
        <div className="bg-muted/20 rounded-lg">
          <SystemMessage content="This is a system message." type="system" />
          <SystemMessage content="This is an info message." type="info" />
          <SystemMessage content="This is a warning message." type="warning" />
          <SystemMessage content="This is an error message." type="error" />
        </div>
      </section>

      {/* Section: TurnCard - Complete Turn */}
      <section>
        <h2 className="text-lg font-semibold mb-4 text-foreground/80">TurnCard - Complete Turn</h2>
        <TurnCard
          sessionId="playground-session"
          turnId="turn-1"
          activities={[completedGrepActivity, completedReadActivity]}
          response={shortResponse}
          intent="Analyzing authentication system"
          isStreaming={false}
          isComplete={true}
          onOpenFile={(path) => console.log('Open file:', path)}
          onOpenUrl={(url) => console.log('Open URL:', url)}
        />
      </section>

      {/* Section: TurnCard - Streaming */}
      <section>
        <h2 className="text-lg font-semibold mb-4 text-foreground/80">TurnCard - Streaming Response</h2>
        <TurnCard
          sessionId="playground-session"
          turnId="turn-2"
          activities={[completedGrepActivity]}
          response={streamingResponse}
          isStreaming={true}
          isComplete={false}
          onOpenFile={(path) => console.log('Open file:', path)}
          onOpenUrl={(url) => console.log('Open URL:', url)}
        />
      </section>

      {/* Section: TurnCard - Tool Running */}
      <section>
        <h2 className="text-lg font-semibold mb-4 text-foreground/80">TurnCard - Tool Running</h2>
        <TurnCard
          sessionId="playground-session"
          turnId="turn-3"
          activities={[runningGrepActivity]}
          response={undefined}
          intent="Finding error handling patterns"
          isStreaming={true}
          isComplete={false}
          onOpenFile={(path) => console.log('Open file:', path)}
          onOpenUrl={(url) => console.log('Open URL:', url)}
        />
      </section>

      {/* Section: TurnCard - Response Only */}
      <section>
        <h2 className="text-lg font-semibold mb-4 text-foreground/80">TurnCard - Response Only (No Tools)</h2>
        <TurnCard
          sessionId="playground-session"
          turnId="turn-4"
          activities={[]}
          response={shortResponse}
          isStreaming={false}
          isComplete={true}
          onOpenFile={(path) => console.log('Open file:', path)}
          onOpenUrl={(url) => console.log('Open URL:', url)}
        />
      </section>

      {/* Section: Auth Request Cards */}
      <section>
        <h2 className="text-lg font-semibold mb-4 text-foreground/80">Auth Request Cards</h2>
        <div className="space-y-4">
          {/* Credential - Pending */}
          <div>
            <h3 className="text-sm font-medium mb-2 text-muted-foreground">Credential Request (pending)</h3>
            <AuthRequestCard
              sessionId="playground-session"
              message={createAuthMessage({
                type: 'credential',
                status: 'pending',
                sourceSlug: 'github',
                sourceName: 'GitHub',
                mode: 'bearer',
                description: 'Enter your GitHub personal access token to connect.',
                hint: 'Generate a token at https://github.com/settings/tokens',
              })}
              onRespondToCredential={(sessionId, requestId, response) =>
                console.log('Credential response:', { sessionId, requestId, response })
              }
            />
          </div>

          {/* Credential - Basic Auth */}
          <div>
            <h3 className="text-sm font-medium mb-2 text-muted-foreground">Basic Auth (pending)</h3>
            <AuthRequestCard
              sessionId="playground-session"
              message={createAuthMessage({
                type: 'credential',
                status: 'pending',
                sourceSlug: 'jira',
                sourceName: 'Jira',
                mode: 'basic',
                labels: { username: 'Email', password: 'API Token' },
                description: 'Connect to your Atlassian account.',
              })}
              onRespondToCredential={(sessionId, requestId, response) =>
                console.log('Credential response:', { sessionId, requestId, response })
              }
            />
          </div>

          {/* OAuth - Pending */}
          <div>
            <h3 className="text-sm font-medium mb-2 text-muted-foreground">OAuth Request (pending)</h3>
            <AuthRequestCard
              sessionId="playground-session"
              message={createAuthMessage({
                type: 'oauth',
                status: 'pending',
                sourceSlug: 'linear',
                sourceName: 'Linear',
              })}
            />
          </div>

          {/* Google OAuth - Pending */}
          <div>
            <h3 className="text-sm font-medium mb-2 text-muted-foreground">Google OAuth (pending)</h3>
            <AuthRequestCard
              sessionId="playground-session"
              message={createAuthMessage({
                type: 'oauth-google',
                status: 'pending',
                sourceSlug: 'gmail',
                sourceName: 'Gmail',
              })}
            />
          </div>

          {/* Completed */}
          <div>
            <h3 className="text-sm font-medium mb-2 text-muted-foreground">Auth Completed</h3>
            <AuthRequestCard
              sessionId="playground-session"
              message={createAuthMessage({
                type: 'oauth-google',
                status: 'completed',
                sourceSlug: 'gmail',
                sourceName: 'Gmail',
                email: 'user@example.com',
              })}
            />
          </div>

          {/* Cancelled */}
          <div>
            <h3 className="text-sm font-medium mb-2 text-muted-foreground">Auth Cancelled</h3>
            <AuthRequestCard
              sessionId="playground-session"
              message={createAuthMessage({
                type: 'oauth',
                status: 'cancelled',
                sourceSlug: 'slack',
                sourceName: 'Slack',
              })}
            />
          </div>

          {/* Failed */}
          <div>
            <h3 className="text-sm font-medium mb-2 text-muted-foreground">Auth Failed</h3>
            <AuthRequestCard
              sessionId="playground-session"
              message={createAuthMessage({
                type: 'credential',
                status: 'failed',
                sourceSlug: 'sentry',
                sourceName: 'Sentry',
                error: 'Invalid API key. Please check and try again.',
              })}
            />
          </div>
        </div>
      </section>
    </div>
  )
}

/** Helper to create auth message for playground */
export function createAuthMessage(opts: {
  type: 'credential' | 'oauth' | 'oauth-google' | 'oauth-slack' | 'oauth-microsoft'
  status: 'pending' | 'completed' | 'cancelled' | 'failed'
  sourceSlug: string
  sourceName: string
  mode?: 'bearer' | 'basic' | 'header' | 'query'
  labels?: { credential?: string; username?: string; password?: string }
  description?: string
  hint?: string
  error?: string
  email?: string
  workspace?: string
}): Message {
  return {
    id: `auth-${opts.sourceSlug}-${Date.now()}`,
    role: 'auth-request',
    content: `Authentication required for ${opts.sourceName}`,
    timestamp: Date.now(),
    authRequestId: `req-${opts.sourceSlug}`,
    authRequestType: opts.type,
    authSourceSlug: opts.sourceSlug,
    authSourceName: opts.sourceName,
    authStatus: opts.status,
    ...(opts.mode !== undefined ? { authCredentialMode: opts.mode } : {}),
    ...(opts.labels !== undefined ? { authLabels: opts.labels } : {}),
    ...(opts.description !== undefined ? { authDescription: opts.description } : {}),
    ...(opts.hint !== undefined ? { authHint: opts.hint } : {}),
    ...(opts.error !== undefined ? { authError: opts.error } : {}),
    ...(opts.email !== undefined ? { authEmail: opts.email } : {}),
    ...(opts.workspace !== undefined ? { authWorkspace: opts.workspace } : {}),
  }
}
