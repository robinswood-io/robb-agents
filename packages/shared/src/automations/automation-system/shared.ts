import { createLogger } from "../../utils/debug.ts";
import { type AutomationEvent, type PendingPrompt, type WebhookActionResult } from "../types.ts";

export const log = createLogger('automation-system');

// ============================================================================
// AutomationSystem Options
// ============================================================================
export interface AutomationSystemOptions {
    /** Workspace root path (where automations.json lives) */
    workspaceRootPath: string;
    /** Workspace ID for logging and events */
    workspaceId: string;
    /** Working directory for command execution */
    workingDir?: string;
    /** Active source slugs for permission rules */
    activeSourceSlugs?: string[];
    /** Whether to start the scheduler service (default: false) */
    enableScheduler?: boolean;
    /** Called when prompts are ready to be executed */
    onPromptsReady?: (prompts: PendingPrompt[]) => void;
    /** Called when webhook results are available */
    onWebhookResults?: (results: WebhookActionResult[]) => void;
    /** Called when an error occurs during automation execution */
    onError?: (event: AutomationEvent, error: Error) => void;
    /** Called when events are lost after retries */
    onEventLost?: (events: string[], error: Error) => void;
}
