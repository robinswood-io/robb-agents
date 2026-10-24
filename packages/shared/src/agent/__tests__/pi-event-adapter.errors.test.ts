import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentEvent } from '@craft-agent/core/types';
import { collect, recordedPiEvent, eventOfType } from './fixtures/pi-event-fixtures.ts';
import { PiEventAdapter } from '../backend/pi/event-adapter.ts';
import { toolMetadataStore } from '../../interceptor-common.ts';

describe('PiEventAdapter — errors', () => {
let adapter: PiEventAdapter;

let sessionDir: string;

beforeEach(() => {
    adapter = new PiEventAdapter();
    sessionDir = mkdtempSync(join(tmpdir(), 'pi-adapter-'));
    adapter.setSessionDir(sessionDir);
    toolMetadataStore.setSessionDir(sessionDir);
    adapter.startTurn();
  });

afterEach(() => {
    toolMetadataStore._clearForTesting();
    rmSync(sessionDir, { recursive: true, force: true });
  });

describe('error surfacing', () => {
    function terminateAssistantError(errorMessage: string): AgentEvent[] {
      const attemptEvents = collect(adapter.adaptEvent(recordedPiEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'error',
          errorMessage,
        },
      })));
      expect(attemptEvents).toHaveLength(0);
      return collect(adapter.adaptEvent(recordedPiEvent({ type: 'agent_end', willRetry: false })));
    }

    it('should emit plain error for unclassified error messages', () => {
      const events = terminateAssistantError('Something went wrong internally');

      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({
        type: 'error',
        message: 'Something went wrong internally',
      });
      expect(events[1]).toEqual({ type: 'complete' });
    });

    it('should emit typed_error for raw HTML proxy pages', () => {
      const events = terminateAssistantError('<html><head><title>400 Bad Request</title></head><body><center><h1>400 Bad Request</h1></center><hr><center>cloudflare</center></body></html>');

      expect(events).toHaveLength(2);
      expect(events[0]?.type).toBe('typed_error');
      expect(eventOfType(events[0], 'typed_error').error.code).toBe('proxy_error');
      expect(eventOfType(events[0], 'typed_error').error.message.toLowerCase()).not.toContain('<html');
    });

    it('should emit typed_error for auth-expiry error messages', () => {
      const events = terminateAssistantError('Provided authentication token is expired. Please try signing in again.');

      expect(events).toHaveLength(2);
      expect(events[0]?.type).toBe('typed_error');
      expect(eventOfType(events[0], 'typed_error').error.code).toBe('expired_oauth_token');
    });

    it('should emit typed_error for 401 unauthorized errors', () => {
      const events = terminateAssistantError('401 Unauthorized');

      expect(events).toHaveLength(2);
      expect(events[0]?.type).toBe('typed_error');
      expect(eventOfType(events[0], 'typed_error').error.code).toBe('invalid_api_key');
    });

    it('should emit typed_error for billing/402 errors', () => {
      const events = terminateAssistantError('402 Payment required');

      expect(events).toHaveLength(2);
      expect(events[0]?.type).toBe('typed_error');
      expect(eventOfType(events[0], 'typed_error').error.code).toBe('billing_error');
    });

    it('should emit typed_error for rate limit errors', () => {
      const events = terminateAssistantError('429 Too many requests - rate limit exceeded');

      expect(events).toHaveLength(2);
      expect(events[0]?.type).toBe('typed_error');
      expect(eventOfType(events[0], 'typed_error').error.code).toBe('rate_limited');
    });

    it('should not emit error without errorMessage even if stopReason is error', () => {
      collect(adapter.adaptEvent(recordedPiEvent({ type: 'turn_start' })));
      const events = collect(adapter.adaptEvent(recordedPiEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'error',
          // No errorMessage — fall through to normal text extraction
          content: 'Some partial content',
        },
      })));

      // Should emit as text_complete, not error
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe('text_complete');
    });
  });

describe('provider retry recovery', () => {
    const firstError = 'Codex error: An error occurred while processing your request. Please include the request ID first-request-id in your message.';
    const finalError = 'Codex error: An error occurred while processing your request. Please include the request ID final-request-id in your message.';

    it('keeps the queue open and suppresses an attempt error when a retry succeeds', () => {
      collect(adapter.adaptEvent(recordedPiEvent({ type: 'turn_start' })));

      const attemptError = collect(adapter.adaptEvent(recordedPiEvent({
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'error', errorMessage: firstError },
      })));
      expect(attemptError).toHaveLength(0);

      const retryingAgentEnd = collect(adapter.adaptEvent(recordedPiEvent({
        type: 'agent_end',
        willRetry: true,
      })));
      expect(retryingAgentEnd).toHaveLength(0);
      expect(adapter.shouldCompleteQueue(true)).toBe(false);

      const retryStatus = collect(adapter.adaptEvent(recordedPiEvent({
        type: 'auto_retry_start',
        attempt: 1,
        maxAttempts: 3,
        delayMs: 2_000,
        errorMessage: firstError,
      })));
      expect(retryStatus).toMatchObject([{ type: 'status', message: 'Retrying (attempt 1/3)...' }]);

      const recovered = collect(adapter.adaptEvent(recordedPiEvent({
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'stop', content: 'Recovered answer' },
      })));
      expect(recovered).toMatchObject([{ type: 'text_complete', text: 'Recovered answer' }]);
      expect(collect(adapter.adaptEvent(recordedPiEvent({ type: 'auto_retry_end', success: true, attempt: 1 })))).toHaveLength(0);

      const completed = collect(adapter.adaptEvent(recordedPiEvent({ type: 'agent_end', willRetry: false })));
      expect(completed).toMatchObject([{ type: 'complete' }]);
      expect(adapter.shouldCompleteQueue(true)).toBe(true);

      const allEvents = [...attemptError, ...retryingAgentEnd, ...retryStatus, ...recovered, ...completed];
      expect(allEvents.filter(event => event.type === 'error' || event.type === 'typed_error')).toHaveLength(0);
    });

    it('surfaces only the final Codex request ID after retries are exhausted', () => {
      collect(adapter.adaptEvent(recordedPiEvent({ type: 'turn_start' })));

      collect(adapter.adaptEvent(recordedPiEvent({
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'error', errorMessage: firstError },
      })));
      collect(adapter.adaptEvent(recordedPiEvent({ type: 'agent_end', willRetry: true })));
      expect(adapter.shouldCompleteQueue(true)).toBe(false);

      collect(adapter.adaptEvent(recordedPiEvent({
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'error', errorMessage: finalError },
      })));
      const terminal = collect(adapter.adaptEvent(recordedPiEvent({ type: 'agent_end', willRetry: false })));

      expect(terminal).toHaveLength(2);
      expect(terminal[0]).toMatchObject({
        type: 'typed_error',
        error: {
          code: 'service_error',
          canRetry: true,
          originalError: finalError,
        },
      });
      expect(terminal[1]).toEqual({ type: 'complete' });
      expect(JSON.stringify(terminal)).not.toContain('first-request-id');
      expect(adapter.shouldCompleteQueue(true)).toBe(true);
    });
  });
});
