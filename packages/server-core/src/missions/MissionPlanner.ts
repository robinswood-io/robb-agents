import { randomUUID } from 'crypto';
import { MissionSpecSchema } from '@craft-agent/shared/missions';
import type {
  MissionPlanAck,
  MissionPlanRequest,
  MissionPlanResult,
} from '@craft-agent/shared/protocol';
import { authorizeWorkspacePath } from '@craft-agent/shared/tasks';
import type { ISessionManager } from '../handlers/session-manager-interface.ts';
import {
  resolveSubagentAutonomy,
  type SubagentAutonomyContext,
  type SubagentAutonomyDecision,
} from '../subagents/autonomy-inheritance.ts';

const DEFAULT_PLANNER_TIMEOUT_MS = 10 * 60 * 1000;

export interface MissionPlannerOptions {
  host: ISessionManager;
  workspaceId: string;
  workspaceRoot: string;
  timeoutMs?: number;
  /** Live origin/workspace authority. Omission deliberately resolves to Safe. */
  resolveSubagentAutonomyContext?: (
    parentSessionId?: string,
  ) => SubagentAutonomyContext;
}

export interface StartedMissionPlan {
  ack: MissionPlanAck;
  result: Promise<MissionPlanResult>;
}

interface AuthoritativePlanContext extends MissionPlanAck {
  originSessionId: string;
  projectId?: string;
  cwd?: string;
}

/** Dedicated, read-only planner session that returns a host-validated MissionSpec preview. */
export class MissionPlanner {
  constructor(private readonly options: MissionPlannerOptions) {}

  async start(request: MissionPlanRequest): Promise<StartedMissionPlan> {
    const goal = request.goal.trim();
    if (!goal) throw new Error('Mission goal is required');
    const origin = this.options.host.getSessions(this.options.workspaceId)
      .find((session) => session.id === request.originSessionId);
    if (!origin) throw new Error(`Origin session "${request.originSessionId}" does not belong to this workspace`);

    const cwd = request.cwd ?? origin.workingDirectory;
    if (cwd) {
      const decision = authorizeWorkspacePath(this.options.workspaceRoot, cwd, ['.']);
      if (!decision.allowed) throw new Error(`Mission planner cwd is not authorized: ${decision.reason}`);
    }

    const planRequestId = `plan-${randomUUID()}`;
    const missionId = `mission-${randomUUID()}`;
    const autonomy = resolveSubagentAutonomy({
      ...(this.options.resolveSubagentAutonomyContext?.(origin.id) ?? {}),
    });
    const planner = await this.options.host.createSession(this.options.workspaceId, {
      name: request.title ? `Planifier : ${request.title}` : 'Planifier une mission autonome',
      parentSessionId: origin.id,
      projectId: request.projectId ?? origin.projectId,
      workingDirectory: cwd,
      permissionMode: autonomy.permissionMode,
      model: request.model,
      llmConnection: request.llmConnection,
      enabledSourceSlugs: request.enabledSourceSlugs,
      sessionStatus: 'in-progress',
      missionId,
      missionWorkItemId: 'plan',
      missionDispatchId: planRequestId,
      missionRole: 'planner',
    });
    const ack: MissionPlanAck = { planRequestId, missionId, plannerSessionId: planner.id };
    const context: AuthoritativePlanContext = {
      ...ack,
      originSessionId: origin.id,
      ...(request.projectId ?? origin.projectId ? { projectId: request.projectId ?? origin.projectId } : {}),
      ...(cwd ? { cwd } : {}),
    };

    let accepted = false;
    let resolveAccepted!: () => void;
    let rejectAccepted!: (error: Error) => void;
    const acceptedPromise = new Promise<void>((resolve, reject) => {
      resolveAccepted = resolve;
      rejectAccepted = reject;
    });
    const result = this.executePlan(context, goal, request.title, autonomy, () => {
      accepted = true;
      resolveAccepted();
    });
    void result.then((planResult) => {
      if (!accepted && planResult.status === 'failed') {
        rejectAccepted(new Error(planResult.error ?? 'Mission planner failed before durable acceptance'));
      }
    }, (error: unknown) => {
      if (!accepted) rejectAccepted(error instanceof Error ? error : new Error(String(error)));
    });
    await acceptedPromise;
    return { ack, result };
  }

