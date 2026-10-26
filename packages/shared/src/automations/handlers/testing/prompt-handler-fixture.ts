import type { AutomationsConfigProvider, PromptHandlerOptions } from "../types.ts";

import type { AutomationMatcher, AutomationEvent } from "../../index.ts";



// Helper to create a mock AutomationsConfigProvider
export function createMockConfigProvider(matchersByEvent: Partial<Record<AutomationEvent, AutomationMatcher[]>> = {}): AutomationsConfigProvider {
  return {
    getConfig: () => ({ automations: matchersByEvent }),
    getMatchersForEvent: (event: AutomationEvent) => matchersByEvent[event] ?? [],
  };
}

// Helper to create default options
export function createOptions(overrides: Partial<PromptHandlerOptions> = {}): PromptHandlerOptions {
  return {
    workspaceId: 'test-workspace',
    workspaceRootPath: '/mock/workspace',
    sessionId: 'test-session',
    ...overrides,
  };
}
