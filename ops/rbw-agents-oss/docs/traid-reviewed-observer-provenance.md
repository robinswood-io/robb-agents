# Reviewed TRAID observer provenance

This control accepts a content-addressed, immutable observer release using the root-owned registry at /opt/traid-onchain-shadow/release-manifests. It verifies the exact manifest digest, all payload bytes/modes/owners, the complete tree, internal hard links, and Git commit/tree. Shared development main and its dirty files do not attest an independently reviewed release.

An existing invalid manifest fails closed. Legacy alignment with main and origin/main is available only when the manifest is absent. This change never makes an unhealthy or stale observer healthy: every existing status, guard, freshness, financial counter, timer, thirty-day gate and account coverage condition remains required.

Historical systemd restart counts can be accepted only through a root-owned, regular, immutable <sha>.live-verification.json receipt bound to the exact manifest and observe_only_shadow_deployment scope. No receipt was produced for the failed afe9820 trial. The receipt must contain the actual activationBaseline and two completed, progressing observations of both services after that baseline, with unchanged PID/startMonotonic/restartCount, finite memory budgets, no pressure events and four zero financial-authority counters. Mere process activity or a first uncompleted observation cannot satisfy it. Report timestamps must fall between actual activation and observation; activation/observations can be no more than five seconds ahead of the real checking clock.

After an accepted receipt, any PID, monotonic start or restart-count change blocks the control, including a restart-count reset to zero. Without a receipt, zero restart count is allowed only with a real positive process identity. Parsing failures return fixed diagnostics; supplied timestamp strings and provider messages are never returned.

The checker has no activation, restart, order, signing or chain-mutation capability. Release publication and root live-proof publication remain the reviewed observer activator's responsibility, after exact-SHA canonical and independent hostile review gates. Source-only CLI tests use disposable Git fixtures and do not modify a deployed runtime.

A reviewed candidate without a validated joint live receipt remains blocked with reviewed_release_completed_cycle_proof_missing, even if its current process has zero restarts and one successful cycle. This separates package trust from completed runtime verification.
