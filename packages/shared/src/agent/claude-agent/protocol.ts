import { type PermissionRequestType } from "../backend/types.ts";
// Plan types are used by UI components; not needed in craft-agent.ts since Safe Mode is user-controlled
// Plan types are used by UI components; not needed in craft-agent.ts since Safe Mode is user-controlled
import { type AgentError } from "../errors.ts";

export type ClaudeOnPermissionRequest = {
    requestId: string;
    toolName: string;
    toolUseId?: string;
    command?: string;
    description: string;
    type?: PermissionRequestType;
    appName?: string;
    reason?: string;
    impact?: string;
    requiresSystemPrompt?: boolean;
    rememberForMinutes?: number;
    commandHash?: string;
    approvalTtlSeconds?: number;
    sensitiveActionCategory?: import("../core/sensitive-external-action.ts").SensitiveExternalActionCategory;
    sensitiveActionTargets?: string[];
    sensitiveActionOperationHash?: string;
};

export type ClaudeOnUsageUpdate = {
    inputTokens: number;
    contextWindow?: number;
    cacheHitRate?: number;
};

export type ClaudeCheckToolPermissionResult = {
    allowed: boolean;
    updatedInput: Record<string, unknown>;
};

export type ClaudeMapSDKErrorToTypedErrorResult = {
    type: 'typed_error';
    error: AgentError;
};

export type ClaudeDetectInactiveSourceToolErrorResult = {
    sourceSlug: string;
    toolName: string;
    input: unknown;
};

export type ClaudeResolveSpawnCwdInputPayload = {
    isRetry: boolean;
    sessionId: string | null;
};
