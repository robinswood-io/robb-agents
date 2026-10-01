#!/usr/bin/env python3
from __future__ import annotations

import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

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
from runtime_v2_bridge import load_manifest_entries, preflight_invocation, run_structured_invocation  # noqa: E402

DEFAULT_POLICY = {
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
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')

def read_json(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except Exception:
        return default

def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

def append_jsonl(path: Path, row: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('a', encoding='utf-8') as fh:
        fh.write(json.dumps(row, ensure_ascii=False, separators=(',', ':')) + '\n')

def load_policy() -> dict[str, Any]:
    data = read_json(POLICY, {})
    if not isinstance(data, dict) or not data:
        write_json(POLICY, {**DEFAULT_POLICY, 'generatedAt': now_iso(), 'updatedBy': 'oss-runtime-warning-processor-default'})
        return dict(DEFAULT_POLICY)
    merged = dict(DEFAULT_POLICY)
    merged.update(data)
    return merged

def side_effects(entry: dict[str, Any]) -> list[str]:
    raw = entry.get('sideEffects')
    return [str(x) for x in raw] if isinstance(raw, list) else []

def is_safe_refresh(legacy_id: str, entry: dict[str, Any], policy: dict[str, Any]) -> tuple[bool, list[str]]:
    effects = side_effects(entry)
    effects_lower = [x.lower().replace('_', '') for x in effects]
    joined = ' '.join(effects_lower + [str(entry.get('command') or '').lower()])
    for denied in policy.get('denySideEffectSubstrings') or []:
        if str(denied).lower().replace('_', '') in joined:
            return False, [f'denied_side_effect:{denied}']
    if legacy_id in set(policy.get('explicitAllowIds') or []):
        return True, ['explicit_allow_id']
    risk = str(entry.get('riskClass') or '')
    if risk and risk in set(policy.get('safeRiskClasses') or []):
        return True, [f'safe_risk_class:{risk}']
    required = [str(x).lower() for x in (policy.get('requiredSafeSideEffectTokensAny') or [])]
    if required and effects and any(any(req in eff.lower() for req in required) for eff in effects):
        return True, ['safe_side_effect_token']
    return False, ['not_in_safe_allowlist']

def refresh_one(legacy_id: str, entry: dict[str, Any], policy: dict[str, Any]) -> dict[str, Any]:
    payload = {'legacy_id': legacy_id, 'name': entry.get('name') or legacy_id, 'event': {'source': 'oss-runtime-warning-processor', 'generatedAt': now_iso()}}
    decision = preflight_invocation(payload, entry)
    if not decision.get('allowed'):
        return {'legacy_id': legacy_id, 'ok': False, 'stage': 'preflight', 'strictReasons': decision.get('strict_reasons'), 'shadowReasons': decision.get('shadow_reasons')}
    if policy.get('mode') != 'apply_safe':
        return {'legacy_id': legacy_id, 'ok': True, 'stage': 'dry_run', 'decision': 'would_refresh'}
    extra_env = {
        'RBW_LEGACY_ID': legacy_id,
        'RBW_AUTOMATION_PAYLOAD_JSON': json.dumps(payload, ensure_ascii=False),
        'RBW_EVENT_JSON': json.dumps(payload['event'], ensure_ascii=False),
        'RBW_SESSION_ID': '',
    }
    result = run_structured_invocation(decision, extra_env=extra_env)
    js = result.get('jsonStatus') if isinstance(result.get('jsonStatus'), dict) else {}
    return {'legacy_id': legacy_id, 'ok': bool(result.get('ok')), 'stage': 'execution', 'exitCode': result.get('exitCode'), 'timeout': result.get('timeout'), 'status': js.get('status'), 'summary': js.get('summary'), 'blockingReasons': js.get('blockingReasons') or result.get('systemOfRecordReasons') or [], 'error': result.get('error') or result.get('stderrPreview') or ''}

def refresh_freshness_guard() -> dict[str, Any]:
    proc = subprocess.run([PYTHON, str(ROOT / 'scripts/oss_runtime_freshness_guard.py')], cwd=str(ROOT), capture_output=True, text=True, timeout=180)
    parsed = None
    try:
        parsed = json.loads((proc.stdout or '').strip().splitlines()[-1]) if proc.stdout.strip() else None
    except Exception:
        parsed = None
    return {'returnCode': proc.returncode, 'stdoutTail': (proc.stdout or '')[-1200:], 'stderrTail': (proc.stderr or '')[-1200:], 'parsed': parsed}

def refresh_production_health_audit() -> dict[str, Any]:
    proc = subprocess.run([PYTHON, str(ROOT / 'scripts/oss_agent_production_health_audit.py')], cwd=str(ROOT), capture_output=True, text=True, timeout=240)
    parsed = None
    try:
        parsed = json.loads((proc.stdout or '').strip().splitlines()[-1]) if proc.stdout.strip() else None
    except Exception:
        parsed = None
    return {'returnCode': proc.returncode, 'stdoutTail': (proc.stdout or '')[-1200:], 'stderrTail': (proc.stderr or '')[-1200:], 'parsed': parsed}

def health_runtime_stale_warnings(limit: int = 80) -> list[dict[str, Any]]:
    health = read_json(HEALTH_AUDIT, {})
    samples = health.get('samples') if isinstance(health.get('samples'), dict) else {}
    rows = samples.get('runtimeStaleOver72h') if isinstance(samples, dict) else []
    warnings: list[dict[str, Any]] = []
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
    guard = read_json(RUNTIME_GUARD, {})
    warnings = guard.get('warnings') if isinstance(guard, dict) else []
    if not isinstance(warnings, list):
        warnings = []
    warnings = list(warnings) + health_runtime_stale_warnings(int(policy.get('maxHealthStaleCandidatesPerRun') or 80))
    codes = set(policy.get('processableWarningCodes') or [])
    manifest = load_manifest_entries()
    max_items = int(policy.get('maxRefreshPerRun') or 12)
    processed: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    actions: list[dict[str, Any]] = []
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
            skipped.append({'legacy_id': legacy_id, 'code': code, 'reason': ','.join(reasons), 'riskClass': entry.get('riskClass'), 'sideEffects': side_effects(entry)})
            actions.append({'id': f'runtime-warning:{legacy_id}', 'priority': 'medium', 'target': legacy_id, 'reason': ','.join(reasons), 'doneCondition': 'Human explicitly authorizes refresh or wrapper is reclassified as safe report-only.'})
            continue
        if len(processed) >= max_items:
            skipped.append({'legacy_id': legacy_id, 'code': code, 'reason': 'max_refresh_per_run_reached'})
            actions.append({'id': f'runtime-warning:{legacy_id}', 'priority': 'low', 'target': legacy_id, 'reason': 'max_refresh_per_run_reached', 'doneCondition': 'Next processor run refreshes remaining safe warnings.'})
            continue
        outcome = refresh_one(legacy_id, entry, policy)
        outcome['safetyReasons'] = reasons
        outcome['warning'] = warning
        processed.append(outcome)
        if outcome.get('ok') is not True:
            actions.append({'id': f'runtime-warning-refresh-failed:{legacy_id}', 'priority': 'high', 'target': legacy_id, 'reason': outcome.get('error') or ','.join(outcome.get('blockingReasons') or []) or 'refresh_failed', 'doneCondition': 'Runtime-v2 report is fresh and ok, or failure is classified as controlled debt.'})
    refresh = refresh_freshness_guard() if policy.get('refreshRuntimeFreshnessAfterRun') else None
    refreshed_guard = read_json(RUNTIME_GUARD, {})
    counts = {'warningsSeen': len(warnings), 'processed': len(processed), 'processedOk': sum(1 for x in processed if x.get('ok') is True), 'processedFailed': sum(1 for x in processed if x.get('ok') is not True), 'skipped': len(skipped), 'actions': len(actions), 'remainingWarnings': int(((refreshed_guard.get('counts') or {}).get('warnings') or 0)) if isinstance(refreshed_guard, dict) else 0, 'remainingErrors': int(((refreshed_guard.get('counts') or {}).get('errors') or 0)) if isinstance(refreshed_guard, dict) else 0}
    ok = counts['processedFailed'] == 0 and counts['remainingErrors'] == 0 and not actions
    status = 'processed' if ok else 'needs_attention'
    lines = ['# OSS Runtime Warning Processor', '', f"- Généré : {now_iso()}", f"- Statut : **{status}**", f"- Traités : {counts['processed']} / OK : {counts['processedOk']}", f"- Restants : {counts['remainingWarnings']}", '', '## Traités']
    lines.extend([f"- {x.get('legacy_id')}: ok={x.get('ok')} status={x.get('status')}" for x in processed])
    lines.extend(['', '## Ignorés'])
    lines.extend([f"- {x.get('legacy_id')}: {x.get('reason')}" for x in skipped])
    report = {'generatedAt': now_iso(), 'contractVersion': 'oss-runtime-warning-processor-v1', 'capabilityId': 'oss-runtime-warning-processor', 'ok': ok, 'status': status, 'summary': f"oss_runtime_warning_processor: warnings={counts['warningsSeen']} processed={counts['processed']} ok={counts['processedOk']} skipped={counts['skipped']} actions={counts['actions']} remainingWarnings={counts['remainingWarnings']}", 'counts': counts, 'blockingReasons': [] if ok else ['runtime_warnings_need_attention'], 'warningReasons': [] if not skipped else ['some_warnings_skipped_by_policy'], 'artifacts': {'reportJson': str(OUT_JSON), 'reportMd': str(OUT_MD), 'actionQueue': str(QUEUE), 'historyJsonl': str(HISTORY), 'policy': str(POLICY), 'runtimeFreshness': str(RUNTIME_GUARD)}, 'checks': {'initialFreshnessRefresh': initial_freshness_refresh, 'initialHealthRefresh': initial_health_refresh, 'freshnessRefresh': refresh, 'policyMode': policy.get('mode')}, 'processed': processed, 'skipped': skipped, 'actions': actions, 'updatedBy': 'oss-runtime-warning-processor'}
    write_json(OUT_JSON, report)
    write_json(QUEUE, {'generatedAt': report['generatedAt'], 'ok': not actions, 'status': 'empty' if not actions else 'open', 'actions': actions, 'counts': {'actions': len(actions)}})
    OUT_MD.write_text('\n'.join(lines).rstrip() + '\n', encoding='utf-8')
    append_jsonl(HISTORY, {'generatedAt': report['generatedAt'], 'counts': counts, 'status': status})
    print(json.dumps({'ok': ok, 'status': status, 'summary': report['summary'], 'reportJson': str(OUT_JSON), 'actionQueue': str(QUEUE)}, ensure_ascii=False))
    return 0 if ok else 1

if __name__ == '__main__':
    raise SystemExit(main())