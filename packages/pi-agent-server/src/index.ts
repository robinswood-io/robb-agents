#!/usr/bin/env node
import { createInterface } from "node:readline";
import { storePiCredential } from "./authenticated-model-runtime.ts";
import { setBedrockProviderModule } from "@earendil-works/pi-ai/api/bedrock-converse-stream.lazy";
import { bedrockProviderModule } from "@earendil-works/pi-ai/bedrock-provider";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { applyTokenUpdate } from "./token-update.ts";
import type { InboundMessage } from "./index/contracts.ts";
import { PiRuntimeState } from "./index/runtime-state.ts";
import { handleAbortCompaction, handleCompact, handleEnsureSessionReady, handleSetAutoCompaction, handleSetModel, handleSetThinkingLevel, handleUpdateRuntimeConfig } from "./index/controls.ts";
import { isLocalhostUrl, isStrictLocalEndpointMode } from "./index/endpoints.ts";
import { handlePreToolUseResponse, handlePrompt, handleRegisterTools, handleToolExecuteResponse } from "./index/prompts.ts";
import { handleLlmQuery, handleMiniCompletion } from "./index/queries.ts";
import { handleAbort, handleInit, handleShutdown } from "./index/session.ts";
import { debugLog, send } from "./index/stdio.ts";

setBedrockProviderModule(bedrockProviderModule);
registerBunOAuthFlows();

const runtimeState = new PiRuntimeState();

// Install process-level outbound fetch guard for strict local model sessions.
{
    const baseFetch = globalThis.fetch;
    const guardedFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url = typeof input === 'string'
            ? input
            : input instanceof URL
                ? input.toString()
                : input.url;
        if ((isStrictLocalEndpointMode(runtimeState) || process.env["CRAFT_STRICT_LOCAL_ENDPOINT"] === '1')
            && process.env["ROBB_ALLOW_LOCAL_MODEL_WEB_TOOLS"] !== '1'
            && !isLocalhostUrl(url)) {
            throw new Error(`[Privacy Guard] Blocked outbound network request to "${url}" in strict local model mode. Set ROBB_ALLOW_LOCAL_MODEL_WEB_TOOLS=1 to allow external network access.`);
        }
        return baseFetch(input, init);
    };
    globalThis.fetch = new Proxy(baseFetch, {
        apply(_target, _thisArg: unknown, args: Parameters<typeof baseFetch>) {
            return guardedFetch(...args);
        },
    });
}

// ============================================================
// Main JSONL Reader Loop
// ============================================================
async function processMessage(runtimeState: PiRuntimeState, msg: InboundMessage): Promise<void> {
    switch (msg.type) {
        case 'init':
            await handleInit(runtimeState, msg);
            break;
        case 'prompt':
            await handlePrompt(runtimeState, msg);
            break;
        case 'register_tools':
            handleRegisterTools(runtimeState, msg);
            break;
        case 'tool_execute_response':
            handleToolExecuteResponse(runtimeState, msg);
            break;
        case 'pre_tool_use_response':
            handlePreToolUseResponse(runtimeState, msg);
            break;
        case 'abort':
            await handleAbort(runtimeState);
            break;
        case 'mini_completion':
            await handleMiniCompletion(runtimeState, msg);
            break;
        case 'llm_query':
            await handleLlmQuery(runtimeState, msg);
            break;
        case 'ensure_session_ready':
            await handleEnsureSessionReady(runtimeState, msg);
            break;
        case 'set_model':
            await handleSetModel(runtimeState, msg);
            break;
        case 'set_thinking_level':
            await handleSetThinkingLevel(runtimeState, msg);
            break;
        case 'compact':
            await handleCompact(runtimeState, msg);
            break;
        case 'abort_compaction':
            handleAbortCompaction(runtimeState, msg);
            break;
        case 'set_auto_compaction':
            await handleSetAutoCompaction(runtimeState, msg);
            break;
        case 'update_runtime_config':
            await handleUpdateRuntimeConfig(runtimeState, msg);
            break;
        case 'steer':
            if (runtimeState.piSession) {
                debugLog(`Steering with: "${msg.message.slice(0, 100)}"`);
                await runtimeState.piSession.steer(msg.message);
            }
            else {
                debugLog('Steer ignored — no active session');
            }
            break;
        case 'token_update':
            if (await applyTokenUpdate(msg.piAuth, runtimeState.initConfig, runtimeState.moduleAuthStorage ? (provider, credential) => storePiCredential(runtimeState.moduleAuthStorage!, provider, credential)
                : undefined)) {
                debugLog(`Updated ${msg.piAuth.credential.type} credential for provider: ${msg.piAuth.provider}`);
            }
            else {
                debugLog('token_update stored for registry initialization');
            }
            break;
        case 'shutdown':
            handleShutdown(runtimeState);
            break;
        default: {
            const unrecognizedMessage: {
                type?: unknown;
            } = msg;
            debugLog(`Unknown message type: ${unrecognizedMessage.type}`);
        }
    }
}

function main(runtimeState: PiRuntimeState): void {
    debugLog('Pi agent server starting');
    const rl = createInterface({ input: process.stdin });
    rl.on('line', (line: string) => {
        if (!line.trim())
            return;
        try {
            const msg = JSON.parse(line) as InboundMessage;
            processMessage(runtimeState, msg).catch((error: unknown) => {
                const errorMsg = error instanceof Error ? error.message : String(error);
                debugLog(`Error processing message: ${errorMsg}`);
                send({ type: 'error', message: errorMsg });
            });
        }
        catch (parseError) {
            debugLog(`Failed to parse JSONL: ${parseError}`);
        }
    });
    rl.on('close', () => {
        debugLog('stdin closed, shutting down');
        handleShutdown(runtimeState);
    });
    // Handle unexpected errors — process state is unreliable after these,
    // so we attempt to report and then exit immediately.
    // send() is wrapped in try/catch because stdout itself may be broken
    // (e.g. EFAULT from a closed pipe), and we must not let the error
    // report trigger another uncaughtException (which would loop).
    process.on('uncaughtException', (error) => {
        debugLog(`Uncaught exception: ${error.message}`);
        try {
            send({ type: 'error', message: `Uncaught exception: ${error.message}`, code: 'uncaught' });
        }
        catch {
            // stdout may be broken — swallow to avoid re-triggering
        }
        process.exit(1);
    });
    process.on('unhandledRejection', (reason) => {
        const msg = reason instanceof Error ? reason.message : String(reason);
        debugLog(`Unhandled rejection: ${msg}`);
        try {
            send({ type: 'error', message: `Unhandled rejection: ${msg}`, code: 'unhandled_rejection' });
        }
        catch {
            // stdout may be broken — swallow to avoid re-triggering
        }
        process.exit(1);
    });
}

main(runtimeState);
