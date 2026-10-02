#!/usr/bin/env python3
from __future__ import annotations

import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path('/srv/rbw-agents-oss')
sys.path.insert(0, str(ROOT / 'scripts'))
from lib.agent_runtime import OPS, append_jsonl, standard_report, write_json_atomic  # noqa: E402
from traid_shadow_release_provenance import restart_count_ok  # noqa: E402

CAPABILITY_ID = 'traid-onchain-liquidation-shadow-monitor'
DEV_TARGET = 'ubuntu@164.132.161.150'
OUT_JSON = OPS / f'{CAPABILITY_ID}-last.json'
OUT_MD = OPS / f'{CAPABILITY_ID}-last.md'
HISTORY = OPS / f'{CAPABILITY_ID}-history.jsonl'
ALLOWED_RECOMMENDATIONS = {
    'insufficient_data',
    'stop',
    'continue_shadow',
    'eligible_for_human_execution_review',
}
AUTHORITY_FIELDS = (
    'activation_authority',
    'transaction_authority',
    'signing_authority',
    'capital_authority',
)
SAFETY_COUNTERS = (
    'transaction_attempt_count',
    'signature_attempt_count',
    'capital_movement_count',
    'chain_mutation_count',
)
# Observer and pre-observer health timers execute on a five-minute cadence.
# A 180-second freshness budget declared a healthy service stale before its
# next allowed health pass. Keep one cadence plus transport slack.
HEARTBEAT_MAX_AGE_SECONDS = 600


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


