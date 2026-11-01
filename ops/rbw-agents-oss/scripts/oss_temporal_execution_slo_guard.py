from __future__ import annotations

import asyncio
import json
import logging
import re
from datetime import UTC, datetime
from pathlib import Path

from lib.wrapper_sdk import now_iso, write_report
from pydantic import JsonValue, TypeAdapter
from temporalio.client import Client, WorkflowExecution, WorkflowExecutionStatus

JSON_OBJECT = TypeAdapter(dict[str, JsonValue])
JSON_ROWS = TypeAdapter(list[dict[str, JsonValue]])
NUMBER = TypeAdapter(int | float | str)
INTEGER = TypeAdapter(int)
STRING = TypeAdapter(str)

ROOT = Path('/srv/rbw-agents-oss')
CONFIG = ROOT / 'config'
OPS = Path('/home/craft/.craft-agent/workspaces/my-workspace-2/campaigns/ops')
POLICY = CONFIG / 'registry/temporal-execution-slo-policy.json'
RUNTIME_STATUS_POLICY = CONFIG / 'registry/runtime-status-policy.json'
SLUG = 'oss-temporal-execution-slo-guard'

STATUS_MAP = {
    '1': 'RUNNING',
    '2': 'COMPLETED',
    '3': 'FAILED',
    '4': 'CANCELED',
    '5': 'TERMINATED',
    '6': 'CONTINUED_AS_NEW',
    '7': 'TIMED_OUT',
}
BAD_STATUSES = {'FAILED', 'TERMINATED', 'TIMED_OUT'}


def load_json(path: Path, default: JsonValue) -> JsonValue:
    try:
        return TypeAdapter(JsonValue).validate_json(path.read_bytes())
    except (OSError, ValueError):
        return default


def dt_iso(value: datetime | str | None) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.astimezone(UTC).isoformat().replace('+00:00', 'Z')
    return str(value)


def age_minutes(value: datetime | None, now: datetime) -> float | None:
    if not isinstance(value, datetime):
        return None
    return round((now - value.astimezone(UTC)).total_seconds() / 60, 2)


def status_name(value: WorkflowExecutionStatus | int | str | None) -> str:
    raw = str(value)
    if raw.startswith('WorkflowExecutionStatus.'):
        return raw.split('.')[-1]
    return STATUS_MAP.get(raw, raw)


def wf_item(wf: WorkflowExecution, now: datetime) -> dict[str, JsonValue]:
    status = status_name(wf.status)
    start = wf.start_time
    close = wf.close_time
    return {
        'workflowId': wf.id,
        'runId': wf.run_id,
        'workflowType': wf.workflow_type,
        'taskQueue': wf.task_queue,
        'status': status,
        'startTime': dt_iso(start),
        'closeTime': dt_iso(close),
        'ageMinutes': age_minutes(start, now) if status == 'RUNNING' else None,
        'durationSeconds': round((close.astimezone(UTC) - start.astimezone(UTC)).total_seconds(), 3) if close is not None else None,
        'historyLength': wf.history_length,
    }


async def collect(policy: dict[str, JsonValue]) -> dict[str, JsonValue]:
    target_host = STRING.validate_python(policy.get('targetHost', '127.0.0.1:57233'))
    namespace = STRING.validate_python(policy.get('namespace', 'default'))
    max_recent = INTEGER.validate_python(policy.get('maxRecentWorkflows', 200))
    max_running = INTEGER.validate_python(policy.get('maxRunningWorkflows', 100))
    client = await Client.connect(target_host, namespace=namespace)
    now = datetime.now(UTC)
    running: list[dict[str, JsonValue]] = []
    async for wf in client.list_workflows(query='ExecutionStatus="Running"'):
        running.append(wf_item(wf, now))
        if len(running) >= max_running:
            break
    recent: list[dict[str, JsonValue]] = []
    async for wf in client.list_workflows():
        recent.append(wf_item(wf, now))
        if len(recent) >= max_recent:
            break
    return {'running': list(running), 'recent': list(recent), 'targetHost': target_host, 'namespace': namespace}


def accepted_business_entries(policy: dict[str, JsonValue]) -> dict[str, dict[str, JsonValue]]:
    entries = JSON_ROWS.validate_python(policy.get('acceptedNonOkReports') or [])
    return {str(entry.get('legacy_id')): entry for entry in entries if entry.get('legacy_id') and 'business_failed' in [str(value) for value in TypeAdapter(list[str]).validate_python(entry.get('statuses') or [])]}


