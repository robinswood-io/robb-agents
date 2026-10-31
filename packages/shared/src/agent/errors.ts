/** Provider errors: definitions, proxy diagnostics and classification. */
export type { ErrorCode } from "@craft-agent/core/types";
export type { ProviderInfo, RecoveryAction, AgentError } from './errors/definitions.ts';
export { parseError, isBillingError, canAutoRetry, parseSDKErrorText, isSDKErrorText } from './errors/classification.ts';
