from __future__ import annotations

import argparse
import asyncio
import datetime as dt
import json
import logging
from collections import defaultdict
from pathlib import Path

from action_queue_contract import normalize_action_item
from pydantic import JsonValue, TypeAdapter
from schedule_drift_markdown import render_markdown as _render_markdown
from schedule_drift_types import AdminPolicy, BurstSample, BurstWarning, DriftRow
from temporalio.client import Client, ScheduleActionStartWorkflow, ScheduleDescription

logger = logging.getLogger(__name__)
JSON_OBJECT = TypeAdapter(dict[str, JsonValue])
JSON_ARRAY = TypeAdapter(list[JsonValue])

DEFAULT_MANIFEST = Path('/srv/rbw-agents-oss/config/temporal/schedules.json')
DEFAULT_RUNS_LOG = Path('/srv/rbw-agents-oss/logs/workflow-runs.jsonl')
DEFAULT_CONTROL = Path('/srv/rbw-agents-oss/config/agents/legacy-migration-control.json')
DEFAULT_ADMIN_POLICY = Path('/srv/rbw-agents-oss/config/admin-wrapper-queue-policy.json')
DEFAULT_OUT_JSON = Path('/home/craft/.craft-agent/workspaces/my-workspace-2/campaigns/ops/schedule-drift-report.json')
DEFAULT_OUT_MD = Path('/home/craft/.craft-agent/workspaces/my-workspace-2/campaigns/ops/schedule-drift-report.md')
IGNORED_STATUSES = {'backlog_review', 'archive_only', 'mapped_by_business_kpi_review'}
FRESHNESS_EXEMPT_LEGACY_IDS = {'schedule-drift-watchdog'}
FIRST_RUN_GRACE_HOURS_AFTER_MANIFEST_UPDATE = 72.0
CRITICAL_MAIL_LEGACY_IDS = {
    'inbound-email-sellsy-task-sync',
    'mail-autonomy-guard',
    'mail-autonomy-regression-tests',
    'client-incident-autonomy-loop',
    'client-incident-autonomy-tests',
    'client-incident-autonomy-guard',
    'bmb-wordpress-structural-audit',
}
BURST_WARN_THRESHOLD_TOTAL = 9
BURST_WARN_THRESHOLD_WATCHDOG = 5


def _as_iso_now() -> str:
    return dt.datetime.now(dt.UTC).isoformat().replace('+00:00', 'Z')


def _read_json(path: Path, default: JsonValue) -> JsonValue:
    try:
        return TypeAdapter(JsonValue).validate_json(path.read_bytes())
    except (OSError, ValueError):
        return default


def _extract_live_cron(desc: ScheduleDescription) -> list[str]:
    return list(desc.schedule.spec.cron_expressions)


def _extract_live_task_queue(desc: ScheduleDescription) -> str | None:
    action = desc.schedule.action
    return action.task_queue if isinstance(action, ScheduleActionStartWorkflow) else None


def _parse_dt(raw: JsonValue) -> dt.datetime | None:
    if not isinstance(raw, str) or not raw:
        return None
    try:
        return dt.datetime.fromisoformat(raw).astimezone(dt.UTC)
    except ValueError:
        return None


def _load_last_runs(path: Path) -> dict[str, dt.datetime]:
    out: dict[str, dt.datetime] = {}
    if not path.exists():
        return out
    for line in path.read_text(encoding='utf-8', errors='ignore').splitlines():
        line = line.strip()
        if not line.startswith('{'):
            continue
        try:
            row = JSON_OBJECT.validate_json(line)
        except ValueError:
            continue
        ts = _parse_dt(row.get('ts'))
        if ts is None:
            continue
        payload_value = row.get('payload')
        payload = payload_value if isinstance(payload_value, dict) else {}
        legacy_id = payload.get('legacy_id')
        if not isinstance(legacy_id, str) or not legacy_id:
            continue
        prev = out.get(legacy_id)
        if prev is None or ts > prev:
            out[legacy_id] = ts
    return out


