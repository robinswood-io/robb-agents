#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from lib.config_mutation import ConfigMutation

WS = Path('/home/craft/.craft-agent/workspaces/my-workspace-2')
OPS = WS / 'campaigns' / 'ops'
CONFIG = Path('/srv/rbw-agents-oss/config')

MAPPING_PATH = CONFIG / 'automation-mapping.json'
BUILD_SCHEDULES_SCRIPT = Path('/srv/rbw-agents-oss/scripts/build_temporal_schedule_manifest.py')
TRIGGERS_PATH = CONFIG / 'temporal' / 'event-triggers.json'
POLICY_PATH = CONFIG / 'provider-routing-policy.json'

AUTH_REPORT = OPS / 'auth-watchdog-last.json'
LOOP_REPORT = OPS / 'campaign-autonomy-loop-last.json'
STATE_PATH = OPS / 'provider-routing-guard-state.json'
REPORT_JSON = OPS / 'provider-routing-guard-last.json'
REPORT_MD = OPS / 'provider-routing-guard-last.md'


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


def read_json(path: Path, default: Any):
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except Exception:
        return default


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding='utf-8')


def load_policy() -> dict[str, Any]:
    default = {
        'modes': {
            'openrouter_free_first': {
                'llm_connection': 'openrouter',
                'model': 'nvidia/nemotron-3-super-120b-a12b:free',
            },
            'ovh_fallback': {
                'llm_connection': 'ovh-ai',
                'model': 'Qwen3-Coder-30B-A3B-Instruct',
            },
        },
        'thresholds': {
            'fail_to_fallback': 2,
            'success_to_primary': 2,
        },
        'provider_failure_reasons': [
            'provider_auth_health_failed',
            'autonomy_presync_failures',
        ],
    }
    loaded = read_json(POLICY_PATH, {})
    if not isinstance(loaded, dict):
        return default
    out = default | loaded
    out['modes'] = default['modes'] | (loaded.get('modes') or {})
    out['thresholds'] = default['thresholds'] | (loaded.get('thresholds') or {})
    if not isinstance(out.get('provider_failure_reasons'), list):
        out['provider_failure_reasons'] = default['provider_failure_reasons']
    return out


def evaluate_signals(policy: dict[str, Any]) -> dict[str, Any]:
    auth = read_json(AUTH_REPORT, {})
    loop = read_json(LOOP_REPORT, {})

    active_models = ((auth.get('checks') or {}).get('activeProviderModels') or []) if isinstance(auth, dict) else []
    openrouter_active = [m for m in active_models if str(m).startswith('openrouter/')]
    auth_ok = bool((auth.get('ok') if isinstance(auth, dict) else False) and openrouter_active)

    loop_ok = bool(loop.get('ok')) if isinstance(loop, dict) else False
    blocking = list(loop.get('blockingReasons') or []) if isinstance(loop, dict) else []
    provider_failure_reasons = set(str(x) for x in (policy.get('provider_failure_reasons') or []))
    provider_blocking = any(str(x) in provider_failure_reasons for x in blocking)

    bad = (not auth_ok) or provider_blocking
    good = auth_ok and loop_ok and (not provider_blocking)

    return {
        'authOk': auth_ok,
        'loopOk': loop_ok,
        'openrouterActiveModels': openrouter_active,
        'blockingReasons': blocking,
        'providerBlocking': provider_blocking,
        'signalBad': bad,
        'signalGood': good,
    }


