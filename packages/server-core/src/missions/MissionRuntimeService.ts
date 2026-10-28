import { getWorkspaceByNameOrId, getWorkspaces } from "@craft-agent/shared/config";
import { type MissionDigitalTwinReport, type MissionExecutionBinding, type MissionReplanPreview, type MissionSnapshot, type MissionSpec, type MissionWorkItem } from "@craft-agent/shared/missions";
import type { Session } from "@craft-agent/shared/protocol";
import { loadWorkspaceConfig } from "@craft-agent/shared/workspaces";
import type { ISessionManager } from "../handlers/session-manager-interface.ts";
import { type MissionExecutionInput, type MissionWorkExecutor, type OrdinaryMissionRoutePin } from "./MissionRuntime.ts";
import { type PendingMissionConnectorApproval } from "./BrokeredMissionConnectorExecutor.ts";
import { MissionSpecializedProfileResolver } from "../specialized-profiles/MissionSpecializedProfileResolver.ts";
import { SpecializedProfileService } from "../specialized-profiles/SpecializedProfileService.ts";
import type { SpecializedProfileEvaluation } from "@craft-agent/shared/specialized-profiles";
import type { MissionWorkspace, MissionPreflightTarget, MissionPreflightConnection, WorkspaceMissionRuntime, OrdinaryMissionRouteEstimateCache, MissionRuntimeServiceOptions } from './mission-runtime/shared.ts';
import * as missionRuntimeStart from './mission-runtime/start.ts';
import * as missionRuntimePreflight from './mission-runtime/preflight.ts';
import * as missionRuntimeReplan from './mission-runtime/replan.ts';
import * as missionRuntimeProfiles from './mission-runtime/profiles.ts';
import * as missionRuntimeConnectors from './mission-runtime/connectors.ts';
import * as missionRuntimeLifecycle from './mission-runtime/lifecycle.ts';
import * as missionRuntimeReport from './mission-runtime/report.ts';
import * as missionRuntimeRoutes from './mission-runtime/routes.ts';
import * as missionRuntimeBudget from './mission-runtime/budget.ts';
import * as missionRuntimeAdmission from './mission-runtime/admission.ts';
export type { MissionWorkspace, MissionConnectorReadinessResolver, MissionPreflightCostEstimator, MissionPreflightTarget, MissionPreflightConnection, MissionRuntimeServiceOptions } from './mission-runtime/shared.ts';
export { evaluateMissionRuntimePolicy } from './mission-runtime/shared.ts';

/**
 * Production workspace registry for Mission v2.
 *
 * It starts only after SessionManager hydration, reconstructs every non-terminal
 * mission, and owns one MissionRuntime per workspace. MissionController remains
 * the sole semantic authority; this service supplies lifecycle and RPC seams.
 */