def workflow_legacy_id(workflow_id: JsonValue, known_ids: set[str] | None = None) -> str:
    raw = str(workflow_id or '')
    raw = raw.removeprefix('rbw.')
    raw = raw.removeprefix('manual-')
    if known_ids:
        matches = [legacy_id for legacy_id in known_ids if raw == legacy_id or raw.startswith(legacy_id + '-')]
        if matches:
            return max(matches, key=len)
    raw = re.sub(r'-\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$', '', raw)
    return re.sub(r'-[0-9a-f]{10,}$', '', raw)


def runtime_evidence_candidates(legacy_id: str, runtime_dir: Path) -> list[dict[str, JsonValue]]:
    candidates: list[dict[str, JsonValue]] = []
    latest_path = runtime_dir / f'{legacy_id}-last.json'
    latest = load_json(latest_path, {})
    if isinstance(latest, dict) and latest:
        candidates.append({'source': 'latest', 'path': str(latest_path), 'generatedAt': latest.get('generatedAt'), **latest})
    history_path = runtime_dir / f'{legacy_id}-history.jsonl'
    if history_path.exists():
        try:
            all_lines = history_path.read_text(encoding='utf-8').splitlines()
            lines = all_lines[-500:]
            for line_number, line in enumerate(lines, start=max(1, len(all_lines) - len(lines) + 1)):
                row = TypeAdapter(JsonValue).validate_json(line)
                if isinstance(row, dict):
                    candidates.append({'source': 'history', 'path': str(history_path), 'historyLine': line_number, 'generatedAt': row.get('ts') or row.get('generatedAt'), **row})
        except (OSError, ValueError):
            pass
    return candidates


def controlled_business_failure(item: dict[str, JsonValue], max_evidence_distance_seconds: int = 1800, runtime_dir: Path | None = None, runtime_status_policy: dict[str, JsonValue] | None = None) -> dict[str, JsonValue] | None:
    """Return the nearest policy-approved runtime evidence for a business failure.

    Manual/random workflow suffixes are mapped against exact policy IDs. Latest and
    history rows are eligible only with businessFailures>0 and technicalFailures=0.
    Workflows without an explicit business_failed policy remain technical.
    """
    if str(item.get('status') or '') != 'FAILED':
        return None
    runtime_dir = runtime_dir or (OPS / 'runtime-v2')
    runtime_status_policy = runtime_status_policy if runtime_status_policy is not None else JSON_OBJECT.validate_python(load_json(RUNTIME_STATUS_POLICY, {}))
    entries = accepted_business_entries(runtime_status_policy)
    legacy_id = workflow_legacy_id(item.get('workflowId'), set(entries))
    if not legacy_id or legacy_id not in entries:
        return None
    try:
        started_at = datetime.fromisoformat(str(item.get('startTime') or '')).astimezone(UTC)
    except (OSError, ValueError):
        return None
    nearest: tuple[float, dict[str, JsonValue]] | None = None
    for report in runtime_evidence_candidates(legacy_id, runtime_dir):
        counts = JSON_OBJECT.validate_python(report.get('counts') or {})
        if report.get('status') != 'business_failed' or INTEGER.validate_python(counts.get('businessFailures') or 0) <= 0 or INTEGER.validate_python(counts.get('technicalFailures') or 0) != 0:
            continue
        try:
            report_at = datetime.fromisoformat(str(report.get('generatedAt') or '')).astimezone(UTC)
            distance = abs((report_at - started_at).total_seconds())
        except (OSError, ValueError):
            continue
        if distance <= max_evidence_distance_seconds and (nearest is None or distance < nearest[0]):
            nearest = (distance, report)
    if nearest is None:
        return None
    distance, report = nearest
    return {'legacyId': legacy_id, 'runtimeEvidencePath': report.get('path'), 'runtimeEvidenceSource': report.get('source'), 'runtimeHistoryLine': report.get('historyLine'), 'runtimeGeneratedAt': report.get('generatedAt'), 'evidenceDistanceSeconds': round(distance, 3)}


