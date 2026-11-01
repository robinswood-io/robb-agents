from __future__ import annotations

import json
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path

from pydantic import JsonValue, TypeAdapter

ROOT = Path('/srv/rbw-agents-oss')
OPS = Path('/home/craft/.craft-agent/workspaces/my-workspace-2/campaigns/ops')
RUNTIME_GUARD = OPS / 'oss-runtime-freshness-guard-last.json'
HEALTH_AUDIT = OPS / 'oss-agent-production-health-audit.json'
POLICY = ROOT / 'config' / 'oss-runtime-warning-processor-policy.json'
OUT_JSON = OPS / 'oss-runtime-warning-processor-last.json'
OUT_MD = OPS / 'oss-runtime-warning-processor-last.md'
QUEUE = OPS / 'oss-runtime-warning-processor-action-queue.json'
HISTORY = OPS / 'oss-runtime-warning-processor-history.jsonl'
PYTHON = str(ROOT / '.venv/bin/python') if (ROOT / '.venv/bin/python').exists() else sys.executable

sys.path.insert(0, str(ROOT / 'apps/orchestrator-temporal'))
from runtime_v2_bridge import (
    load_manifest_entries,
    preflight_invocation,
    run_structured_invocation,
)

JSON_OBJECT = TypeAdapter(dict[str, JsonValue])
JSON_ARRAY = TypeAdapter(list[JsonValue])
NUMBER = TypeAdapter(str | int | float)

DEFAULT_POLICY: dict[str, JsonValue] = {
    'contractVersion': 'oss-runtime-warning-processor-policy-v1',
    'mode': 'apply_safe',
    'maxRefreshPerRun': 12,
    'processableWarningCodes': ['expected_report_stale', 'runtime_stale_over_72h'],
    'explicitAllowIds': ['operator-escalation-watcher', 'business-autonomy-queue-governor', 'oss-lock-watchdog', 'autonomy-queue-owner-governor', 'oss-ops-report-indexer'],
    'safeRiskClasses': ['observability', 'observability_report_only', 'internal_queue_governance', 'self_healing_candidate_report_only', 'campaign_impact_normalizer_report_only', 'campaign_impact_guard_dry_run', 'quote_guard_report_only', 'source_lane_learning_report_only', 'internal_report_only'],
    'requiredSafeSideEffectTokensAny': ['no_external_send', 'no_external_outbound_message', 'no_outbound_message', 'no_external_api_mutation', 'writes_report', 'writes_reports', 'writes_governance_report'],
    'denySideEffectSubstrings': ['external_send_allowed', 'gmail-send', 'whatsapp-send', 'crm-write', 'financial-write', 'adsstatusmutation', 'pause_all_enabled_campaigns', 'budgetincrease', 'bounded_hunter_lookup', 'hunter_lookup', 'sellsy_mutation', 'crm_mutation', 'finance_mutation', 'delete'],
    'refreshRuntimeFreshnessAfterRun': True,
}

def now_iso() -> str:
    return datetime.now(UTC).isoformat().replace('+00:00', 'Z')

def read_json(path: Path, default: JsonValue) -> JsonValue:
    try:
        return TypeAdapter(JsonValue).validate_json(path.read_bytes())
    except (OSError, ValueError):
        return default

def write_json(path: Path, data: JsonValue) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    _ = path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

