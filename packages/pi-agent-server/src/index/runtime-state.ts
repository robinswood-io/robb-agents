import type http from "node:http";
import type { ModelRegistry as PiModelRegistry } from "@earendil-works/pi-coding-agent";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import type { CustomEndpointModelOverrides } from "../custom-endpoint-models.ts";
import type { createSystemPromptController } from "../system-prompt-override.ts";
import { IncompleteToolTailRecovery } from "../incomplete-tool-tail-recovery.ts";
import { ToolLoopBudget } from "../tool-loop-budget.ts";
import { SourceToolActivationController } from "../source-tool-activation.ts";
import type { PendingProxyToolExecution } from "../proxy-tool-response-watchdog.ts";
import type { InboundMessage, ProxyToolDef } from "./contracts.ts";

/** Mutable data owned by one Pi child process. */
export class PiRuntimeState {
    piSession: AgentSession | null = null;
    systemPromptController: Awaited<ReturnType<typeof createSystemPromptController>> | null = null;
    piModelRegistry: PiModelRegistry | null = null;
    moduleAuthStorage: InMemoryCredentialStore | null = null;
    unsubscribeEvents: (() => void) | null = null;
    initConfig: Extract<InboundMessage, {
        type: 'init';
    }> | null = null;
    currentUserMessage = '';
    readonly sourceToolActivation = new SourceToolActivationController();
    readonly incompleteToolTailRecovery = new IncompleteToolTailRecovery();
    readonly toolLoopBudget = new ToolLoopBudget(32, 12, 512, 1024, 0, 64, 2048, 0.05);
    readonly pendingPreToolUse = new Map<string, {
        resolve: (response: {
            action: string;
            input?: Record<string, unknown>;
            reason?: string;
        }) => void;
    }>();
    readonly pendingToolExecutions = new Map<string, PendingProxyToolExecution>();
    readonly pendingSessionToolCalls = new Map<string, {
        toolName: string;
        arguments: Record<string, unknown>;
    }>();
    proxyToolDefs: ProxyToolDef[] = [];
    toolsChanged = false;
    callbackServer: http.Server | null = null;
    callbackPort = 0;
    customEndpointModelIds: Set<string> = new Set();
    readonly customModelOverrides = new Map<string, CustomEndpointModelOverrides>();
    lastNativeSettlement: Extract<AgentSessionEvent, {
        type: 'agent_settled';
    }> = { type: 'agent_settled', aborted: false };
    overflowRecoveryAttempted = false;
    readonly sdkMessageCorrelations = new WeakMap<object, string>();
}
