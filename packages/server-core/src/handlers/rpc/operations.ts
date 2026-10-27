import {
  getRobbOperationsExtension,
  type OperationsSettingsDto,
} from '@craft-agent/shared/operations';
import { CodedError, RPC_CHANNELS } from '@craft-agent/shared/protocol';
import { assertRequestWorkspace, type RpcServer } from '@craft-agent/server-core/transport';
import type { HandlerDeps } from '../handler-deps.ts';

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.operations.GET_STATUS,
  RPC_CHANNELS.operations.UPDATE_SETTINGS,
  RPC_CHANNELS.operations.RESOLVE_APPROVAL,
] as const;

function requireCommercialExtension() {
  const extension = getRobbOperationsExtension();
  if (!extension) throw new CodedError('CAPABILITY_UNAVAILABLE', 'Robb Operations is not installed or entitled.');
  return extension;
}

function isOperationsSettingsDto(value: unknown): value is OperationsSettingsDto {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const root = value as Record<string, unknown>;
  if (Object.keys(root).length !== 1 || !root.budgets || typeof root.budgets !== 'object' || Array.isArray(root.budgets)) {
    return false;
  }
  const budgets = root.budgets as Record<string, unknown>;
  const keys = [
    'warningAction', 'hardLimitAction', 'sessionWarningUsd', 'sessionHardUsd',
    'missionWarningUsd', 'missionHardUsd', 'workspaceDailyWarningUsd', 'workspaceDailyHardUsd',
  ];
  return Object.keys(budgets).length === keys.length && keys.every(key => key in budgets) &&
    (budgets.warningAction === 'notify' || budgets.warningAction === 'require-approval') &&
    (budgets.hardLimitAction === 'notify' || budgets.hardLimitAction === 'require-approval' || budgets.hardLimitAction === 'block') &&
    keys.slice(2).every(key => typeof budgets[key] === 'number' && Number.isFinite(budgets[key]) && (budgets[key] as number) > 0);
}

export function registerOperationsHandlers(server: RpcServer, _deps: HandlerDeps): void {
  server.handle(
    RPC_CHANNELS.operations.GET_STATUS,
    async (ctx, workspaceId: string): Promise<unknown> => {
      assertRequestWorkspace(ctx, workspaceId);
      const extension = getRobbOperationsExtension();
      if (!extension) return { available: false };
      const settings = extension.getSettings?.();
      return {
        available: true,
        extensionId: extension.id,
        snapshot: extension.getSnapshot?.(workspaceId) ?? null,
        ...(settings ? { settings } : {}),
      };
    },
  );

  server.handle(
    RPC_CHANNELS.operations.UPDATE_SETTINGS,
    async (ctx, workspaceId: string, settings: OperationsSettingsDto): Promise<OperationsSettingsDto> => {
      assertRequestWorkspace(ctx, workspaceId);
      if (!ctx.roles.includes('owner') && !ctx.roles.includes('admin')) {
        throw new CodedError('AUTH_FAILED', 'An owner or admin role is required.');
      }
      if (!isOperationsSettingsDto(settings)) throw new Error('Invalid Robb Operations settings');
      const extension = requireCommercialExtension();
      if (!extension.updateSettings) {
        throw new CodedError('CAPABILITY_UNAVAILABLE', 'This module cannot update settings.');
      }
      return extension.updateSettings(workspaceId, settings, ctx.actorId);
    },
  );

  server.handle(
    RPC_CHANNELS.operations.RESOLVE_APPROVAL,
    async (
      ctx,
      workspaceId: string,
      request: { approvalId: string; approved: boolean },
    ): Promise<{ resolved: boolean }> => {
      assertRequestWorkspace(ctx, workspaceId);
      if (!ctx.roles.includes('owner') && !ctx.roles.includes('admin') && !ctx.roles.includes('validator')) {
        throw new CodedError('AUTH_FAILED', 'An owner, admin or validator role is required.');
      }
      if (!request || typeof request.approvalId !== 'string' || request.approvalId.trim() === '' ||
          typeof request.approved !== 'boolean' || Object.keys(request).some(key => !['approvalId', 'approved'].includes(key))) {
        throw new Error('Invalid Robb Operations approval request');
      }
      const extension = requireCommercialExtension();
      if (!extension.resolveApproval) throw new CodedError('CAPABILITY_UNAVAILABLE', 'This module cannot resolve approvals.');
      return {
        resolved: extension.resolveApproval(
          workspaceId,
          request.approvalId,
          request.approved,
          ctx.actorId,
        ),
      };
    },
  );
}