def remote_snapshot(timeout_seconds: int = 45) -> dict[str, Any]:
    remote = r'''set -euo pipefail
python3 - <<'PYREMOTE'
import json, subprocess
from datetime import datetime, timezone
from pathlib import Path

runtime=Path('/var/lib/traid-onchain-liquidation-shadow')
current=Path('/opt/traid-onchain-shadow/current').resolve()
main_repo=Path('/srv/workspace/TRAID-main')

def command(argv):
    proc=subprocess.run(argv,text=True,capture_output=True,check=False)
    return {'returncode':proc.returncode,'stdout':proc.stdout.strip(),'stderr':proc.stderr.strip()[-500:]}

def read_json(path):
    try:
        value=json.loads(path.read_text(encoding='utf-8'))
        return value if isinstance(value,dict) else {}
    except Exception:
        return {}

def iso_age(value):
    if not isinstance(value,str) or not value:
        return None
    try:
        parsed=datetime.fromisoformat(value.replace('Z','+00:00')).astimezone(timezone.utc)
    except ValueError:
        return None
    return max(0.0,(datetime.now(timezone.utc)-parsed).total_seconds())

service=command(['systemctl','show','traid-onchain-liquidation-shadow.service','-p','ActiveState','-p','SubState','-p','Result','-p','NRestarts','-p','MainPID','-p','ActiveEnterTimestampMonotonic'])
pre_service=command(['systemctl','show','traid-onchain-pre-liquidation-shadow.service','-p','ActiveState','-p','SubState','-p','Result','-p','NRestarts','-p','MainPID','-p','ActiveEnterTimestampMonotonic'])
def properties(result):
    fields={}
    for line in result['stdout'].splitlines():
        key, separator, value = line.partition('=')
        if separator:
            fields[key] = value
    return fields
service_fields=properties(service)
pre_service_fields=properties(pre_service)
health_timer_active=command(['systemctl','is-active','traid-onchain-liquidation-shadow-healthcheck.timer'])
pre_health_timer_active=command(['systemctl','is-active','traid-onchain-pre-liquidation-shadow-healthcheck.timer'])
gate_timer_active=command(['systemctl','is-active','traid-onchain-thirty-day-gate.timer'])
health_timer_enabled=command(['systemctl','is-enabled','traid-onchain-liquidation-shadow-healthcheck.timer'])
pre_health_timer_enabled=command(['systemctl','is-enabled','traid-onchain-pre-liquidation-shadow-healthcheck.timer'])
gate_timer_enabled=command(['systemctl','is-enabled','traid-onchain-thirty-day-gate.timer'])
observer_enabled=command(['systemctl','is-enabled','traid-onchain-liquidation-shadow.service'])
pre_observer_enabled=command(['systemctl','is-enabled','traid-onchain-pre-liquidation-shadow.service'])
report=read_json(runtime/'report.json')
pre_runtime=Path('/var/lib/traid-onchain-pre-liquidation-shadow')
pre_report=read_json(pre_runtime/'report.json')
pre_heartbeat=read_json(pre_runtime/'heartbeat.json')
heartbeat=read_json(runtime/'heartbeat.json')
metrics=report.get('metrics') if isinstance(report.get('metrics'),dict) else {}
safety=report.get('safety') if isinstance(report.get('safety'),dict) else {}
chain=report.get('chain') if isinstance(report.get('chain'),dict) else {}
gate_files=sorted((runtime/'thirty-day-gate').glob('thirty-day-gate-*.json'))
gate=read_json(gate_files[-1]) if gate_files else {}
provenance=inspect_reviewed_release(current)
main_head=command(['git','-C',str(main_repo),'rev-parse','HEAD'])
origin_main=command(['git','-C',str(main_repo),'rev-parse','origin/main'])
writable=command(['find',str(current),'-xdev','-perm','/022','-print'])
endpoint_scan=command(['grep','-RFl','--','mainnet.base.org',str(runtime),str(pre_runtime)])
pre_counters=pre_report.get('counters') if isinstance(pre_report.get('counters'),dict) else {}
pre_coverage=pre_report.get('coverage') if isinstance(pre_report.get('coverage'),dict) else {}
gate_predictive=gate.get('predictive_runtime') if isinstance(gate.get('predictive_runtime'),dict) else {}
result={
  'observedAt':datetime.now(timezone.utc).isoformat().replace('+00:00','Z'),
  'currentRelease':str(current),
  'currentSha':current.name,
  'releaseProvenance':provenance,
  'mainHead':main_head['stdout'],
  'originMain':origin_main['stdout'],
  'service':{
    'activeState':service_fields.get('ActiveState'),
    'subState':service_fields.get('SubState'),
    'result':service_fields.get('Result'),
    'restartCount':int(service_fields['NRestarts']) if service_fields.get('NRestarts','').isdigit() else None,
    'mainPid':int(service_fields['MainPID']) if service_fields.get('MainPID','').isdigit() else None,
    'startMonotonic':int(service_fields['ActiveEnterTimestampMonotonic']) if service_fields.get('ActiveEnterTimestampMonotonic','').isdigit() else None,
  },
  'units':{
    'observerEnabled':observer_enabled['returncode']==0 and observer_enabled['stdout']=='enabled',
    'preObserverEnabled':pre_observer_enabled['returncode']==0 and pre_observer_enabled['stdout']=='enabled',
    'healthTimerActive':health_timer_active['returncode']==0,
    'healthTimerEnabled':health_timer_enabled['returncode']==0 and health_timer_enabled['stdout']=='enabled',
    'preHealthTimerActive':pre_health_timer_active['returncode']==0,
    'preHealthTimerEnabled':pre_health_timer_enabled['returncode']==0 and pre_health_timer_enabled['stdout']=='enabled',
    'gateTimerActive':gate_timer_active['returncode']==0,
    'gateTimerEnabled':gate_timer_enabled['returncode']==0 and gate_timer_enabled['stdout']=='enabled',
  },
  'releaseWritableEntries':len([x for x in writable['stdout'].splitlines() if x]),
  'runtime':{
    'status':report.get('status'),
    'guardPass':report.get('guard_pass'),
    'observedChainId':chain.get('observed_chain_id'),
    'lastFinalizedBlock':chain.get('last_finalized_block'),
    'lastProgressAt':chain.get('last_progress_at'),
    'heartbeatAt':heartbeat.get('heartbeat_at'),
    'heartbeatAgeSeconds':iso_age(heartbeat.get('heartbeat_at')),
    'blocksProcessedTotal':metrics.get('blocks_processed_total'),
    'eventsRecordedTotal':metrics.get('events_recorded_total'),
    'safetyCounters':{key:safety.get(key) for key in ('transaction_attempt_count','signature_attempt_count','capital_movement_count','chain_mutation_count')},
    'endpointPersisted':endpoint_scan['returncode']==0,
  },
  'preLiquidation':{
    'service':{
      'activeState':pre_service_fields.get('ActiveState'),
      'subState':pre_service_fields.get('SubState'),
      'result':pre_service_fields.get('Result'),
      'restartCount':int(pre_service_fields['NRestarts']) if pre_service_fields.get('NRestarts','').isdigit() else None,
    'mainPid':int(pre_service_fields['MainPID']) if pre_service_fields.get('MainPID','').isdigit() else None,
    'startMonotonic':int(pre_service_fields['ActiveEnterTimestampMonotonic']) if pre_service_fields.get('ActiveEnterTimestampMonotonic','').isdigit() else None,
    },
    'status':pre_report.get('status'),
    'generatedAt':pre_report.get('generated_at'),
    'heartbeatAgeSeconds':iso_age(pre_heartbeat.get('generated_at')),
    'counters':pre_counters,
    'coverage':pre_coverage,
  },
  'gate':{
    'generatedAt':gate.get('generated_at'),
    'predictiveRuntime':gate_predictive,
    'inputValidationPass':gate.get('input_validation_pass'),
    'recommendation':gate.get('recommendation'),
    'activation_authority':gate.get('activation_authority'),
    'transaction_authority':gate.get('transaction_authority'),
    'signing_authority':gate.get('signing_authority'),
    'capital_authority':gate.get('capital_authority'),
  },
}
print(json.dumps(result,ensure_ascii=False,sort_keys=True))
PYREMOTE
'''
    helper = Path(__file__).with_name('traid_shadow_release_provenance.py').read_text()
    helper = helper.replace('from __future__ import annotations\n', '', 1)
    remote = remote.replace('runtime=Path(', helper + '\n\nruntime=Path(', 1)
    cmd = [
        'ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
        '-o', 'StrictHostKeyChecking=accept-new', DEV_TARGET, remote,
    ]
    try:
        proc = subprocess.run(cmd, text=True, capture_output=True, timeout=timeout_seconds)
    except subprocess.TimeoutExpired as exc:
        return {'ok': False, 'timeout': True, 'stderrTail': str(exc.stderr or '')[-1000:]}
    parsed: dict[str, Any] = {}
    if proc.returncode == 0 and proc.stdout.strip():
        try:
            candidate = json.loads(proc.stdout.strip().splitlines()[-1])
            if isinstance(candidate, dict):
                parsed = candidate
        except json.JSONDecodeError:
            pass
    return {
        'ok': proc.returncode == 0 and bool(parsed),
        'returncode': proc.returncode,
        'stderrTail': proc.stderr[-1000:],
        'parsed': parsed,
    }