export class MissionRuntimeService {
    /** @internal */ public readonly contexts = new Map<string, Promise<WorkspaceMissionRuntime>>();
    /** @internal */ public readonly reportLoops = new Map<string, Promise<void>>();
    /** @internal */ public readonly ordinaryRouteEstimates = new Map<string, OrdinaryMissionRouteEstimateCache>();
    /** @internal */ public readonly ordinaryRoutePreparationLocks = new Map<string, Promise<void>>();
    /** @internal */ public startPromise?: Promise<string[]>;
    /** @internal */ public readonly specializedProfileFoundries = new Map<string, SpecializedProfileService>();
    constructor(private readonly options: MissionRuntimeServiceOptions) { }
    start(): Promise<string[]> {
        return missionRuntimeStart.start(this);
    }
    /** @internal */ public async startInternal(): Promise<string[]> {
        return missionRuntimeStart.startInternal(this);
    }
    /**
     * Host-resolved dry-run. This path deliberately bypasses contextFor(): it
     * cannot construct a Mission executor, connector worker, credential lease or
     * transport as a side effect of simulation.
     */
    async preflightMission(workspaceId: string, target: MissionPreflightTarget): Promise<MissionDigitalTwinReport> {
        return missionRuntimePreflight.preflightMission(this, workspaceId, target);
    }
    /** @internal */ public async preflightMissionInternal(workspaceId: string, target: MissionPreflightTarget,
    /** The spec already passed the host-owned specialized binder. */
    trustedBoundSpec: boolean): Promise<MissionDigitalTwinReport> {
        return missionRuntimePreflight.preflightMissionInternal(this, workspaceId, target,
        /** The spec already passed the host-owned specialized binder. */
        trustedBoundSpec);
    }
    async previewReplan(workspaceId: string, missionId: string, expectedRevision: number, proposedWorkItems: MissionWorkItem[]): Promise<MissionReplanPreview> {
        return missionRuntimeReplan.previewReplan(this, workspaceId, missionId, expectedRevision, proposedWorkItems);
    }
    async replanMission(input: {
        workspaceId: string;
        missionId: string;
        expectedRevision: number;
        proposedWorkItems: MissionWorkItem[];
        actorId: string;
        reason: string;
    }): Promise<MissionSnapshot> {
        return missionRuntimeReplan.replanMission(this, input);
    }
    async createAndStart(workspaceId: string, input: MissionSpec): Promise<MissionSnapshot> {
        return missionRuntimeStart.createAndStart(this, workspaceId, input);
    }
    /**
     * Host-internal evaluation admission. This is deliberately absent from the
     * renderer RPC surface; it is the only path that may execute draft/shadow
     * profiles to produce Proof-Passport-backed promotion evidence.
     */
    async createAndStartSpecializedEvaluation(workspaceId: string, input: MissionSpec, target: {
        profileId: string;
        stage: SpecializedProfileEvaluation['stage'];
    }): Promise<MissionSnapshot> {
        return missionRuntimeStart.createAndStartSpecializedEvaluation(this, workspaceId, input, target);
    }
    async getMission(workspaceId: string, missionId: string): Promise<MissionSnapshot> {
        return missionRuntimeLifecycle.getMission(this, workspaceId, missionId);
    }
    async listMissions(workspaceId: string): Promise<MissionSnapshot[]> {
        return missionRuntimeLifecycle.listMissions(this, workspaceId);
    }
    /** Host-internal foundry API. It is intentionally not registered on renderer RPC. */
    async getSpecializedProfileFoundry(workspaceId: string): Promise<SpecializedProfileService> {
        return missionRuntimeProfiles.getSpecializedProfileFoundry(this, workspaceId);
    }
    async getProofPassport(workspaceId: string, missionId: string) {
        return missionRuntimeProfiles.getProofPassport(this, workspaceId, missionId);
    }
    async getProofPassportTrustAnchor(workspaceId: string) {
        return missionRuntimeProfiles.getProofPassportTrustAnchor(this, workspaceId);
    }
    async verifyProofPassport(workspaceId: string, missionId: string) {
        return missionRuntimeProfiles.verifyProofPassport(this, workspaceId, missionId);
    }
    async getPendingConnectorApproval(workspaceId: string, missionId: string, workItemId: string): Promise<PendingMissionConnectorApproval | null> {
        return missionRuntimeConnectors.getPendingConnectorApproval(this, workspaceId, missionId, workItemId);
    }
    /**
     * Workspace-wide, value-free connector approval inbox. The raw invocation
     * payload and provider resource id never cross this API boundary; approvers
     * receive bounded consent metadata bound to the canonical request hash.
     */
    async listPendingConnectorApprovals(workspaceId: string): Promise<PendingMissionConnectorApproval[]> {
        return missionRuntimeConnectors.listPendingConnectorApprovals(this, workspaceId);
    }
    async resolveConnectorApproval(input: {
        workspaceId: string;
        missionId: string;
        workItemId: string;
        approvalId: string;
        requestHash: string;
        decision: 'approved' | 'denied';
        resolvedBy: string;
    }): Promise<MissionSnapshot> {
        return missionRuntimeConnectors.resolveConnectorApproval(this, input);
    }
    async refreshExpiredConnectorApproval(workspaceId: string, missionId: string, workItemId: string): Promise<MissionSnapshot> {
        return missionRuntimeConnectors.refreshExpiredConnectorApproval(this, workspaceId, missionId, workItemId);
    }
    async pauseMission(workspaceId: string, missionId: string, reason: string): Promise<MissionSnapshot> {
        return missionRuntimeLifecycle.pauseMission(this, workspaceId, missionId, reason);
    }
    async resumeMission(workspaceId: string, missionId: string): Promise<MissionSnapshot> {
        return missionRuntimeLifecycle.resumeMission(this, workspaceId, missionId);
    }
    async cancelMission(workspaceId: string, missionId: string, reason: string): Promise<MissionSnapshot> {
        return missionRuntimeLifecycle.cancelMission(this, workspaceId, missionId, reason);
    }
    /** Apply newly changed emergency controls to every loaded durable Mission. */
    async enforceRuntimePolicies(): Promise<number> {
        return missionRuntimeLifecycle.enforceRuntimePolicies(this);
    }
    private async contextFor(workspaceId: string): Promise<WorkspaceMissionRuntime> {
        return missionRuntimeLifecycle.contextFor(this, workspaceId);
    }
    /** @internal */ public async createContext(workspaceId: string): Promise<WorkspaceMissionRuntime> {
        return missionRuntimeLifecycle.createContext(this, workspaceId);
    }
    /** @internal */ public createSpecializedProfileResolver(workspace: MissionWorkspace): MissionSpecializedProfileResolver {
        return missionRuntimeProfiles.createSpecializedProfileResolver(this, workspace);
    }
    /** @internal */ public ensureCompletionPassport(context: WorkspaceMissionRuntime, snapshot: MissionSnapshot): boolean {
        return missionRuntimeProfiles.ensureCompletionPassport(this, context, snapshot);
    }
    /** @internal */ public scheduleReport(context: WorkspaceMissionRuntime, snapshot: MissionSnapshot): void {
        return missionRuntimeReport.scheduleReport(this, context, snapshot);
    }
    /** @internal */ public async deliverReport(context: WorkspaceMissionRuntime, missionId: string): Promise<void> {
        return missionRuntimeReport.deliverReport(this, context, missionId);
    }
    /** @internal */ public emitReportFailure(context: WorkspaceMissionRuntime, missionId: string, reportId: string, originSessionId: string, reason: string): void {
        return missionRuntimeReport.emitReportFailure(this, context, missionId, reportId, originSessionId, reason);
    }
    /** @internal */ public waitForSessionCompletion(sessionId: string, timeoutMs: number): {
        promise: Promise<Parameters<Parameters<ISessionManager['onSessionComplete']>[0]>[0]>;
        cancel: () => void;
    } {
        return missionRuntimeReport.waitForSessionCompletion(this, sessionId, timeoutMs);
    }
    /** @internal */ public async createProductionExecutor(workspace: MissionWorkspace): Promise<MissionWorkExecutor> {
        return missionRuntimeRoutes.createProductionExecutor(this, workspace);
    }
    /** @internal */ public ordinaryRouteKey(workspaceId: string, missionId: string): string {
        return missionRuntimeRoutes.ordinaryRouteKey(this, workspaceId, missionId);
    }
    /** @internal */ public async withOrdinaryRoutePreparationLock<T>(workspaceId: string, missionId: string, operation: () => Promise<T>): Promise<T> {
        return missionRuntimeRoutes.withOrdinaryRoutePreparationLock<T>(this, workspaceId, missionId, operation);
    }
    /** @internal */ public async prepareOrdinaryMissionDispatchRoute(workspaceId: string, input: MissionExecutionInput): Promise<OrdinaryMissionRoutePin | undefined> {
        return missionRuntimeRoutes.prepareOrdinaryMissionDispatchRoute(this, workspaceId, input);
    }
    /** @internal */ public async revalidateOrdinaryMissionDispatchRoute(workspaceId: string, input: MissionExecutionInput, route: MissionExecutionBinding['missionRoute']): Promise<void> {
        return missionRuntimeRoutes.revalidateOrdinaryMissionDispatchRoute(this, workspaceId, input, route);
    }
    /** @internal */ public currentMissionConnections(): MissionPreflightConnection[] {
        return missionRuntimeRoutes.currentMissionConnections(this);
    }
    /** @internal */ public validOrdinaryRuntimeIdentity(): string | undefined {
        return missionRuntimeRoutes.validOrdinaryRuntimeIdentity(this);
    }
    /** @internal */ public missionEstimateEnvironmentIdentity(workspace: MissionWorkspace, snapshot: MissionSnapshot, config: ReturnType<typeof loadWorkspaceConfig>, connections: readonly MissionPreflightConnection[], origin: Session | undefined): string {
        return missionRuntimeBudget.missionEstimateEnvironmentIdentity(this, workspace, snapshot, config, connections, origin);
    }
    /** @internal */ public async projectedRemainingMissionCostUsd(input: {
        workspace: MissionWorkspace;
        snapshot: MissionSnapshot;
        config: ReturnType<typeof loadWorkspaceConfig>;
        connections: readonly MissionPreflightConnection[];
        origin: Session | undefined;
        measuredMissionUsd: number;
        environmentSha256: string;
        currentItem: MissionWorkItem;
    }): Promise<number | undefined> {
        return missionRuntimeBudget.projectedRemainingMissionCostUsd(this, input);
    }
    /** @internal */ public releaseOrdinaryMissionEstimate(workspaceId: string, missionId: string, workItemId: string): void {
        return missionRuntimeBudget.releaseOrdinaryMissionEstimate(this, workspaceId, missionId, workItemId);
    }
    /** @internal */ public async addOrdinaryMissionEstimate(cache: OrdinaryMissionRouteEstimateCache, input: {
        workspace: MissionWorkspace;
        snapshot: MissionSnapshot;
        config: ReturnType<typeof loadWorkspaceConfig>;
        connections: readonly MissionPreflightConnection[];
        origin: Session | undefined;
        measuredMissionUsd: number;
        item: MissionWorkItem;
    }): Promise<void> {
        return missionRuntimeBudget.addOrdinaryMissionEstimate(this, cache, input);
    }
    /** @internal */ public resolveOrdinaryRouteForItem(input: {
        workspace: MissionWorkspace;
        spec: MissionSpec;
        item: MissionWorkItem;
        profile: MissionExecutionInput['profile'];
        config: ReturnType<typeof loadWorkspaceConfig>;
        connections: readonly MissionPreflightConnection[];
        origin: Session | undefined;
        measuredMissionUsd: number;
        projectedRemainingUsd?: number;
    }) {
        return missionRuntimeRoutes.resolveOrdinaryRouteForItem(this, input);
    }
    /** @internal */ public assertAdmissible(workspace: MissionWorkspace, spec: MissionSpec): void {
        return missionRuntimeAdmission.assertAdmissible(this, workspace, spec);
    }
    /** @internal */ public workItemPathsAreAuthorized(workspace: MissionWorkspace, spec: MissionSpec, item: MissionWorkItem): boolean {
        return missionRuntimeAdmission.workItemPathsAreAuthorized(this, workspace, spec, item);
    }
    /** @internal */ public resolveWorkspace(workspaceId: string): MissionWorkspace | null {
        return this.options.resolveWorkspace?.(workspaceId) ?? getWorkspaceByNameOrId(workspaceId);
    }
    /** @internal */ public listWorkspaces(): MissionWorkspace[] {
        return this.options.listWorkspaces?.() ?? getWorkspaces();
    }
    private reportError(context: {
        workspaceId?: string;
        missionId?: string;
        workItemId?: string;
        error: Error;
    }): void {
        this.options.onError?.(context);
    }
}
