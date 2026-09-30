import { describe, expect, it } from 'bun:test'
import { handleSessionModelChanged } from './session'
import type { SessionModelChangedEvent, SessionState } from '../types'

const state = (modelRoutePinned: boolean): SessionState => ({
  session: {
    id: 'session-1',
    workspaceId: 'workspace-1',
    workspaceName: 'Workspace',
    lastMessageAt: 1,
    isProcessing: false,
    messages: [],
    model: 'pi/gpt-5.6-sol',
    modelRoutePinned,
  },
  streaming: null,
})

describe('handleSessionModelChanged', () => {
  it('switches the renderer to automatic mode without guessing from the model', () => {
    const event: SessionModelChangedEvent = {
      type: 'session_model_changed',
      sessionId: 'session-1',
      model: 'pi/gpt-5.6-sol',
      modelRoutePinned: false,
    }

    expect(handleSessionModelChanged(state(true), event).state.session)
      .toMatchObject({ model: 'pi/gpt-5.6-sol', modelRoutePinned: false })
  })

  it('switches the renderer to manual mode for an explicit model choice', () => {
    const event: SessionModelChangedEvent = {
      type: 'session_model_changed',
      sessionId: 'session-1',
      model: 'pi/gpt-5.6-astra',
      modelRoutePinned: true,
    }

    expect(handleSessionModelChanged(state(false), event).state.session)
      .toMatchObject({ model: 'pi/gpt-5.6-astra', modelRoutePinned: true })
  })

  it('preserves the previous pin for events from an older server', () => {
    const event: SessionModelChangedEvent = {
      type: 'session_model_changed',
      sessionId: 'session-1',
      model: 'pi/gpt-5.6-sol',
    }

    expect(handleSessionModelChanged(state(true), event).state.session.modelRoutePinned)
      .toBe(true)
  })

  it('recognizes the legacy null event used to return to automatic selection', () => {
    const event: SessionModelChangedEvent = {
      type: 'session_model_changed',
      sessionId: 'session-1',
      model: null,
    }

    expect(handleSessionModelChanged(state(true), event).state.session.modelRoutePinned)
      .toBe(false)
  })
})