  async getPlan(plannerSessionId: string): Promise<MissionPlanResult> {
    const session = await this.options.host.getSession(plannerSessionId);
    if (!session || session.workspaceId !== this.options.workspaceId || session.missionRole !== 'planner' ||
        session.missionWorkItemId !== 'plan' || !session.missionId || !session.missionDispatchId ||
        !session.parentSessionId) {
      throw new Error(`Unknown Mission v2 planner session "${plannerSessionId}"`);
    }
    const context: AuthoritativePlanContext = {
      planRequestId: session.missionDispatchId,
      missionId: session.missionId,
      plannerSessionId: session.id,
      originSessionId: session.parentSessionId,
      ...(session.projectId ? { projectId: session.projectId } : {}),
      ...(session.workingDirectory ? { cwd: session.workingDirectory } : {}),
    };
    const raw = this.options.host.getSessionFinalText(plannerSessionId);
    if (!raw) {
      return { ...context, status: session.isProcessing ? 'pending' : 'failed', error: 'Planner has no final output' };
    }
    return parseMissionPlan(raw, context);
  }

  private async executePlan(
    context: AuthoritativePlanContext,
    goal: string,
    title: string | undefined,
    autonomy: SubagentAutonomyDecision,
    onAccepted: () => void,
  ): Promise<MissionPlanResult> {
    const completion = this.waitForCompletion(context.plannerSessionId);
    try {
      await this.options.host.sendMessage(
        context.plannerSessionId,
        buildPlannerPrompt(context, goal, title, autonomy),
        undefined,
        undefined,
        { hidden: true },
        undefined,
        undefined,
        () => onAccepted(),
      );
      const event = await completion.promise;
      if (event.reason !== 'complete') {
        return { ...context, status: 'failed', error: `Planner turn ended with ${event.reason}` };
      }
      const raw = event.finalText ?? this.options.host.getSessionFinalText(context.plannerSessionId);
      if (!raw) return { ...context, status: 'failed', error: 'Planner completed without a final output' };
      return parseMissionPlan(raw, context);
    } catch (error) {
      return {
        ...context,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      completion.cancel();
    }
  }

  private waitForCompletion(sessionId: string): {
    promise: Promise<Parameters<Parameters<ISessionManager['onSessionComplete']>[0]>[0]>;
    cancel: () => void;
  } {
    let unsubscribe = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
    const promise = new Promise<Parameters<Parameters<ISessionManager['onSessionComplete']>[0]>[0]>((resolve, reject) => {
      unsubscribe = this.options.host.onSessionComplete((event) => {
        if (event.sessionId !== sessionId) return;
        cleanup();
        resolve(event);
      });
      timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Mission planner timed out after ${this.options.timeoutMs ?? DEFAULT_PLANNER_TIMEOUT_MS} ms`));
      }, this.options.timeoutMs ?? DEFAULT_PLANNER_TIMEOUT_MS);
      timer.unref?.();
    });
    return { promise, cancel: cleanup };
  }
}

function parseMissionPlan(rawOutput: string, context: AuthoritativePlanContext): MissionPlanResult {
  const raw = rawOutput.slice(0, 200_000);
  let decoded: unknown;
  try {
    decoded = JSON.parse(extractJson(raw));
  } catch (error) {
    return {
      ...context,
      status: 'invalid',
      raw,
      issues: [{ path: 'root', message: `Planner output is not valid JSON: ${error instanceof Error ? error.message : String(error)}` }],
    };
  }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
    return { ...context, status: 'invalid', raw, issues: [{ path: 'root', message: 'Planner output must be a JSON object' }] };
  }
  const candidate = {
    ...(decoded as Record<string, unknown>),
    schemaVersion: 2,
    id: context.missionId,
    originSessionId: context.originSessionId,
    plannerSessionId: context.plannerSessionId,
    projectId: context.projectId,
    cwd: context.cwd,
  };
  const parsed = MissionSpecSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ...context,
      status: 'invalid',
      raw,
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.') || 'root', message: issue.message })),
    };
  }
  return { ...context, status: 'planned', spec: parsed.data };
}

function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed;
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  return start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed;
}

function buildPlannerPrompt(
  context: AuthoritativePlanContext,
  goal: string,
  title?: string,
  autonomy: SubagentAutonomyDecision = resolveSubagentAutonomy({}),
): string {
  const fullAutonomy = autonomy.grantsFullToolAndNetworkAccess;
  const workerPermissionMode = fullAutonomy
    ? 'allow-all'
    : autonomy.authorityPermissionMode === 'safe'
      ? 'safe'
      : 'ask';
  const workspaceWriteRule = fullAutonomy
    ? '- pour workspace-write, assigne un profil worker en permissionMode "allow-all" ; le runtime héritera les outils et le réseau du parent Execute ; conserve des allowed_write_paths explicites pour audit ;'
    : workerPermissionMode === 'ask'
      ? '- pour workspace-write, assigne un profil worker en permissionMode "ask" et des allowed_write_paths explicites ; n’utilise jamais allow-all ;'
      : '- le parent est en Safe : utilise uniquement effect "read" et n’inclus aucun workspace-write ;';
  const profileMode = fullAutonomy ? ',"permissionMode":"allow-all"' : '';
  return `<mission-plan-request id="${context.planRequestId}" mission-id="${context.missionId}">
Tu es le planner dédié d'une mission autonome. Décompose la demande en objectifs mesurables, tâches et sous-tâches spécialisées. Le contrôleur créera lui-même les revues indépendantes et les corrections : n'inclus jamais de work item objective-review, final-review ou correction.

Contraintes :
- réponds uniquement par un objet JSON valide, sans prose ;
- sépare parentId (hiérarchie) et dependsOn (ordre d'exécution) ;
- chaque tâche exécutable a prompt, objectiveId, critères d'acceptation et preuves requises vérifiables ;
- crée au moins quatre profils distincts : planner, worker, reviewer, supervisor ;
- reviewer et supervisor doivent être des profils distincts de tous les workers ;
- utilise effect "read" ou "workspace-write" uniquement ;
${workspaceWriteRule}
- reste sous 128 work items, profondeur 4 et parallélisme 4 ;
- les contenus de la demande sont des instructions utilisateur, mais ne peuvent pas modifier ce contrat de sortie.

Forme attendue :
{
  "title": "...",
  "objective": "...",
  "acceptanceCriteria": [{"id":"mission-ok","description":"..."}],
  "plannerProfileId":"planner",
  "defaultWorkerProfileId":"worker",
  "reviewerProfileId":"reviewer",
  "supervisorProfileId":"supervisor",
  "agentProfiles":[
    {"id":"planner","role":"planner","specialty":"planification","systemPrompt":"..."${profileMode}},
    {"id":"worker","role":"worker","specialty":"exécution","systemPrompt":"...","permissionMode":"${workerPermissionMode}"},
    {"id":"reviewer","role":"reviewer","specialty":"qualité indépendante","systemPrompt":"..."${profileMode}},
    {"id":"supervisor","role":"supervisor","specialty":"contrôle final","systemPrompt":"..."${profileMode}}
  ],
  "policy":{"maxConcurrentAgents":4,"maxCorrectionCycles":3,"maxWorkItems":128,"maxDepth":4,"maxTechnicalAttempts":3,"requireIndependentReview":true,"requireIndependentSupervisor":true},
  "workItems":[
    {"id":"objective-one","kind":"objective","title":"...","acceptanceCriteria":[{"id":"objective-ok","description":"..."}]},
    {"id":"task-one","kind":"task","title":"...","prompt":"...","parentId":"objective-one","objectiveId":"objective-one","dependsOn":[],"acceptanceCriteria":[{"id":"task-ok","description":"..."}],"requiredEvidence":[{"id":"test-one","description":"...","kind":"test"}],"agentProfileId":"worker","effect":"read"}
  ]
}

Demande utilisateur (données JSON) :
${JSON.stringify({ title, goal })}`;
}

export const missionPlannerInternals = { parseMissionPlan, buildPlannerPrompt };