def _load_migration_statuses(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    try:
        data = JSON_OBJECT.validate_json(path.read_bytes())
        rows = JSON_ARRAY.validate_python(data.get('rows', []))
    except (OSError, ValueError):
        return {}
    out: dict[str, str] = {}
    for row in rows:
        if isinstance(row, dict) and row.get('legacy_id'):
            out[str(row['legacy_id'])] = str(row.get('status') or '')
    return out


def _load_admin_policy(path: Path) -> AdminPolicy:
    data = _read_json(path, {})
    if not isinstance(data, dict):
        data = {}
    defaults_value = data.get('defaults')
    defaults = defaults_value if isinstance(defaults_value, dict) else {}
    return {
        'path': str(path),
        'adminTaskQueue': str(defaults.get('adminTaskQueue') or 'watchdog'),
        'watchdogQueueWrappers': {str(x) for x in JSON_ARRAY.validate_python(data.get('watchdogQueueWrappers', [])) if x},
        'duplicateProtectedWrappers': {str(x) for x in JSON_ARRAY.validate_python(data.get('duplicateProtectedWrappers', [])) if x},
        'loaded': path.exists(),
    }


def _max_expected_age_hours(cron: str | None) -> float:
    parts = (cron or '').split()
    if len(parts) != 5:
        return 72.0

    minute, hour, dom, month, dow = parts
    if hour == '*':
        if minute.startswith('*/'):
            try:
                n = int(minute.split('/', 1)[1])
                return max(1.0, n / 60.0 * 3.0)
            except ValueError:
                return 3.0
        return 3.0
    if hour.startswith('*/'):
        try:
            n = int(hour.split('/', 1)[1])
            return float(max(4, n * 2 + 2))
        except ValueError:
            return 12.0
    if dow not in ('*', '?') and dow not in ('1-5', '2-6', '0,2-6'):
        return 8 * 24.0
    if dow in ('1-5', '2-6', '0,2-6'):
        if ',' in hour:
            return 36.0
        return 54.0
    if ',' in hour:
        return 24.0
    if dom == '*' and month == '*':
        return 36.0
    return 72.0


def _manifest_first_run_grace_active(manifest_path: Path, now: dt.datetime) -> tuple[bool, float | None]:
    try:
        mtime = dt.datetime.fromtimestamp(manifest_path.stat().st_mtime, tz=dt.UTC)
    except OSError:
        return False, None
    age_hours = (now - mtime).total_seconds() / 3600.0
    return age_hours <= FIRST_RUN_GRACE_HOURS_AFTER_MANIFEST_UPDATE, round(age_hours, 2)


def _cron_slot(cron: str | None) -> str:
    parts = (cron or '').split()
    if len(parts) != 5:
        return 'invalid'
    return f"{parts[1]}:{parts[0]} dow={parts[4]}"


def _compute_bursts(schedules: list[dict[str, JsonValue]], admin_policy: AdminPolicy) -> list[BurstWarning]:
    by_slot: dict[str, list[BurstSample]] = defaultdict(list)
    for item in schedules:
        payload_value = item.get('payload')
        payload = payload_value if isinstance(payload_value, dict) else {}
        legacy_id = payload.get('legacy_id') or item.get('legacy_id')
        queue = item.get('task_queue') or 'default'
        if isinstance(legacy_id, str) and legacy_id in admin_policy['watchdogQueueWrappers']:
            queue = admin_policy['adminTaskQueue']
        by_slot[_cron_slot(TypeAdapter(str | None).validate_python(item.get('cron')))].append({
            'schedule_id': item.get('schedule_id'),
            'legacy_id': legacy_id,
            'task_queue': queue,
        })
    warnings: list[BurstWarning] = []
    for slot, rows in sorted(by_slot.items()):
        watchdog_count = sum(1 for r in rows if r.get('task_queue') == 'watchdog')
        if len(rows) >= BURST_WARN_THRESHOLD_TOTAL or watchdog_count >= BURST_WARN_THRESHOLD_WATCHDOG:
            warnings.append({
                'slot': slot,
                'count': len(rows),
                'watchdogCount': watchdog_count,
                'sample': rows[:12],
                'severity': 'warning',
            })
    return warnings




async def run(manifest_path: Path, runs_log_path: Path, control_path: Path, admin_policy_path: Path, out_json: Path, out_md: Path) -> dict[str, JsonValue]:
    manifest = JSON_OBJECT.validate_json(manifest_path.read_bytes())
    schedules = TypeAdapter(list[dict[str, JsonValue]]).validate_python(manifest.get('schedules', []))
    last_runs = _load_last_runs(runs_log_path)
    migration_status = _load_migration_statuses(control_path)
    admin_policy = _load_admin_policy(admin_policy_path)
    now = dt.datetime.now(dt.UTC)
    first_run_grace_active, manifest_age_hours = _manifest_first_run_grace_active(manifest_path, now)
    client = await Client.connect('127.0.0.1:57233')

    configured_legacy_ids = {
        str(JSON_OBJECT.validate_python(item.get('payload') or {}).get('legacy_id') or item.get('legacy_id'))
        for item in schedules
        if (JSON_OBJECT.validate_python(item.get('payload') or {}).get('legacy_id') or item.get('legacy_id'))
    }
    missing_critical_mail = sorted(CRITICAL_MAIL_LEGACY_IDS - configured_legacy_ids)
    burst_warnings = _compute_bursts(schedules, admin_policy)

    rows: list[DriftRow] = []
    drift_count = 0
    freshness_stale_count = 0
    ignored_count = 0
    admin_queue_drift_count = 0

    for item in schedules:
        payload_value = item.get('payload')
        payload = payload_value if isinstance(payload_value, dict) else {}
        legacy_id = item.get('legacy_id') or payload.get('legacy_id')
        legacy_id_str = str(legacy_id) if legacy_id else ''
        status = migration_status.get(legacy_id_str, '')
        included = status not in IGNORED_STATUSES
        if not included:
            ignored_count += 1

        expected_task_queue = str(item.get('task_queue') or 'default')
        policy_expected_task_queue = expected_task_queue
        queue_source = 'schedule-config'
        if legacy_id_str in admin_policy['watchdogQueueWrappers']:
            policy_expected_task_queue = admin_policy['adminTaskQueue']
            queue_source = 'admin-wrapper-queue-policy'

        row: DriftRow = {
            'schedule_id': TypeAdapter(str).validate_python(item['schedule_id']),
            'workflow_id': item.get('workflow_id'),
            'migrationStatus': status or None,
            'includedInChecks': included,
            'expected': {
                'enabled': bool(item.get('enabled', True)),
                'paused': not bool(item.get('enabled', True)),
                'cron': TypeAdapter(str | None).validate_python(item.get('cron')),
                'timezone': item.get('timezone', 'Europe/Paris'),
                'taskQueue': expected_task_queue,
                'policyTaskQueue': policy_expected_task_queue,
                'taskQueueSource': queue_source,
            },
            'live': {
                'exists': False,
                'paused': None,
                'cronExpressions': [],
                'taskQueue': None,
            },
            'driftReasons': [],
            'queuePolicyReasons': [],
            'freshness': {
                'legacyId': legacy_id,
                'lastRunAt': None,
                'ageHours': None,
                'maxExpectedAgeHours': None,
                'stale': False,
                'reasons': [],
                'firstRunGraceActive': False,
                'manifestAgeHours': manifest_age_hours,
            },
        }

        try:
            handle = client.get_schedule_handle(row['schedule_id'])
            desc = await handle.describe()
            row['live']['exists'] = True
            row['live']['paused'] = bool(desc.schedule.state.paused)
            row['live']['cronExpressions'] = _extract_live_cron(desc)
            row['live']['taskQueue'] = _extract_live_task_queue(desc)
            if included and row['live']['paused'] != row['expected']['paused']:
                row['driftReasons'].append(
                    f"paused mismatch expected={row['expected']['paused']} actual={row['live']['paused']}"
                )
            if included and row['live']['cronExpressions'] and row['expected']['cron'] not in row['live']['cronExpressions']:
                row['driftReasons'].append(
                    f"cron mismatch expected={row['expected']['cron']} actual={row['live']['cronExpressions']}"
                )
            if included and row['live']['taskQueue'] and row['live']['taskQueue'] != policy_expected_task_queue:
                row['queuePolicyReasons'].append(
                    f"task_queue mismatch expected={policy_expected_task_queue} source={queue_source} actual={row['live']['taskQueue']}"
                )
        except Exception as exc:
            logger.exception("Could not read live Temporal schedule")
            if included:
                row['driftReasons'].append(f"missing or unreadable live schedule: {exc}")

        if included and row['driftReasons']:
            drift_count += 1
        if included and row['queuePolicyReasons']:
            admin_queue_drift_count += 1

        if included and row['expected']['enabled'] and legacy_id and legacy_id_str not in FRESHNESS_EXEMPT_LEGACY_IDS:
            last_run = last_runs.get(legacy_id_str)
            max_expected_age = _max_expected_age_hours(row['expected']['cron'])
            row['freshness']['maxExpectedAgeHours'] = max_expected_age
            if last_run is None:
                if first_run_grace_active:
                    row['freshness']['firstRunGraceActive'] = True
                    row['freshness']['reasons'].append(
                        'first run grace active after recent schedule manifest update'
                    )
                else:
                    row['freshness']['stale'] = True
                    row['freshness']['reasons'].append('no run found in workflow-runs log')
            else:
                age_hours = (now - last_run).total_seconds() / 3600.0
                row['freshness']['lastRunAt'] = last_run.isoformat()
                row['freshness']['ageHours'] = round(age_hours, 2)
                if age_hours > max_expected_age:
                    if first_run_grace_active:
                        row['freshness']['firstRunGraceActive'] = True
                        row['freshness']['reasons'].append(
                            f"freshness grace active after recent schedule remediation; previous last run age_h={age_hours:.2f} threshold_h={row['freshness']['maxExpectedAgeHours']:.2f}"
                        )
                    else:
                        row['freshness']['stale'] = True
                        row['freshness']['reasons'].append(
                            f"last run too old age_h={age_hours:.2f} threshold_h={row['freshness']['maxExpectedAgeHours']:.2f}"
                        )
            if row['freshness']['stale']:
                freshness_stale_count += 1

        rows.append(row)

    blocking_reasons: list[str] = []
    if drift_count:
        blocking_reasons.append('schedule_drift_detected')
    if admin_queue_drift_count:
        blocking_reasons.append('schedule_task_queue_policy_drift')
    if missing_critical_mail:
        blocking_reasons.append('critical_mail_schedule_missing')
    if freshness_stale_count:
        blocking_reasons.append('schedule_freshness_stale')

    action_queue: list[dict[str, JsonValue]] = []
    for row in rows:
        if not row.get('includedInChecks'):
            continue
        reasons = list(row.get('driftReasons', [])) + list(row.get('queuePolicyReasons', [])) + list((row.get('freshness') or {}).get('reasons', []))
        if not reasons or (row.get('freshness') or {}).get('firstRunGraceActive') and not row.get('driftReasons') and not row.get('queuePolicyReasons'):
            continue
        action_queue.append(normalize_action_item({
            'owner': 'agent',
            'actionType': 'review_temporal_schedule_drift',
            'actionableNow': True,
            'priority': 'high' if row.get('queuePolicyReasons') else 'medium',
            'target': row['schedule_id'],
            'blockingReason': reasons[0],
            'notes': '; '.join(reasons),
            'doneCondition': 'Le schedule live correspond au manifeste actif, à la policy admin-wrapper, ou est explicitement reclassé hors périmètre.',
        }, origin_automation='schedule-drift-watchdog'))

    report = JSON_OBJECT.validate_python({
        'generatedAt': _as_iso_now(),
        'contractVersion': 'standard-v2',
        'capabilityId': 'schedule-drift-watchdog',
        'ok': drift_count == 0 and freshness_stale_count == 0 and admin_queue_drift_count == 0 and not missing_critical_mail,
        'status': 'degraded' if blocking_reasons else 'processed',
        'summary': f"drift={drift_count} queue_policy={admin_queue_drift_count} freshness={freshness_stale_count} critical_mail_missing={len(missing_critical_mail)} bursts={len(burst_warnings)} ignored={ignored_count}",
        'counts': {
            'totalSchedules': len(schedules),
            'driftCount': drift_count,
            'adminQueueDriftCount': admin_queue_drift_count,
            'freshnessStaleCount': freshness_stale_count,
            'criticalMailMissingCount': len(missing_critical_mail),
            'burstWarningCount': len(burst_warnings),
            'ignoredByMigrationStatus': ignored_count,
        },
        'blockingReasons': blocking_reasons,
        'missingCriticalMailSchedules': missing_critical_mail,
        'burstWarnings': burst_warnings,
        'actionQueue': action_queue,
        'artifacts': {
            'manifestPath': str(manifest_path),
            'runsLogPath': str(runs_log_path),
            'migrationControlPath': str(control_path),
            'adminPolicyPath': str(admin_policy_path),
            'reportJson': str(out_json),
            'reportMd': str(out_md),
        },
        'checks': {
            'temporalReachable': True,
            'migrationControlLoaded': control_path.exists(),
            'adminPolicyLoaded': admin_policy['loaded'],
            'adminTaskQueue': admin_policy['adminTaskQueue'],
            'adminWrapperCount': len(admin_policy['watchdogQueueWrappers']),
            'firstRunGraceHoursAfterManifestUpdate': FIRST_RUN_GRACE_HOURS_AFTER_MANIFEST_UPDATE,
            'manifestAgeHours': manifest_age_hours,
        },
        'rows': rows,
        'updatedBy': 'schedule-drift-watchdog',
    })

    out_json.parent.mkdir(parents=True, exist_ok=True)
    _ = out_json.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    _ = out_md.write_text(_render_markdown(report), encoding='utf-8')
    return report


def compact_summary(report: dict[str, JsonValue]) -> dict[str, JsonValue]:
    """Detailed rows remain in the report artifact, never in workflow history."""
    return {key: report.get(key) for key in
            ('ok', 'status', 'summary', 'counts', 'blockingReasons', 'artifacts')}


class Arguments(argparse.Namespace):
    manifest: str = str(DEFAULT_MANIFEST)
    runs_log: str = str(DEFAULT_RUNS_LOG)
    migration_control: str = str(DEFAULT_CONTROL)
    admin_policy: str = str(DEFAULT_ADMIN_POLICY)
    out_json: str = str(DEFAULT_OUT_JSON)
    out_md: str = str(DEFAULT_OUT_MD)


async def main() -> None:
    parser = argparse.ArgumentParser()
    _ = parser.add_argument('--manifest', default=str(DEFAULT_MANIFEST))
    _ = parser.add_argument('--runs-log', default=str(DEFAULT_RUNS_LOG))
    _ = parser.add_argument('--migration-control', default=str(DEFAULT_CONTROL))
    _ = parser.add_argument('--admin-policy', default=str(DEFAULT_ADMIN_POLICY))
    _ = parser.add_argument('--out-json', default=str(DEFAULT_OUT_JSON))
    _ = parser.add_argument('--out-md', default=str(DEFAULT_OUT_MD))
    args = parser.parse_args(namespace=Arguments())

    report = await run(
        Path(args.manifest),
        Path(args.runs_log),
        Path(args.migration_control),
        Path(args.admin_policy),
        Path(args.out_json),
        Path(args.out_md),
    )
    print(json.dumps(compact_summary(report), ensure_ascii=False))


if __name__ == '__main__':
    asyncio.run(main())