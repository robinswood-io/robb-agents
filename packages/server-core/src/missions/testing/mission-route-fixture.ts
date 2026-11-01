import type { MissionSpec } from '@craft-agent/shared/missions';
import type { MissionRuntimeServiceOptions } from '../MissionRuntimeService.ts';

/** A fully explicit, unauthenticated route for scripted executors; never calls a provider. */
export const offlineMissionRouteOptions: Pick<MissionRuntimeServiceOptions, 'preflightConnections'> = {
  preflightConnections: () => [{
    slug: 'openai', providerType: 'pi', piAuthProvider: 'openai', authType: 'none',
    models: ['pi/gpt-5.6-terra'], defaultModel: 'pi/gpt-5.6-terra',
  }],
};

export function withOfflineMissionRoutes(spec: MissionSpec): MissionSpec {
  return { ...spec, agentProfiles: spec.agentProfiles.map(profile => ({
    ...profile,
    llmConnection: profile.llmConnection ?? 'openai',
    model: profile.model ?? 'pi/gpt-5.6-terra',
  })) };
}
