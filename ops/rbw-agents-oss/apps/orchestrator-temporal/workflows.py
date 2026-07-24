from __future__ import annotations
from datetime import timedelta
from temporalio import workflow
from temporalio.common import RetryPolicy
from temporalio.exceptions import ApplicationError

with workflow.unsafe.imports_passed_through():
    from activities import run_legacy_automation


@workflow.defn(sandboxed=False)
class RbwAutomationWorkflow:
    @workflow.run
    async def run(self, payload: dict) -> dict:
        result = await workflow.execute_activity(
            run_legacy_automation,
            payload,
            start_to_close_timeout=timedelta(minutes=45),
            retry_policy=RetryPolicy(maximum_attempts=3),
        )
        if isinstance(result, dict) and result.get('ok') is False:
            legacy_id = result.get('legacyId') or payload.get('legacy_id') or 'unknown'
            raise ApplicationError(
                f"legacy automation failed: {legacy_id} exitCode={result.get('exitCode')} "
                f"timeout={result.get('timeout')} businessFailure={result.get('businessFailure')}",
                type="LegacyAutomationFailed",
                non_retryable=True,
            )
        return result