def desired_mode(policy: dict[str, Any], state: dict[str, Any], signals: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    thresholds = policy.get('thresholds') or {}
    fail_to_fallback = int(thresholds.get('fail_to_fallback') or 2)
    success_to_primary = int(thresholds.get('success_to_primary') or 2)

    mode = str(state.get('mode') or 'openrouter_free_first')
    fail_streak = int(state.get('failStreak') or 0)
    success_streak = int(state.get('successStreak') or 0)

    if signals.get('signalBad'):
        fail_streak += 1
        success_streak = 0
    elif signals.get('signalGood'):
        success_streak += 1
        fail_streak = 0

    new_mode = mode
    if mode == 'openrouter_free_first' and fail_streak >= fail_to_fallback:
        new_mode = 'ovh_fallback'
    elif mode == 'ovh_fallback' and success_streak >= success_to_primary:
        new_mode = 'openrouter_free_first'

    return new_mode, {
        'failStreak': fail_streak,
        'successStreak': success_streak,
        'failToFallback': fail_to_fallback,
        'successToPrimary': success_to_primary,
    }


def apply_mapping(mode_cfg: dict[str, Any], apply: bool) -> dict[str, Any]:
    rows = read_json(MAPPING_PATH, [])
    if not isinstance(rows, list):
        rows = []

    connection = str(mode_cfg.get('llm_connection') or 'openrouter')
    model = str(mode_cfg.get('model') or 'nvidia/nemotron-3-super-120b-a12b:free')

    changed = 0
    for row in rows:
        if not isinstance(row, dict):
            continue
        if row.get('llm_connection') != connection or row.get('model') != model:
            row['llm_connection'] = connection
            row['model'] = model
            changed += 1

    schedule_count = 0
    triggers = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        base = {
            'legacy_id': row.get('legacy_id'),
            'name': row.get('name'),
            'triggerType': row.get('triggerType'),
            'cron': row.get('cron'),
            'timezone': row.get('timezone', 'Europe/Paris'),
            'enabled': row.get('enabled', True),
            'workflow_id': row.get('workflow_id'),
            'task_queue': row.get('task_queue', 'default'),
            'llm_connection': row.get('llm_connection'),
            'model': row.get('model'),
        }
        if row.get('triggerType') == 'SchedulerTick':
            schedule_count += 1
        else:
            triggers.append(base)

    builder = None
    if apply:
        previous_mapping = read_json(MAPPING_PATH, [])
        previous_triggers = read_json(TRIGGERS_PATH, {})
        with ConfigMutation('provider-routing-guard') as mutation:
            mutation.write_json(MAPPING_PATH, rows)
            mutation.write_json(TRIGGERS_PATH, {'triggers': triggers})
        # schedules.json is protected: automation-mapping.json is the source of
        # truth and the strict builder is the only allowed writer.
        if BUILD_SCHEDULES_SCRIPT.exists():
            proc = subprocess.run([sys.executable, str(BUILD_SCHEDULES_SCRIPT)], capture_output=True, text=True, timeout=120)
            builder = {
                'ok': proc.returncode == 0,
                'returncode': proc.returncode,
                'stdout': (proc.stdout or '')[-1200:],
                'stderr': (proc.stderr or '')[-1200:],
            }
            if not builder['ok']:
                with ConfigMutation('provider-routing-guard-rollback') as mutation:
                    mutation.write_json(MAPPING_PATH, previous_mapping)
                    mutation.write_json(TRIGGERS_PATH, previous_triggers)
                raise RuntimeError(f"schedule builder failed: {builder['stderr'] or builder['stdout']}")

    return {
        'changedRows': changed,
        'totalRows': len(rows),
        'schedules': schedule_count,
        'triggers': len(triggers),
        'llmConnection': connection,
        'model': model,
        'scheduleBuilder': builder,
    }


def render_md(report: dict[str, Any]) -> str:
    lines = [
        '# Provider Routing Guard',
        '',
        f"- Generated at: {report.get('generatedAt')}",
        f"- Mode: {report.get('mode')}",
        f"- Applied: {report.get('applied')}",
        f"- Summary: {report.get('summary')}",
        '',
        '## Signals',
        f"- authOk: {report.get('signals', {}).get('authOk')}",
        f"- loopOk: {report.get('signals', {}).get('loopOk')}",
        f"- providerBlocking: {report.get('signals', {}).get('providerBlocking')}",
        f"- signalBad: {report.get('signals', {}).get('signalBad')}",
        f"- signalGood: {report.get('signals', {}).get('signalGood')}",
        '',
        '## Routing',
        f"- llm_connection: {report.get('routing', {}).get('llmConnection')}",
        f"- model: {report.get('routing', {}).get('model')}",
        f"- changedRows: {report.get('routing', {}).get('changedRows')}/{report.get('routing', {}).get('totalRows')}",
    ]
    return '\n'.join(lines) + '\n'


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    apply = not args.dry_run

    policy = load_policy()
    state = read_json(STATE_PATH, {})
    if not isinstance(state, dict):
        state = {}

    signals = evaluate_signals(policy)
    mode, counters = desired_mode(policy, state, signals)
    mode_cfg = (policy.get('modes') or {}).get(mode) or {}

    routing = apply_mapping(mode_cfg, apply=apply)

    summary = f"mode={mode} changed={routing['changedRows']} apply={apply}"
    report = {
        'generatedAt': now_iso(),
        'contractVersion': 'standard-v1',
        'capabilityId': 'provider-routing-guard',
        'ok': True,
        'status': 'processed',
        'summary': summary,
        'counts': {
            'changedRows': int(routing.get('changedRows') or 0),
            'totalRows': int(routing.get('totalRows') or 0),
            'schedules': int(routing.get('schedules') or 0),
            'triggers': int(routing.get('triggers') or 0),
            'failStreak': int(counters.get('failStreak') or 0),
            'successStreak': int(counters.get('successStreak') or 0),
        },
        'blockingReasons': list(signals.get('blockingReasons') or []),
        'checks': {
            'authOk': bool(signals.get('authOk')),
            'loopOk': bool(signals.get('loopOk')),
            'providerBlocking': bool(signals.get('providerBlocking')),
            'signalBad': bool(signals.get('signalBad')),
            'signalGood': bool(signals.get('signalGood')),
            'applied': bool(apply),
        },
        'mode': mode,
        'applied': apply,
        'signals': signals,
        'routing': routing,
        'counters': counters,
        'policy': {
            'thresholds': policy.get('thresholds'),
            'providerFailureReasons': policy.get('provider_failure_reasons'),
        },
        'artifacts': {
            'reportJson': str(REPORT_JSON),
            'reportMd': str(REPORT_MD),
            'stateJson': str(STATE_PATH),
            'mapping': str(MAPPING_PATH),
            'schedulesSource': str(BUILD_SCHEDULES_SCRIPT),
            'eventTriggers': str(TRIGGERS_PATH),
        },
        'updatedBy': 'provider-routing-guard',
    }

    if apply:
        write_json(STATE_PATH, {
            'mode': mode,
            'failStreak': counters['failStreak'],
            'successStreak': counters['successStreak'],
            'updatedAt': report['generatedAt'],
        })
    write_json(REPORT_JSON, report)
    write_text(REPORT_MD, render_md(report))
    print(json.dumps({'ok': report.get('ok'), 'status': report.get('status'), 'mode': report.get('mode'), 'actions': len(report.get('actions') or []), 'signals': len(report.get('signals') or []), 'reportJson': str(REPORT_JSON), 'reportMd': str(REPORT_MD)}, ensure_ascii=False))


if __name__ == '__main__':
    main()
