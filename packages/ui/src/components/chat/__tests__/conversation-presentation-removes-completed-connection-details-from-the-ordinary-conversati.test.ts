import { describe, expect, it } from "bun:test";
import { projectConversation } from "../conversation-presentation";
import { message, user } from "./testing/conversation-presentation-fixture.ts";

describe('resolved connection requests', () => {
  it('removes completed connection details from the ordinary conversation', () => {
    const result = projectConversation([user,
      message('auth2', 'auth-request', { authStatus: 'completed', content: 'Connected account details' }),
      message('a3', 'assistant', { content: 'Voici votre réponse.' }),
    ], { isProcessing: false })
    expect(result.turns.map(turn => turn.type)).toEqual(['user', 'assistant'])
    expect(result.outcome).toBeUndefined()
  })

  it('summarizes a failed connection without exposing its technical error', () => {
    const result = projectConversation([user,
      message('auth2', 'auth-request', { authStatus: 'failed', content: 'OAuth stack trace' }),
    ], { isProcessing: false })
    expect(result.turns.map(turn => turn.type)).toEqual(['user'])
    expect(result.outcome).toMatchObject({ state: 'failed', hasFinalResponse: false })
  })
});