def write_markdown(report: dict[str, Any]) -> None:
    data = report.get('data') or {}
    runtime = data.get('runtime') or {}
    gate = data.get('gate') or {}
    service = data.get('service') or {}
    lines = [
        f"# TRAID onchain liquidation shadow monitor — {report.get('generatedAt')}",
        '',
        f"- Status: **{report.get('status')}**",
        f"- OK: **{report.get('ok')}**",
        f"- Summary: {report.get('summary')}",
        f"- Release: `{data.get('currentSha')}`",
        f"- Service: `{service.get('activeState')}/{service.get('subState')}`; restarts `{service.get('restartCount')}`",
        f"- Last finalized block: `{runtime.get('lastFinalizedBlock')}`",
        f"- Events recorded: `{runtime.get('eventsRecordedTotal')}`",
        f"- Gate: `{gate.get('recommendation')}`; input validation `{gate.get('inputValidationPass')}`",
        '',
        '## Blocking reasons',
    ]
    lines += [f'- {reason}' for reason in report.get('blockingReasons') or []] or ['- none']
    lines += ['', '## Warnings']
    lines += [f'- {reason}' for reason in report.get('warningReasons') or []] or ['- none']
    OUT_MD.write_text('\n'.join(lines) + '\n', encoding='utf-8')


