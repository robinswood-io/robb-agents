import { z } from 'zod';

// Validate only the fields consumed by recovery assertions. Preserve every other
// persisted field; do not apply defaults, migrations or permission normalization.
const recovery = z.object({
  recoveryDispatch: z.object({
    id: z.string(),
    attempt: z.number(),
    phase: z.string(),
    cleanContinuationId: z.string().optional(),
    fallbackIntent: z.unknown().optional(),
  }).passthrough().optional(),
  explicitRetryAllowances: z.unknown().optional(),
  budgetHistoryUnavailable: z.boolean().optional(),
}).passthrough();

const metadata = {
  hidden: z.boolean().optional(),
  internalOrigin: z.unknown().optional(),
  pendingTurnRecovery: recovery.optional(),
  activeObjective: z.object({
    terminalState: z.string().optional(),
    interruptedTurnRecovery: z.object({ recovery }).passthrough().optional(),
  }).passthrough().optional(),
  pendingAgentDeliveryIds: z.array(z.string()).optional(),
  pendingQueuedMessageIds: z.array(z.string()).optional(),
  sdkSessionId: z.string().optional(),
  branchFromSdkSessionId: z.string().optional(),
  branchFromSessionPath: z.string().optional(),
  branchFromSdkCwd: z.string().optional(),
  branchFromSdkTurnId: z.string().optional(),
  branchContextStrategy: z.string().optional(),
  providerContextBoundaryMessageId: z.string().optional(),
  contextCompactionAttempt: z.unknown().optional(),
  toolUseId: z.string().optional(),
  toolResult: z.unknown().optional(),
  toolExecuted: z.boolean().optional(),
  role: z.string().optional(),
  providerDispatch: z.object({ state: z.string().optional() }).passthrough().optional(),
  agentDelivery: z.object({ id: z.string().optional(), status: z.string().optional() }).passthrough().optional(),
  tokenUsage: z.object({ contextTokens: z.number().optional() }).passthrough().optional(),
  userInputRequests: z.array(z.object({
    id: z.string(), status: z.string().optional(), objectiveUserMessageId: z.string().optional(),
  }).passthrough()).optional(),
};

const Header = z.object({
  ...metadata, schemaVersion: z.literal(1), id: z.string(),
  type: z.undefined().optional(), content: z.undefined().optional(),
}).passthrough();
const Message = z.object({
  ...metadata, id: z.string(), type: z.string(), content: z.string(),
}).passthrough();
const Record = z.union([Header, Message]);

export function parseRecoveryJournalObservation(line: string): z.infer<typeof Record> {
  const value: unknown = JSON.parse(line);
  return Record.parse(value);
}
