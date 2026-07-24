/**
 * Privacy-safe execution telemetry contracts.
 *
 * These events intentionally contain operational metadata only. Prompt
 * content, tool input/output, credentials, file contents and personal data do
 * not belong in this schema.
 */

export type ExecutionTelemetryEventName =
  | 'session.started'
  | 'session.completed'
  | 'turn.started'
  | 'turn.completed'
  | 'tool.started'
  | 'tool.completed'
  | 'tool.failed'
  | 'routing.selected'
  | 'routing.fallback'
  | 'permission.requested'
  | 'permission.resolved'
  | 'cost.recorded';

export interface ExecutionTelemetryCorrelation {
  workspaceId: string;
  missionId?: string;
  sessionId: string;
  turnId?: string;
  toolCallId?: string;
}

interface ExecutionTelemetryBase {
  schemaVersion: 1;
  eventId: string;
  timestamp: number;
  name: ExecutionTelemetryEventName;
  correlation: ExecutionTelemetryCorrelation;
}

export interface SessionTelemetryEvent extends ExecutionTelemetryBase {
  name: 'session.started' | 'session.completed';
  outcome?: 'success' | 'cancelled' | 'failed';
  durationMs?: number;
}

export interface TurnTelemetryEvent extends ExecutionTelemetryBase {
  name: 'turn.started' | 'turn.completed';
  outcome?: 'success' | 'cancelled' | 'failed';
  durationMs?: number;
}

export interface ToolTelemetryEvent extends ExecutionTelemetryBase {
  name: 'tool.started' | 'tool.completed' | 'tool.failed';
  toolName: string;
  outcome?: 'success' | 'cancelled' | 'failed';
  durationMs?: number;
  errorCode?: string;
}

export interface RoutingTelemetryEvent extends ExecutionTelemetryBase {
  name: 'routing.selected' | 'routing.fallback';
  connectionSlug?: string;
  providerType?: string;
  model?: string;
  sensitivity?: string;
  policyRuleIds?: string[];
  fallbackReason?: string;
}

export interface PermissionTelemetryEvent extends ExecutionTelemetryBase {
  name: 'permission.requested' | 'permission.resolved';
  permissionKind: string;
  resolution?: 'approved' | 'denied' | 'cancelled' | 'expired';
  durationMs?: number;
}

export interface CostTelemetryEvent extends ExecutionTelemetryBase {
  name: 'cost.recorded';
  source: 'sdk' | 'provider' | 'estimated' | 'unavailable' | string;
  estimatedCostUsd?: number;
  actualCostUsd?: number;
  estimatedCostEur?: number;
  actualCostEur?: number;
  pricingCatalogVersion?: string;
  exchangeRateAsOf?: string;
  exchangeRateSource?: string;
}

export type ExecutionTelemetryEvent =
  | SessionTelemetryEvent
  | TurnTelemetryEvent
  | ToolTelemetryEvent
  | RoutingTelemetryEvent
  | PermissionTelemetryEvent
  | CostTelemetryEvent;