def main() -> None:
    remote = remote_snapshot()
    data = remote.get('parsed') if isinstance(remote.get('parsed'), dict) else {}
    blocking: list[str] = []
    warnings: list[str] = []
    if remote.get('ok') is not True:
        blocking.append('dev_snapshot_unavailable')
    service = data.get('service') if isinstance(data.get('service'), dict) else {}
    units = data.get('units') if isinstance(data.get('units'), dict) else {}
    runtime = data.get('runtime') if isinstance(data.get('runtime'), dict) else {}
    pre = data.get('preLiquidation') if isinstance(data.get('preLiquidation'), dict) else {}
    pre_service = pre.get('service') if isinstance(pre.get('service'), dict) else {}
    pre_counters = pre.get('counters') if isinstance(pre.get('counters'), dict) else {}
    pre_coverage = pre.get('coverage') if isinstance(pre.get('coverage'), dict) else {}
    gate = data.get('gate') if isinstance(data.get('gate'), dict) else {}
    if service.get('activeState') != 'active' or service.get('subState') != 'running' or service.get('result') != 'success':
        blocking.append('observer_service_not_healthy')
    provenance = data.get('releaseProvenance') if isinstance(data.get('releaseProvenance'), dict) else {}
    if provenance.get('valid') is True and provenance.get('kind') == 'reviewed_manifest' and provenance.get('liveProofVerified') is not True:
        blocking.append('reviewed_release_completed_cycle_proof_missing')
    baselines = provenance.get('restartBaselines') if provenance.get('valid') is True and isinstance(provenance.get('restartBaselines'), dict) else {}
    if not restart_count_ok(service, baselines.get('primary')):
        blocking.append('observer_restart_count_nonzero')
    for key in ('observerEnabled', 'preObserverEnabled', 'healthTimerActive', 'healthTimerEnabled', 'preHealthTimerActive', 'preHealthTimerEnabled', 'gateTimerActive', 'gateTimerEnabled'):
        if units.get(key) is not True:
            blocking.append(f'{key}_false')
    current_sha = data.get('currentSha')
    if not isinstance(current_sha, str) or len(current_sha) != 40:
        blocking.append('current_release_sha_invalid')
    legacy_match = current_sha == data.get('mainHead') == data.get('originMain')
    if provenance.get('valid') is not True and not (provenance.get('kind') == 'absent' and legacy_match):
        blocking.append('release_reviewed_provenance_invalid')
    if data.get('releaseWritableEntries') != 0:
        blocking.append('release_not_immutable')
    if runtime.get('status') != 'healthy' or runtime.get('guardPass') is not True:
        blocking.append('runtime_report_not_healthy')
    if runtime.get('observedChainId') != 8453:
        blocking.append('runtime_chain_not_base')
    age = runtime.get('heartbeatAgeSeconds')
    if not isinstance(age, (int, float)) or age > HEARTBEAT_MAX_AGE_SECONDS:
        blocking.append('runtime_heartbeat_stale')
    counters = runtime.get('safetyCounters') if isinstance(runtime.get('safetyCounters'), dict) else {}
    if set(counters) != set(SAFETY_COUNTERS) or any(counters.get(key) != 0 for key in SAFETY_COUNTERS):
        blocking.append('runtime_safety_counters_nonzero_or_missing')
    if runtime.get('endpointPersisted') is not False:
        blocking.append('endpoint_persisted_in_runtime')
    if pre_service.get('activeState') != 'active' or pre_service.get('subState') != 'running' or pre_service.get('result') != 'success':
        blocking.append('pre_liquidation_service_not_healthy')
    if not restart_count_ok(pre_service, baselines.get('sidecar')):
        blocking.append('pre_liquidation_restart_count_nonzero')
    if pre.get('status') != 'ok':
        blocking.append('pre_liquidation_report_not_ok')
    pre_age = pre.get('heartbeatAgeSeconds')
    if not isinstance(pre_age, (int, float)) or pre_age > HEARTBEAT_MAX_AGE_SECONDS:
        blocking.append('pre_liquidation_heartbeat_stale')
    if any(pre_counters.get(key) != 0 for key in SAFETY_COUNTERS):
        blocking.append('pre_liquidation_safety_counters_nonzero_or_missing')
    if pre_counters.get('universe_truncated_total') != 0:
        warnings.append('pre_liquidation_universe_truncated_observation_limit')
    if pre_coverage.get('universe_backfill_complete') is not True:
        warnings.append('pre_liquidation_backfill_incomplete_expected')
    if gate.get('inputValidationPass') is not True:
        blocking.append('gate_input_validation_failed')
    if gate.get('recommendation') not in ALLOWED_RECOMMENDATIONS:
        blocking.append('gate_recommendation_invalid')
    if any(gate.get(key) is not False for key in AUTHORITY_FIELDS):
        blocking.append('gate_authority_not_false')
    predictive = gate.get('predictiveRuntime') if isinstance(gate.get('predictiveRuntime'), dict) else {}
    if predictive.get('provided') is not True or predictive.get('healthy') is not True:
        blocking.append('gate_predictive_runtime_not_healthy')
    if predictive.get('universe_truncated_total') != 0:
        warnings.append('gate_predictive_universe_truncated_observation_limit')
    if predictive.get('promotion_capability') != 'disabled_pending_point_in_time_economics_v2':
        blocking.append('gate_predictive_promotion_not_disabled')
    if gate.get('recommendation') == 'eligible_for_human_execution_review':
        warnings.append('human_execution_review_eligibility_only_no_authority')
    status = 'healthy_shadow_observer' if not blocking and not warnings else 'degraded_shadow_observer' if not blocking else 'blocked'
    summary = (
        f"traid_onchain_shadow_monitor: release={current_sha} "
        f"block={runtime.get('lastFinalizedBlock')} events={runtime.get('eventsRecordedTotal')} "
        f"pre_cycles={pre_counters.get('cycles_total')} pre_users={pre_coverage.get('universe_size')} gate={gate.get('recommendation')}"
    )
    report = standard_report(
        capability_id=CAPABILITY_ID,
        ok=not blocking,
        status=status,
        summary=summary,
        counts={
            'blockingReasons': len(blocking),
            'warnings': len(warnings),
            'blocksProcessedTotal': runtime.get('blocksProcessedTotal'),
            'eventsRecordedTotal': runtime.get('eventsRecordedTotal'),
            'preLiquidationCyclesTotal': pre_counters.get('cycles_total'),
            'preLiquidationUniverseSize': pre_coverage.get('universe_size'),
            'preLiquidationHistoricalNextBlock': pre_coverage.get('historical_next_block'),
        },
        artifacts={
            'reportJson': str(OUT_JSON),
            'reportMd': str(OUT_MD),
            'historyJsonl': str(HISTORY),
        },
        blocking_reasons=blocking,
        warning_reasons=warnings,
        checks={'remoteSnapshot': remote, 'heartbeatMaxAgeSeconds': HEARTBEAT_MAX_AGE_SECONDS, 'universeTruncationIsObservationWarning': True},
        data=data,
        updated_by='traid-onchain-liquidation-shadow-monitor-v2',
    )
    write_json_atomic(OUT_JSON, report)
    append_jsonl(HISTORY, {
        'ts': report['generatedAt'],
        'capabilityId': CAPABILITY_ID,
        'ok': report['ok'],
        'status': report['status'],
        'summary': report['summary'],
        'counts': report['counts'],
        'blockingReasons': blocking,
        'warningReasons': warnings,
    })
    write_markdown(report)
    print(json.dumps({
        'ok': report['ok'],
        'status': report['status'],
        'summary': report['summary'],
        'reportJson': str(OUT_JSON),
    }, ensure_ascii=False))
    raise SystemExit(0 if report['ok'] else 1)


if __name__ == '__main__':
    main()
