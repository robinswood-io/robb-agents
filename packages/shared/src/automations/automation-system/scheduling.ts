import { PromptHandler, EventLogHandler, WebhookHandler } from "../handlers/index.ts";
import { SchedulerService, type SchedulerTickPayload } from "../../scheduler/scheduler-service.ts";
import type { AutomationSystem } from '../automation-system.ts';
import { log } from './shared.ts';

// ============================================================================
  // Handlers
  // ============================================================================

  /**
   * Create and register all handlers.
   */
export function createHandlers(transportOwner: AutomationSystem): void {
    // Prompt handler
    transportOwner["promptHandler"] = new PromptHandler({
        workspaceId: transportOwner["options"].workspaceId,
        workspaceRootPath: transportOwner["options"].workspaceRootPath,
        ...(transportOwner["options"].onPromptsReady !== undefined ? { onPromptsReady: transportOwner["options"].onPromptsReady } : {}),
        ...(transportOwner["options"].onError !== undefined ? { onError: transportOwner["options"].onError } : {}),
    }, transportOwner);
    transportOwner["promptHandler"].subscribe(transportOwner["eventBus"]);
    // Webhook handler
    transportOwner["webhookHandler"] = new WebhookHandler({
        workspaceId: transportOwner["options"].workspaceId,
        workspaceRootPath: transportOwner["options"].workspaceRootPath,
        ...(transportOwner["options"].onWebhookResults !== undefined ? { onWebhookResults: transportOwner["options"].onWebhookResults } : {}),
        ...(transportOwner["options"].onError !== undefined ? { onError: transportOwner["options"].onError } : {}),
    }, transportOwner);
    transportOwner["webhookHandler"].subscribe(transportOwner["eventBus"]);
    // Event log handler
    transportOwner["eventLogHandler"] = new EventLogHandler({
        workspaceRootPath: transportOwner["options"].workspaceRootPath,
        workspaceId: transportOwner["options"].workspaceId,
        ...(transportOwner["options"].onEventLost !== undefined ? { onEventLost: transportOwner["options"].onEventLost } : {}),
    });
    transportOwner["eventLogHandler"].subscribe(transportOwner["eventBus"]);
    log.debug(`[AutomationSystem] Handlers created and subscribed`);
}

// ============================================================================
  // Scheduler
  // ============================================================================

  /**
   * Start the scheduler service.
   */
export function startScheduler(transportOwner: AutomationSystem): void {
    if (transportOwner["scheduler"])
        return;
    transportOwner["scheduler"] = new SchedulerService(async (payload: SchedulerTickPayload) => {
        await transportOwner["eventBus"].emit('SchedulerTick', {
            workspaceId: transportOwner["options"].workspaceId,
            timestamp: Date.now(),
            localTime: payload.localTime,
            utcTime: payload.timestamp,
        });
    });
    transportOwner["scheduler"].start();
    log.debug(`[AutomationSystem] Scheduler started`);
}

export function stopScheduler(transportOwner: AutomationSystem): void {
    if (transportOwner["scheduler"]) {
        transportOwner["scheduler"].stop();
        transportOwner["scheduler"] = null;
        log.debug(`[AutomationSystem] Scheduler stopped`);
    }
}
