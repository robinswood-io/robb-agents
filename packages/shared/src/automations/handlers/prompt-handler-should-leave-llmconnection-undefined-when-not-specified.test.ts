/**
 * Tests for PromptHandler
 */
import { describe, it, expect, beforeEach, afterEach, jest } from 'bun:test';
import { WorkspaceEventBus } from '../event-bus.ts';
import { PromptHandler } from './prompt-handler.ts';
import type { PendingPrompt } from '../index.ts';
import { createMockConfigProvider, createOptions } from "./testing/prompt-handler-fixture.ts";


describe('PromptHandler', () => {
let bus: WorkspaceEventBus;

beforeEach(() => {
    bus = new WorkspaceEventBus('test-workspace');
  });

afterEach(() => {
    bus.dispose();
  });

describe('llmConnection passthrough', () => {
it('should leave llmConnection undefined when not specified', async () => {
      const onPromptsReady = jest.fn<(prompts: PendingPrompt[]) => void>();
      const configProvider = createMockConfigProvider({
        LabelAdd: [{
          actions: [{
            type: 'prompt',
            prompt: 'Create a source',
          }],
        }],
      });

      const handler = new PromptHandler(createOptions({ onPromptsReady }), configProvider);
      handler.subscribe(bus);

      await bus.emit('LabelAdd', {
        workspaceId: 'test-workspace',
        timestamp: Date.now(),
        label: 'test',
      });

      expect(onPromptsReady).toHaveBeenCalledTimes(1);
      const prompts: PendingPrompt[] = onPromptsReady.mock.calls[0]![0];
      expect(prompts[0]!.llmConnection).toBeUndefined();

      handler.dispose();
    });
});

describe('model passthrough', () => {
it('should pass model from prompt action to pending prompt', async () => {
      const onPromptsReady = jest.fn<(prompts: PendingPrompt[]) => void>();
      const configProvider = createMockConfigProvider({
        LabelAdd: [{
          actions: [{
            type: 'prompt',
            prompt: 'Quick review',
            model: 'claude-sonnet-4-6',
          }],
        }],
      });

      const handler = new PromptHandler(createOptions({ onPromptsReady }), configProvider);
      handler.subscribe(bus);

      await bus.emit('LabelAdd', {
        workspaceId: 'test-workspace',
        timestamp: Date.now(),
        label: 'test',
      });

      expect(onPromptsReady).toHaveBeenCalledTimes(1);
      const prompts: PendingPrompt[] = onPromptsReady.mock.calls[0]![0];
      expect(prompts[0]!.model).toBe('claude-sonnet-4-6');

      handler.dispose();
    });

it('should leave model undefined when not specified', async () => {
      const onPromptsReady = jest.fn<(prompts: PendingPrompt[]) => void>();
      const configProvider = createMockConfigProvider({
        LabelAdd: [{
          actions: [{
            type: 'prompt',
            prompt: 'Quick review',
          }],
        }],
      });

      const handler = new PromptHandler(createOptions({ onPromptsReady }), configProvider);
      handler.subscribe(bus);

      await bus.emit('LabelAdd', {
        workspaceId: 'test-workspace',
        timestamp: Date.now(),
        label: 'test',
      });

      expect(onPromptsReady).toHaveBeenCalledTimes(1);
      const prompts: PendingPrompt[] = onPromptsReady.mock.calls[0]![0];
      expect(prompts[0]!.model).toBeUndefined();

      handler.dispose();
    });
});

describe('automationName propagation', () => {
it('should set automationName from matcher.name when provided', async () => {
      const onPromptsReady = jest.fn<(prompts: PendingPrompt[]) => void>();
      const configProvider = createMockConfigProvider({
        LabelAdd: [{
          name: 'Daily Triage',
          actions: [{ type: 'prompt', prompt: 'Review issues' }],
        }],
      });

      const handler = new PromptHandler(createOptions({ onPromptsReady }), configProvider);
      handler.subscribe(bus);

      await bus.emit('LabelAdd', {
        workspaceId: 'test-workspace',
        timestamp: Date.now(),
        label: 'test',
      });

      expect(onPromptsReady).toHaveBeenCalledTimes(1);
      const prompts: PendingPrompt[] = onPromptsReady.mock.calls[0]![0];
      expect(prompts[0]!.automationName).toBe('Daily Triage');

      handler.dispose();
    });

it('should derive automationName from @mention when matcher has no name', async () => {
      const onPromptsReady = jest.fn<(prompts: PendingPrompt[]) => void>();
      const configProvider = createMockConfigProvider({
        LabelAdd: [{
          actions: [{ type: 'prompt', prompt: '@linear check for issues' }],
        }],
      });

      const handler = new PromptHandler(createOptions({ onPromptsReady }), configProvider);
      handler.subscribe(bus);

      await bus.emit('LabelAdd', {
        workspaceId: 'test-workspace',
        timestamp: Date.now(),
        label: 'test',
      });

      expect(onPromptsReady).toHaveBeenCalledTimes(1);
      const prompts: PendingPrompt[] = onPromptsReady.mock.calls[0]![0];
      expect(prompts[0]!.automationName).toBe('linear prompt');

      handler.dispose();
    });

it('should derive automationName from prompt text when no name or @mention', async () => {
      const onPromptsReady = jest.fn<(prompts: PendingPrompt[]) => void>();
      const configProvider = createMockConfigProvider({
        LabelAdd: [{
          actions: [{ type: 'prompt', prompt: 'Review the code' }],
        }],
      });

      const handler = new PromptHandler(createOptions({ onPromptsReady }), configProvider);
      handler.subscribe(bus);

      await bus.emit('LabelAdd', {
        workspaceId: 'test-workspace',
        timestamp: Date.now(),
        label: 'test',
      });

      expect(onPromptsReady).toHaveBeenCalledTimes(1);
      const prompts: PendingPrompt[] = onPromptsReady.mock.calls[0]![0];
      expect(prompts[0]!.automationName).toBe('Review the code');

      handler.dispose();
    });
});

describe('dispose', () => {
it('should unsubscribe from the event bus', () => {
      const configProvider = createMockConfigProvider();
      const handler = new PromptHandler(createOptions(), configProvider);

      handler.subscribe(bus);
      expect(bus.getHandlerCount()).toBe(1);

      handler.dispose();
      expect(bus.getHandlerCount()).toBe(0);
    });

it('should not process events after disposal', async () => {
      const onPromptsReady = jest.fn<(prompts: PendingPrompt[]) => void>();
      const configProvider = createMockConfigProvider({
        LabelAdd: [{
          actions: [{ type: 'prompt', prompt: 'Should not fire' }],
        }],
      });

      const handler = new PromptHandler(createOptions({ onPromptsReady }), configProvider);
      handler.subscribe(bus);
      handler.dispose();

      await bus.emit('LabelAdd', {
        workspaceId: 'test-workspace',
        timestamp: Date.now(),
        label: 'test',
      });

      expect(onPromptsReady).not.toHaveBeenCalled();
    });
});
});
