/**
 * Typed errors for better error handling and user-friendly messages.
 *
 * These error types map HTTP status codes and error patterns to
 * actionable error information that can be displayed to users.
 *
 * The `ErrorCode` union is owned by `@craft-agent/core` so the wire
 * format (which crosses package boundaries) stays in one place; this
 * file owns the user-facing text and recovery actions for each code.
 */
import type { ErrorCode } from "@craft-agent/core/types";
import { getProviderMetadata } from "../../config/provider-metadata.ts";
import { InvalidWorkingDirectoryError } from "../spawn-helpers.ts";
import type { AgentError } from './definitions.ts';
import { ERROR_DEFINITIONS } from './definitions.ts';
import { buildProxyErrorMessage, extractErrorMessages, hasRuntimeBridgeErrorContext, isLikelyProxyInterception } from './proxy-diagnostics.ts';

/**
 * Parse an error and return a typed AgentError with user-friendly info
 */
export function parseError(
  error: unknown,
  providerContext?: { providerType?: string; piAuthProvider?: string },
): AgentError {
  if (error instanceof InvalidWorkingDirectoryError) {
    return {
      code: 'sdk_cwd_missing',
      title: 'Working directory unavailable on this host',
      message: error.message,
      actions: [],
      canRetry: false,
      originalError: error.message,
    };
  }

  // Extract all error messages including nested causes and subprocess output
  const fullErrorText = extractErrorMessages(error);
  const errorMessage = error instanceof Error ? error.message : String(error);
  const lowerMessage = fullErrorText.toLowerCase();

  // Detect error type from message/status
  let code: ErrorCode = 'unknown_error';

  // Check for OpenRouter data policy errors first (these contain "no endpoints" which could confuse other checks)
  if (lowerMessage.includes('data policy') || lowerMessage.includes('privacy')) {
    code = 'data_policy_error';
  // Check for model-specific errors (OpenRouter, etc.)
  // Tool support errors must be checked BEFORE model errors since tool errors often contain "model"
  } else if (
    lowerMessage.includes('no endpoints found that support tool use') ||
    lowerMessage.includes('does not support tool') ||
    lowerMessage.includes('tool_use is not supported') ||
    lowerMessage.includes('function calling not available') ||
    lowerMessage.includes('tools are not supported') ||
    lowerMessage.includes('doesn\'t support tool') ||
    lowerMessage.includes('tool use is not supported')
    // NOTE: do NOT match on `invalid_request_error + tool` or `tool + not + support`
    // alone. Anthropic 400 errors frequently mention `tools` (e.g. the cache_control
    // ordering error "blocks are processed in the following order: `tools`, `system`,
    // `messages`") which would otherwise be misclassified as "Model Does Not Support
    // Tools". The specific phrases above are tight enough to catch real tool-support
    // refusals without these broad fallbacks.
  ) {
    code = 'model_no_tool_support';
  } else if (lowerMessage.includes('is not a valid model') || lowerMessage.includes('model not found') || lowerMessage.includes('invalid model') || lowerMessage.includes('model identifier is invalid')) {
    code = 'invalid_model';
  } else if (hasRuntimeBridgeErrorContext(lowerMessage)) {
    code = 'execution_bridge_unavailable';
  // HTML-intercepted responses (proxy/firewall/captive portal).
  // Must be checked BEFORE status codes: a 502 Cloudflare page or 401 proxy login
  // page would otherwise be misclassified as service_error or invalid_api_key.
  } else if (isLikelyProxyInterception(lowerMessage)) {
    code = 'proxy_error';
  // Check for specific HTTP status codes or patterns
  } else if (lowerMessage.includes('402') || lowerMessage.includes('payment required')) {
    code = 'billing_error';
  } else if (lowerMessage.includes('401') || lowerMessage.includes('unauthorized') || lowerMessage.includes('invalid api key') || lowerMessage.includes('invalid x-api-key') || lowerMessage.includes('authentication failed') || lowerMessage.includes('token is expired') || lowerMessage.includes('token expired')) {
    // Distinguish between API key and OAuth errors
    if (lowerMessage.includes('oauth') || lowerMessage.includes('token') || lowerMessage.includes('session')) {
      code = 'expired_oauth_token';
    } else {
      code = 'invalid_api_key';
    }
  } else if (lowerMessage.includes('429') || lowerMessage.includes('rate limit') || lowerMessage.includes('too many requests')) {
    code = 'rate_limited';
  } else if (
    lowerMessage.includes('500') ||
    lowerMessage.includes('502') ||
    lowerMessage.includes('503') ||
    lowerMessage.includes('504') ||
    lowerMessage.includes('internal server error') ||
    lowerMessage.includes('service unavailable') ||
    lowerMessage.includes('server_error') ||
    lowerMessage.includes('an unexpected error has occurred') ||
    lowerMessage.includes('an unexpected error occurred') ||
    (
      lowerMessage.includes('an error occurred while processing your request') &&
      lowerMessage.includes('request id')
    )
  ) {
    code = 'service_error';
  } else if (lowerMessage.includes('network') || lowerMessage.includes('econnrefused') || lowerMessage.includes('enotfound') || lowerMessage.includes('fetch failed') || lowerMessage.includes('connection')) {
    code = 'network_error';
  } else if (lowerMessage.includes('mcp') && (lowerMessage.includes('auth') || lowerMessage.includes('401'))) {
    code = 'mcp_auth_required';
  } else if (
    lowerMessage.includes('image') &&
    (lowerMessage.includes('dimension') || lowerMessage.includes('8000') || lowerMessage.includes('5mb')) &&
    (lowerMessage.includes('exceed') || lowerMessage.includes('too large'))
  ) {
    code = 'image_too_large';
  } else if (lowerMessage.includes('exited with code') || lowerMessage.includes('process exited')) {
    // SDK subprocess crashed - likely auth/setup issue
    // Check if the error contains more specific info
    if (lowerMessage.includes('api') || lowerMessage.includes('key') || lowerMessage.includes('credential')) {
      code = 'invalid_api_key';
    } else {
      code = 'service_error';
    }
  } else if (lowerMessage.includes('invalid_request_error') || lowerMessage.includes('400 ')) {
    // Generic Anthropic-style API validation failures (cache_control ordering, malformed
    // payloads, etc.). Lands here only after all the more specific branches above have
    // declined; better than falling through to "unknown_error" which hides the message.
    code = 'invalid_request';
  }

  // ErrorCode is a finite union and ERROR_DEFINITIONS covers every member,
  // so the lookup is exhaustive — non-null assert to satisfy the
  // noUncheckedIndexedAccess compiler option after the cross-module import.
  const definition = ERROR_DEFINITIONS[code]!;

  // Resolve provider info from context
  const providerInfo = providerContext
    ? getProviderMetadata(
        providerContext.providerType ?? 'anthropic',
        providerContext.piAuthProvider,
      ) ?? undefined
    : undefined;

  // For proxy_error, prefer safe user-facing text over raw HTML payloads.
  if (code === 'proxy_error') {
    const definitionWithoutOverrides = { ...definition };
    delete definitionWithoutOverrides.providerInfo;
    return {
      code,
      ...definitionWithoutOverrides,
      message: buildProxyErrorMessage(errorMessage, fullErrorText),
      originalError: errorMessage,
      ...(providerInfo !== undefined ? { providerInfo } : {}),
    };
  }

  // For model_no_tool_support errors, try to extract the model name for a more helpful message
  if (code === 'model_no_tool_support') {
    // Try to extract model name from various error message formats
    // Common patterns: "model: xxx", "model 'xxx'", "model \"xxx\"", "model xxx does not"
    const modelMatch = fullErrorText.match(/model[:\s]+["']?([a-zA-Z0-9\-_/:.]+)["']?/i) ||
                       fullErrorText.match(/["']([a-zA-Z0-9\-_/:.]+)["']\s+does not support/i);
    if (modelMatch?.[1]) {
      const definitionWithoutOverrides2 = { ...definition };
      delete definitionWithoutOverrides2.providerInfo;
      return {
        code,
        ...definitionWithoutOverrides2,
        message: `Model "${modelMatch[1]}" does not support tool/function calling, which is required for Robb Agents. Please choose a different model with tool support in Settings.`,
        originalError: errorMessage,
        ...(providerInfo !== undefined ? { providerInfo } : {}),
      };
    }
  }

  const definitionWithoutOverrides3 = { ...definition };
  delete definitionWithoutOverrides3.providerInfo;
  return {
    code,
    ...definitionWithoutOverrides3,
    originalError: errorMessage,
    ...(providerInfo !== undefined ? { providerInfo } : {}),
  };
}

/**
 * Check if an error is a billing/auth error that blocks usage
 */
export function isBillingError(error: AgentError): boolean {
  return error.code === 'billing_error' || error.code === 'invalid_api_key' || error.code === 'expired_oauth_token';
}

/**
 * Check if an error can be automatically retried
 */
export function canAutoRetry(error: AgentError): boolean {
  return error.canRetry && error.retryDelayMs !== undefined;
}

/**
 * Parse SDK error text and return a typed AgentError if detected.
 *
 * The SDK emits errors in two distinctive formats:
 * 1. "Error title · Action hint" - using middle dot (·, U+00B7) separator
 *    e.g., "Invalid API key · Fix external API key"
 * 2. "API Error: {status} {json}" - raw API error dump
 *    e.g., "API Error: 402 {"error":{"code":402,"message":"Payment required"}}"
 *
 * Returns null if text is not an SDK error.
 */
export function parseSDKErrorText(text: string): AgentError | null {
  const trimmed = text.trim();
  const isSingleLine = !trimmed.includes('\n');
  const isShortMessage = trimmed.length < 200;

  // Format 1: Raw API error (e.g., "API Error: 402 {...}")
  // Extract status code and use it to determine error type
  if (trimmed.startsWith('API Error:') && isSingleLine) {
    const statusMatch = trimmed.match(/API Error:\s*(\d{3})/);
    if (statusMatch) {
      const statusCode = parseInt(statusMatch[1]!, 10);
      // Create error message with status code for parseError to detect
      return parseError(new Error(`${statusCode} ${trimmed}`));
    }
    // Fallback: just use the raw message
    return parseError(new Error(trimmed));
  }

  // Format 2: Middle dot separator (e.g., "Invalid API key · Fix external API key")
  if (trimmed.includes(' · ') && isShortMessage && isSingleLine) {
    // The text before · is the error title, use it for parsing
    return parseError(new Error(trimmed));
  }

  return null;
}

/**
 * Quick check if text looks like an SDK error (for filtering).
 */
export function isSDKErrorText(text: string): boolean {
  return parseSDKErrorText(text) !== null;
}
