// LLM tool types
import { type LLMQueryResult } from "../llm-tool.ts";
import type { PiSubprocessRuntimeContext } from './shared.ts';

export type PiPendingPermissions = {
    resolve: (allowed: boolean) => void;
    toolName: string;
};

export type PiPendingToolExecutions = {
    resolve: (result: {
        content: string;
        isError: boolean;
    }) => void;
    reject: (error: Error) => void;
};

export type PiPendingMiniCompletions = {
    resolve: (text: string | null) => void;
    reject: (error: Error) => void;
};

export type PiPendingLlmQueries = {
    resolve: (result: LLMQueryResult) => void;
    reject: (error: Error) => void;
};

export type PiPendingEnsureSessionReady = {
    resolve: (sessionId: string | null) => void;
    reject: (error: Error) => void;
};

export type PiPendingCompactions = {
    resolve: (result: {
        summary: string;
        firstKeptEntryId: string;
        tokensBefore: number;
        estimatedTokensAfter?: number;
        compactionModel?: string;
    } | null) => void;
    reject: (error: Error) => void;
};

export type PiPendingAutoCompactionToggles = {
    resolve: (enabled: boolean) => void;
    reject: (error: Error) => void;
};

export type PiPendingRuntimeConfigUpdates = {
    resolve: (updated: boolean) => void;
    reject: (error: Error) => void;
};

export type PiPreToolMetadataByCallId = {
    intent?: string;
    displayName?: string;
    capturedAt: number;
};

export type PiBuildAwsEnvRuntimePayload = {
    piAuthProvider?: string;
};

export type PiBuildProviderEnvRuntimePayload = {
    piAuthProvider?: string;
    googleCloudProject?: string;
};

export type PiPreToolUseRequest = {
    requestId: string;
    toolName: string;
    toolCallId?: string;
    input: Record<string, unknown>;
};

export type PiPreToolUsePrompt = {
    type: 'prompt';
};

export type PiSendPreToolUseDecisionRequestPayload = {
    requestId: string;
    toolName: string;
    toolCallId?: string;
    originalInput: Record<string, unknown>;
    runtimeContext?: PiSubprocessRuntimeContext;
    authorizationEpoch: number;
};

export type PiToolExecuteRequest = {
    requestId: string;
    toolName: string;
    toolCallId?: string;
    args: Record<string, unknown>;
};

export type PiSessionToolResult = {
    content: string;
    isError: boolean;
};

export type PiCompactionResult = {
    summary: string;
    firstKeptEntryId: string;
    tokensBefore: number;
    estimatedTokensAfter?: number;
    compactionModel?: string;
};
