import { SpecializedMissionProfileSelectionError } from "@craft-agent/shared/specialized-profiles";
import type { MissionExecutionInput, MissionExecutionLifecycle, MissionExecutionResult, MissionWorkExecutor } from "../../missions/MissionRuntime.ts";
import { MissionSpecializedProfileResolver } from './resolver.ts';

/** Revalidates a specialized binding immediately before every executor boundary. */
export class SpecializedProfileMissionExecutor implements MissionWorkExecutor {
  constructor(
    private readonly executor: MissionWorkExecutor,
    private readonly resolver: MissionSpecializedProfileResolver,
  ) {}

  async prepare(input: MissionExecutionInput) {
    const resolved = await this.resolver.resolveExecutionInput(input);
    const binding = await this.executor.prepare(resolved);
    return resolved.specializedProfile
      ? {
        ...binding,
        specializedProfile: specializedBindingFingerprint(resolved.specializedProfile),
      }
      : binding;
  }

  async execute(
    input: MissionExecutionInput,
    binding: Awaited<ReturnType<MissionWorkExecutor['prepare']>>,
    lifecycle?: MissionExecutionLifecycle,
  ): Promise<MissionExecutionResult> {
    const resolved = await this.resolver.resolveExecutionInput(input);
    const expected = resolved.specializedProfile
      ? specializedBindingFingerprint(resolved.specializedProfile)
      : undefined;
    if (!sameSpecializedBindingFingerprint(binding.specializedProfile, expected)) {
      throw new SpecializedMissionProfileSelectionError(
        `Specialized Mission profile "${input.profile.id}" changed between prepare and execute`,
      );
    }
    const { specializedProfile: _fingerprint, ...underlyingBinding } = binding;
    const result = await this.executor.execute(resolved, underlyingBinding, lifecycle);
    // A revocation, downgrade, route change, or capability drift while the
    // underlying turn was in flight must prevent its result from being
    // accepted into the Mission journal.
    const after = await this.resolver.resolveExecutionInput(input);
    const afterFingerprint = after.specializedProfile
      ? specializedBindingFingerprint(after.specializedProfile)
      : undefined;
    if (!sameSpecializedBindingFingerprint(binding.specializedProfile, afterFingerprint)) {
      throw new SpecializedMissionProfileSelectionError(
        `Specialized Mission profile "${input.profile.id}" changed while execute was running`,
      );
    }
    return result;
  }
}

function specializedBindingFingerprint(
  binding: NonNullable<MissionExecutionInput['specializedProfile']>,
): NonNullable<Awaited<ReturnType<MissionWorkExecutor['prepare']>>['specializedProfile']> {
  return {
    profileId: binding.profileId,
    profileVersion: binding.profileVersion,
    versionSha256: binding.versionSha256,
    capabilityEnvelopeSha256: binding.capabilityEnvelopeSha256,
    executionRouteSha256: binding.executionRouteSha256,
  };
}

function sameSpecializedBindingFingerprint(
  actual: Awaited<ReturnType<MissionWorkExecutor['prepare']>>['specializedProfile'],
  expected: Awaited<ReturnType<MissionWorkExecutor['prepare']>>['specializedProfile'],
): boolean {
  if (!actual || !expected) return actual === expected;
  return actual.profileId === expected.profileId
    && actual.profileVersion === expected.profileVersion
    && actual.versionSha256 === expected.versionSha256
    && actual.capabilityEnvelopeSha256 === expected.capabilityEnvelopeSha256
    && actual.executionRouteSha256 === expected.executionRouteSha256;
}
