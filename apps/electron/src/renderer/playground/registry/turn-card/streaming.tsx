import type { ComponentEntry } from "../types";
import { useState, useEffect, type ReactNode } from "react";
import { TurnCard, type ActivityItem, type ResponseContent } from "@craft-agent/ui";
import { completedGrepActivity, completedReadActivity1, completedReadActivity2, intermediateMessage1, intermediateMessage2 } from "./turn-fixtures";

/** Wrapper with padding for playground preview */
export function PaddedWrapper({ children }: { children: ReactNode }) {
  return <div className="p-8">{children}</div>
}

// ============================================================================
// Streaming Simulation Components
// ============================================================================

const streamingTextSample = `I've analyzed the authentication system and here's what I found:

## Authentication Architecture

The authentication system is built around three main components:

### 1. AuthHandler (\`src/auth/index.ts\`)
- Manages the OAuth 2.0 flow
- Handles token validation and refresh
- Provides session management

\`\`\`typescript
export class AuthHandler {
  async authenticate(credentials: Credentials): Promise<Session> {
    const token = await this.oauth.getToken(credentials);
    return this.createSession(token);
  }
}
\`\`\`

### 2. TokenManager
- Stores tokens securely using encryption
- Handles automatic token refresh before expiry

### 3. SessionStore
- Maintains active user sessions
- Handles session timeout and cleanup

Would you like me to implement any improvements?`

/**
 * Realistic streaming simulation with:
 * - Fast character streaming (simulates real LLM token rate)
 * - Component batching accumulates into word-sized chunks
 * - Pauses at punctuation for natural rhythm
 */
function useStreamingSimulation(
  fullText: string,
  speed: 'slow' | 'normal' | 'fast' = 'normal',
) {
  const [streamedText, setStreamedText] = useState('')
  const [isComplete, setIsComplete] = useState(false)

  useEffect(() => {
    setStreamedText('')
    setIsComplete(false)
    let index = 0
    let timeoutId: ReturnType<typeof setTimeout>

    // Speed configs: chars per tick, base interval
    // Fast intervals let component batching accumulate words
    const speedConfig = {
      slow: { charsPerTick: 1, baseInterval: 20, punctuationDelay: 300 },
      normal: { charsPerTick: 2, baseInterval: 10, punctuationDelay: 150 },
      fast: { charsPerTick: 4, baseInterval: 5, punctuationDelay: 50 },
    }
    const config = speedConfig[speed]

    function tick() {
      if (index >= fullText.length) {
        setIsComplete(true)
        return
      }

      const currentChar = fullText.charAt(index)
      const isPunctuation = /[.!?,;:\n]/.test(currentChar)

      // Send chars
      index = Math.min(index + config.charsPerTick, fullText.length)
      setStreamedText(fullText.slice(0, index))

      // Pause at punctuation for natural rhythm
      const nextInterval = isPunctuation
        ? config.punctuationDelay
        : config.baseInterval

      timeoutId = setTimeout(tick, nextInterval)
    }

    // Start with small delay
    timeoutId = setTimeout(tick, 100)

    return () => clearTimeout(timeoutId)
  }, [fullText, speed])

  return { streamedText, isComplete }
}

/** TurnCard wrapper that simulates streaming response */
function StreamingSimulationTurnCard({
  activities,
  intent,
  simulationSpeed = 'normal',
}: {
  activities: ActivityItem[]
  intent?: string | undefined
  simulationSpeed?: 'slow' | 'normal' | 'fast' | undefined
}) {
  const { streamedText, isComplete } = useStreamingSimulation(
    streamingTextSample,
    simulationSpeed,
  )

  const response: ResponseContent = {
    text: streamedText,
    isStreaming: !isComplete,
  }

  return (
    <TurnCard
      sessionId="playground-session"
      turnId="playground-turn"
      activities={activities}
      response={response}
      intent={intent}
      isStreaming={!isComplete}
      isComplete={isComplete}
      onOpenFile={(path) => console.log('[Playground] Open file:', path)}
      onOpenUrl={(url) => console.log('[Playground] Open URL:', url)}
    />
  )
}

export const turnCardStreamingSimEntry: ComponentEntry = {
    id: 'turn-card-streaming-sim',
    name: 'TurnCard (Streaming Sim)',
    category: 'Turn Cards',
    description: 'Live simulation of document-style streaming preview with batched fade-in updates',
    component: StreamingSimulationTurnCard,
    wrapper: PaddedWrapper,
    layout: 'top',
    props: [
      {
        name: 'simulationSpeed',
        description: 'How fast to simulate streaming',
        control: {
          type: 'select',
          options: [
            { label: 'Slow', value: 'slow' },
            { label: 'Normal', value: 'normal' },
            { label: 'Fast', value: 'fast' },
          ],
        },
        defaultValue: 'normal',
      },
      {
        name: 'intent',
        description: 'Intent text shown in header',
        control: { type: 'string', placeholder: 'e.g., Analyzing auth system...' },
        defaultValue: 'Analyzing the authentication system',
      },
    ],
    variants: [
      {
        name: 'Response Only (Slow)',
        description: 'Document preview with gradient and toggle - slow to observe cross-fade',
        props: {
          activities: [],
          simulationSpeed: 'slow',
        },
      },
      {
        name: 'After Tools (Normal)',
        description: 'Shows last few lines in large card with batched updates',
        props: {
          activities: [
            completedGrepActivity,
            completedReadActivity1,
            completedReadActivity2,
          ],
          simulationSpeed: 'normal',
          intent: 'Analyzing authentication handlers',
        },
      },
      {
        name: 'Long Content (Slow)',
        description: 'Best for observing gradient at top and cross-fade effect',
        props: {
          activities: [
            completedGrepActivity,
            completedReadActivity1,
          ],
          simulationSpeed: 'slow',
        },
      },
      {
        name: 'After Mixed (Fast)',
        description: 'Fast streaming after tools + commentary',
        props: {
          activities: [
            intermediateMessage1,
            completedGrepActivity,
            intermediateMessage2,
            completedReadActivity1,
          ],
          simulationSpeed: 'fast',
          intent: 'Searching for patterns',
        },
      },
    ],
    mockData: () => ({
      activities: [
        completedGrepActivity,
        completedReadActivity1,
      ],
    }),
  };