def append_jsonl(path: Path, row: dict[str, JsonValue]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('a', encoding='utf-8') as fh:
        _ = fh.write(json.dumps(row, ensure_ascii=False, separators=(',', ':')) + '\n')

def load_policy() -> dict[str, JsonValue]:
    data = read_json(POLICY, {})
    if not isinstance(data, dict) or not data:
        raise ValueError('runtime_warning_policy_missing_or_invalid')
    merged = dict(DEFAULT_POLICY)
    merged.update(data)
    return merged

def side_effects(entry: dict[str, JsonValue]) -> list[str]:
    raw = entry.get('sideEffects')
    return [str(x) for x in raw] if isinstance(raw, list) else []

def is_safe_refresh(legacy_id: str, entry: dict[str, JsonValue], policy: dict[str, JsonValue]) -> tuple[bool, list[str]]:
    effects = side_effects(entry)
    # Only exact prohibitions are negated. Combined/unknown claims fail closed.
    prohibitions = {
        'no_external_send', 'no_external_outbound_message', 'no_outbound_message',
        'no_external_api_mutation', 'no_crm_mutation', 'no_finance_mutation',
        'no_ads_mutation', 'no_client_server_mutation_without_explicit_approval',
    }
    positive_effects = [x.lower() for x in effects if x.lower() not in prohibitions]
    def normalized(value: str) -> str:
        return value.lower().replace('_', '').replace('-', '').replace(' ', '')
    joined = normalized(' '.join(positive_effects + [str(entry.get('command') or '')]))
    denies = JSON_ARRAY.validate_python(policy.get('denySideEffectSubstrings') or []) + [
        'ssh-mutate', 'docker-restart', 'systemctl-restart',
        'infrastructure_mutation', 'runtime_restart', 'ovh-unblock',
    ]
    for denied in denies:
        if normalized(str(denied)) in joined:
            return False, [f'denied_side_effect:{denied}']
    if legacy_id in set(TypeAdapter(list[str]).validate_python(policy.get('explicitAllowIds') or [])):
        return True, ['explicit_allow_id']
    risk = str(entry.get('riskClass') or '')
    if risk and risk in set(TypeAdapter(list[str]).validate_python(policy.get('safeRiskClasses') or [])):
        return True, [f'safe_risk_class:{risk}']
    # A negative outbound claim alone cannot authorize unrelated side effects.
    if (effects and positive_effects and all(
        x.startswith(('filesystem-read:', 'filesystem-write:ops-report',
                      'filesystem-write:agent-action-queue')) or
        x in {'writes_report', 'writes_reports', 'writes_governance_report',
              'writes_internal_reports', 'writes_action_queue'}
        for x in positive_effects
    ) and 'no_external_send' in [x.lower() for x in effects]):
        return True, ['report_only_effects']
    return False, ['not_in_safe_allowlist']


def refresh_one(legacy_id: str, entry: dict[str, JsonValue], policy: dict[str, JsonValue]) -> dict[str, JsonValue]:
    payload: dict[str, JsonValue] = {'legacy_id': legacy_id, 'name': entry.get('name') or legacy_id, 'event': {'source': 'oss-runtime-warning-processor', 'generatedAt': now_iso()}}
    decision = preflight_invocation(payload, entry)
    if not decision.get('allowed'):
        return {'legacy_id': legacy_id, 'ok': False, 'stage': 'preflight', 'strictReasons': decision.get('strict_reasons'), 'shadowReasons': decision.get('shadow_reasons')}
    if policy.get('mode') != 'apply_safe':
        return {'legacy_id': legacy_id, 'ok': True, 'stage': 'dry_run', 'decision': 'would_refresh'}
    extra_env: dict[str, JsonValue] = {
        'RBW_LEGACY_ID': legacy_id,
        'RBW_AUTOMATION_PAYLOAD_JSON': json.dumps(payload, ensure_ascii=False),
        'RBW_EVENT_JSON': json.dumps(payload['event'], ensure_ascii=False),
        'RBW_SESSION_ID': '',
    }
    result = run_structured_invocation(decision, extra_env=extra_env)
    status_value = result.get('jsonStatus')
    js = status_value if isinstance(status_value, dict) else {}
    return {'legacy_id': legacy_id, 'ok': bool(result.get('ok')), 'stage': 'execution', 'exitCode': result.get('exitCode'), 'timeout': result.get('timeout'), 'status': js.get('status'), 'summary': js.get('summary'), 'blockingReasons': js.get('blockingReasons') or result.get('systemOfRecordReasons') or [], 'error': result.get('error') or result.get('stderrPreview') or ''}

def refresh_freshness_guard() -> dict[str, JsonValue]:
    proc = subprocess.run([PYTHON, str(ROOT / 'scripts/oss_runtime_freshness_guard.py')], cwd=str(ROOT), capture_output=True, text=True, timeout=180, check=False)
    parsed: JsonValue = None
    try:
        parsed = TypeAdapter(JsonValue).validate_json((proc.stdout or '').strip().splitlines()[-1]) if proc.stdout.strip() else None
    except ValueError:
        parsed = None
    return {'returnCode': proc.returncode, 'stdoutTail': (proc.stdout or '')[-1200:], 'stderrTail': (proc.stderr or '')[-1200:], 'parsed': parsed}

def refresh_production_health_audit() -> dict[str, JsonValue]:
    proc = subprocess.run([PYTHON, str(ROOT / 'scripts/oss_agent_production_health_audit.py')], cwd=str(ROOT), capture_output=True, text=True, timeout=240, check=False)
    parsed = None
    try:
        parsed = TypeAdapter(JsonValue).validate_json((proc.stdout or '').strip().splitlines()[-1]) if proc.stdout.strip() else None
    except ValueError:
        parsed = None
    return {'returnCode': proc.returncode, 'stdoutTail': (proc.stdout or '')[-1200:], 'stderrTail': (proc.stderr or '')[-1200:], 'parsed': parsed}

def health_runtime_stale_warnings(limit: int = 80) -> list[dict[str, JsonValue]]:
    health = JSON_OBJECT.validate_python(read_json(HEALTH_AUDIT, {}))
    samples_value = health.get('samples')
    samples = samples_value if isinstance(samples_value, dict) else {}
    rows = JSON_ARRAY.validate_python(samples.get('runtimeStaleOver72h') or [])
    warnings: list[dict[str, JsonValue]] = []
    seen: set[str] = set()
    for row in rows or []:
        if not isinstance(row, dict):
            continue
        legacy_id = str(row.get('id') or '')
        if not legacy_id or legacy_id in seen:
            continue
        seen.add(legacy_id)
        warnings.append({'code': 'runtime_stale_over_72h', 'legacy_id': legacy_id, 'path': row.get('runtime') or row.get('report'), 'ageHours': row.get('runtimeAgeHours') or row.get('reportAgeHours'), 'source': 'oss-agent-production-health-audit'})
        if len(warnings) >= limit:
            break
    return warnings

def main() -> int:
    policy = load_policy()
    initial_freshness_refresh = refresh_freshness_guard() if policy.get('refreshRuntimeFreshnessBeforeRun', True) else None
    initial_health_refresh = refresh_production_health_audit() if policy.get('refreshProductionHealthBeforeRun', True) else None
    guard = JSON_OBJECT.validate_python(read_json(RUNTIME_GUARD, {}))
    warnings_value = guard.get('warnings')
    warnings: list[JsonValue] = warnings_value if isinstance(warnings_value, list) else []
    warnings.extend(health_runtime_stale_warnings(int(NUMBER.validate_python(policy.get('maxHealthStaleCandidatesPerRun') or 80))))
    codes = set(TypeAdapter(list[str]).validate_python(policy.get('processableWarningCodes') or []))
    manifest = load_manifest_entries()
    max_items = int(NUMBER.validate_python(policy.get('maxRefreshPerRun') or 12))
    processed: list[dict[str, JsonValue]] = []
    skipped: list[dict[str, JsonValue]] = []
    actions: list[dict[str, JsonValue]] = []
    for warning in warnings:
        if not isinstance(warning, dict):
            continue
        code = str(warning.get('code') or '')
        legacy_id = str(warning.get('legacy_id') or '')
        if code not in codes or not legacy_id:
            skipped.append({'legacy_id': legacy_id, 'code': code, 'reason': 'warning_code_not_processable'})
            continue
        entry = manifest.get(legacy_id)
        if not entry:
            skipped.append({'legacy_id': legacy_id, 'code': code, 'reason': 'missing_manifest_entry'})
            actions.append({'id': f'runtime-warning:{legacy_id}', 'priority': 'medium', 'target': legacy_id, 'reason': 'missing_manifest_entry', 'doneCondition': 'Manifest entry restored or warning policy updated.'})
            continue
        safe, reasons = is_safe_refresh(legacy_id, entry, policy)
        if not safe:
            skipped.append({'legacy_id': legacy_id, 'code': code, 'reason': ','.join(reasons), 'riskClass': entry.get('riskClass'), 'sideEffects': list(side_effects(entry))})
            actions.append({'id': f'runtime-warning:{legacy_id}', 'priority': 'medium', 'target': legacy_id, 'reason': ','.join(reasons), 'doneCondition': 'Human explicitly authorizes refresh or wrapper is reclassified as safe report-only.'})
            continue
        if len(processed) >= max_items:
            skipped.append({'legacy_id': legacy_id, 'code': code, 'reason': 'max_refresh_per_run_reached'})
            actions.append({'id': f'runtime-warning:{legacy_id}', 'priority': 'low', 'target': legacy_id, 'reason': 'max_refresh_per_run_reached', 'doneCondition': 'Next processor run refreshes remaining safe warnings.'})
            continue
        outcome = refresh_one(legacy_id, entry, policy)
        outcome['safetyReasons'] = list(reasons)
        outcome['warning'] = warning
        processed.append(outcome)
        if outcome.get('ok') is not True:
            actions.append({'id': f'runtime-warning-refresh-failed:{legacy_id}', 'priority': 'high', 'target': legacy_id, 'reason': outcome.get('error') or ','.join(TypeAdapter(list[str]).validate_python(outcome.get('blockingReasons') or [])) or 'refresh_failed', 'doneCondition': 'Runtime-v2 report is fresh and ok, or failure is classified as controlled debt.'})
    refresh = refresh_freshness_guard() if policy.get('refreshRuntimeFreshnessAfterRun') else None
    refreshed_guard = JSON_OBJECT.validate_python(read_json(RUNTIME_GUARD, {}))
    refreshed_counts = JSON_OBJECT.validate_python(refreshed_guard.get("counts") or {})
    counts = {'warningsSeen': len(warnings), 'processed': len(processed), 'processedOk': sum(1 for x in processed if x.get('ok') is True), 'processedFailed': sum(1 for x in processed if x.get('ok') is not True), 'skipped': len(skipped), 'actions': len(actions), 'remainingWarnings': int(NUMBER.validate_python(refreshed_counts.get('warnings') or 0)), 'remainingErrors': int(NUMBER.validate_python(refreshed_counts.get('errors') or 0))}
    ok = counts['processedFailed'] == 0 and counts['remainingErrors'] == 0 and not actions
    status = 'processed' if ok else 'needs_attention'
    lines = ['# OSS Runtime Warning Processor', '', f"- Généré : {now_iso()}", f"- Statut : **{status}**", f"- Traités : {counts['processed']} / OK : {counts['processedOk']}", f"- Restants : {counts['remainingWarnings']}", '', '## Traités']
    lines.extend([f"- {x.get('legacy_id')}: ok={x.get('ok')} status={x.get('status')}" for x in processed])
    lines.extend(['', '## Ignorés'])
    lines.extend([f"- {x.get('legacy_id')}: {x.get('reason')}" for x in skipped])
    report = JSON_OBJECT.validate_python({'generatedAt': now_iso(), 'contractVersion': 'oss-runtime-warning-processor-v1', 'capabilityId': 'oss-runtime-warning-processor', 'ok': ok, 'status': status, 'summary': f"oss_runtime_warning_processor: warnings={counts['warningsSeen']} processed={counts['processed']} ok={counts['processedOk']} skipped={counts['skipped']} actions={counts['actions']} remainingWarnings={counts['remainingWarnings']}", 'counts': counts, 'blockingReasons': [] if ok else ['runtime_warnings_need_attention'], 'warningReasons': [] if not skipped else ['some_warnings_skipped_by_policy'], 'artifacts': {'reportJson': str(OUT_JSON), 'reportMd': str(OUT_MD), 'actionQueue': str(QUEUE), 'historyJsonl': str(HISTORY), 'policy': str(POLICY), 'runtimeFreshness': str(RUNTIME_GUARD)}, 'checks': {'initialFreshnessRefresh': initial_freshness_refresh, 'initialHealthRefresh': initial_health_refresh, 'freshnessRefresh': refresh, 'policyMode': policy.get('mode')}, 'processed': processed, 'skipped': skipped, 'actions': actions, 'updatedBy': 'oss-runtime-warning-processor'})
    write_json(OUT_JSON, report)
    write_json(QUEUE, {'generatedAt': report['generatedAt'], 'ok': not actions, 'status': 'empty' if not actions else 'open', 'actions': list(actions), 'counts': {'actions': len(actions)}})
    _ = OUT_MD.write_text('\n'.join(lines).rstrip() + '\n', encoding='utf-8')
    append_jsonl(HISTORY, JSON_OBJECT.validate_python({'generatedAt': report['generatedAt'], 'counts': counts, 'status': status}))
    print(json.dumps({'ok': ok, 'status': status, 'summary': report['summary'], 'reportJson': str(OUT_JSON), 'actionQueue': str(QUEUE)}, ensure_ascii=False))
    return 0 if ok else 1

if __name__ == '__main__':
    raise SystemExit(main())