def main() -> dict[str, JsonValue]:
    policy = JSON_OBJECT.validate_python(load_json(POLICY, {}))
    errors: list[dict[str, JsonValue]] = []
    warnings: list[dict[str, JsonValue]] = []
    data: dict[str, JsonValue] = {'running': [], 'recent': [], 'targetHost': None, 'namespace': None}
    if not policy:
        errors.append({'code': 'temporal_slo_policy_missing_or_invalid'})
    else:
        try:
            data = asyncio.run(collect(policy))
        except Exception as exc:
            logging.getLogger(__name__).exception('Temporal connectivity or listing failed')
            errors.append({'code': 'temporal_sdk_connect_or_list_failed', 'message': repr(exc)})
    max_running_age = float(NUMBER.validate_python(policy.get('maxRunningAgeMinutes', 90.0)))
    old_running = [r for r in JSON_ROWS.validate_python(data.get('running', [])) if r.get('ageMinutes') is not None and float(NUMBER.validate_python(r['ageMinutes'])) > max_running_age]
    recent_rate_scope = [
        r for r in JSON_ROWS.validate_python(data.get('recent', []))
        if not str(r.get('workflowId') or '').startswith('rbw.oss-temporal-execution-slo-guard')
    ]
    self_cycle_excluded = len(JSON_ROWS.validate_python(data.get('recent', []))) - len(recent_rate_scope)
    controlled_business_failures: list[dict[str, JsonValue]] = []
    technical_rate_scope: list[dict[str, JsonValue]] = []
    exclude_business = bool(policy.get('excludeVerifiedBusinessFailuresFromTechnicalRate', True))
    runtime_status_policy = JSON_OBJECT.validate_python(load_json(RUNTIME_STATUS_POLICY, {}))
    for row in recent_rate_scope:
        evidence = controlled_business_failure(row, runtime_status_policy=runtime_status_policy) if exclude_business else None
        if evidence:
            controlled_business_failures.append({**row, 'businessFailureEvidence': evidence})
        else:
            technical_rate_scope.append(row)
    bad_recent = [r for r in technical_rate_scope if str(r.get('status')) in BAD_STATUSES]
    terminal_recent = [r for r in technical_rate_scope if r.get('status') != 'RUNNING']
    bad_terminal_rate = round(len(bad_recent) / len(terminal_recent), 4) if terminal_recent else 0.0
    recent_bad_mode = str(policy.get('recentBadTerminalMode') or 'warning')
    max_bad_terminal_rate = float(NUMBER.validate_python(policy.get('maxRecentBadTerminalRate', 0.05)))
    if old_running:
        errors.append({'code': 'old_running_workflows', 'count': len(old_running), 'maxRunningAgeMinutes': max_running_age, 'sample': list(old_running[:30])})
    if bad_recent:
        finding: dict[str, JsonValue] = {'code': 'recent_failed_or_terminated_workflows', 'count': len(bad_recent), 'rate': bad_terminal_rate, 'maxRate': max_bad_terminal_rate, 'sample': list(bad_recent[:40])}
        if recent_bad_mode == 'error_above_rate' and bad_terminal_rate > max_bad_terminal_rate:
            errors.append(finding)
        else:
            warnings.append(finding)
    status_counts: dict[str, int] = {}
    for item in JSON_ROWS.validate_python(data.get('recent', [])):
        status_counts[str(item.get('status', 'UNKNOWN'))] = status_counts.get(str(item.get('status', 'UNKNOWN')), 0) + 1
    ok = not errors
    payload = JSON_OBJECT.validate_python({
        'capabilityId': SLUG,
        'ok': ok,
        'status': 'passed' if ok and not warnings else 'warning' if ok else 'failed',
        'generatedAt': now_iso(),
        'summary': 'Temporal execution SLO guard checks SDK connectivity, old running workflows, and recent failed/terminated/timed-out executions.',
        'policy': {'path': str(POLICY), 'loaded': bool(policy), 'version': policy.get('schemaVersion'), 'runtimeStatusPolicyPath': str(RUNTIME_STATUS_POLICY), 'runtimeStatusPolicyLoaded': bool(runtime_status_policy), 'runtimeStatusPolicyVersion': runtime_status_policy.get('version')},
        'counts': {
            'runningWorkflowsSampled': len(JSON_ROWS.validate_python(data.get('running', []))),
            'recentWorkflowsSampled': len(JSON_ROWS.validate_python(data.get('recent', []))),
            'oldRunningWorkflows': len(old_running),
            'recentBadTerminalWorkflows': len(bad_recent),
            'recentTerminalWorkflows': len(terminal_recent),
            'selfCycleWorkflowsExcluded': self_cycle_excluded,
            'controlledBusinessFailuresExcluded': len(controlled_business_failures),
            'recentBadTerminalRate': bad_terminal_rate,
            'maxRecentBadTerminalRate': max_bad_terminal_rate,
            'errors': len(errors),
            'warnings': len(warnings),
        },
        'statusCountsRecent': status_counts,
        'errors': errors,
        'warnings': warnings,
        'runningSample': JSON_ROWS.validate_python(data.get('running', []))[:80],
        'controlledBusinessFailureSample': controlled_business_failures[:40],
        'recentSample': JSON_ROWS.validate_python(data.get('recent', []))[:80],
        'artifacts': {},
    })
    artifacts = write_report(SLUG, payload, title='OSS Temporal Execution SLO Guard')
    payload['artifacts'] = dict(artifacts)
    _ = write_report(SLUG, payload, title='OSS Temporal Execution SLO Guard')
    print(json.dumps({'ok': payload['ok'], 'status': payload['status'], 'counts': payload['counts'], 'artifacts': artifacts}, ensure_ascii=False))
    return payload


if __name__ == '__main__':
    _ = main()
