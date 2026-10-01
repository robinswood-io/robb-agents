#!/usr/bin/env python3
"""Run reviewed monitors without confusing a finding with a crashed observer.

ok means a fresh, attributable observation was produced. observedOk and the
unchanged business report govern domain readiness. No readiness gate is lifted.
"""
from __future__ import annotations
import argparse, fcntl, hashlib, json, os, subprocess, sys, time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path('/srv/rbw-agents-oss')
OPS = Path('/home/craft/.craft-agent/workspaces/my-workspace-2/campaigns/ops')
SPECS = {
 'temporal-rtk-token-optimization-report': ('temporal_rtk_token_optimization_report.py','temporal-rtk-token-optimization-report.json',110,()),
 'oss-runtime-warning-processor': ('oss_runtime_warning_processor.py','oss-runtime-warning-processor-last.json',840,()),
 'oss-agent-production-health-audit': ('oss_agent_production_health_audit.py','oss-agent-production-health-audit.json',280,()),
 'oss-agent-business-gate-classifier': ('oss_agent_business_gate_classifier.py','oss-agent-business-gate-classifier.json',110,()),
 'oss-temporal-execution-slo-guard': ('oss_temporal_execution_slo_guard.py','oss-temporal-execution-slo-guard-last.json',220,()),
 'infra-exposure-autoremediation-guard': ('infra_exposure_autoremediation_guard.py','infra-exposure-autoremediation-guard-last.json',400,('--no-remediate',)),
 'traid-onchain-liquidation-shadow-monitor': ('traid_onchain_liquidation_shadow_monitor.py','traid-onchain-liquidation-shadow-monitor-last.json',280,()),
}

def validate_observation(legacy_id, path, started_ns, returncode, stderr, previous_digest=None):
    if legacy_id not in SPECS:
        raise ValueError('unreviewed_observer')
    if returncode not in (0, 1):
        raise ValueError('unexpected_process_exit')
    if 'Traceback (most recent call last)' in stderr:
        raise ValueError('observer_exception')
    if path.stat().st_mtime_ns < (started_ns // 1_000_000_000) * 1_000_000_000:
        raise ValueError('report_not_refreshed')
    raw = path.read_bytes()
    if previous_digest is not None and hashlib.sha256(raw).hexdigest() == previous_digest:
        raise ValueError('report_not_refreshed')
    report = json.loads(raw)
    if not isinstance(report,dict) or report.get('capabilityId') != legacy_id:
        raise ValueError('report_identity_mismatch')
    if type(report.get('ok')) is not bool or not isinstance(report.get('status'),str):
        raise ValueError('invalid_report_envelope')
    generated = datetime.fromisoformat(str(report['generatedAt']).replace('Z','+00:00'))
    if generated.tzinfo is None or not started_ns / 1e9 - 2 <= generated.timestamp() <= time.time() + 2:
        raise ValueError('report_generation_not_current')
    if returncode == 1 and report['ok'] is True:
        raise ValueError('exit_report_conflict')
    if report['status'] in ('technical_failed','timeout'):
        raise ValueError('observer_technical_failure')
    return report, hashlib.sha256(raw).hexdigest()

def atomic_json(path, payload):
    path.parent.mkdir(parents=True,exist_ok=True)
    tmp = path.with_name('.'+path.name+'.'+str(os.getpid())+'.tmp')
    tmp.write_text(json.dumps(payload,ensure_ascii=False,indent=2)+'\n')
    os.replace(tmp,path)

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--legacy-id',choices=sorted(SPECS),required=True)
    aid=parser.parse_args().legacy_id
    script, report_name, budget, args = SPECS[aid]
    lock_path=ROOT/'.locks'/('observation-'+aid+'.lock')
    lock_path.parent.mkdir(parents=True,exist_ok=True)
    with lock_path.open('a') as lock:
        try:
            fcntl.flock(lock.fileno(),fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:
            print(json.dumps({'ok':False,'status':'technical_failed','error':'observer_already_running'}))
            return 1
        source_path=OPS/report_name
        previous_digest=hashlib.sha256(source_path.read_bytes()).hexdigest() if source_path.exists() else ''
        started_ns=time.time_ns()
        try:
            proc=subprocess.run([str(ROOT/'.venv/bin/python'),str(ROOT/'scripts'/script),*args],
                                cwd=ROOT,timeout=budget,text=True,capture_output=True)
            report,digest=validate_observation(aid,OPS/report_name,started_ns,proc.returncode,proc.stderr,previous_digest)
            payload={
              'generatedAt':datetime.now(timezone.utc).isoformat(),
              'contractVersion':'watchdog-observation-execution-v1',
              'capabilityId':aid,'ok':True,
              'status':'observed' if report['ok'] else 'observed_with_findings',
              'observedOk':report['ok'],'observedStatus':report['status'],
              'summary':'Fresh observation completed; domain readiness remains governed by observedOk and the source report.',
              'counts':report.get('counts',{}),
              'blockingReasons':[],
              'observedBlockingReasons':report.get('blockingReasons',[]),
              'observedWarningReasons':report.get('warningReasons',[]),
              'sourceReport':str(OPS/report_name),'sourceSha256':digest,
              'sourceGeneratedAt':report['generatedAt'],
              'checks':{'freshReportVerified':True,'domainGateUnchanged':True,
                        'infrastructureMutationAllowed':False if aid.startswith('infra-') else None},
              'artifacts':{'businessReport':str(OPS/report_name)},
            }
            directory=OPS/'watchdog-observations'
            atomic_json(directory/(aid+'-last.json'),payload)
            with (directory/(aid+'-history.jsonl')).open('a') as out:
                out.write(json.dumps(payload,ensure_ascii=False,separators=(',',':'))+'\n')
            if not report['ok']:
                atomic_json(directory/(aid+'-findings.json'),{
                    'generatedAt':payload['generatedAt'],'capabilityId':aid,
                    'resolved':False,'observedStatus':report['status'],
                    'sourceReport':payload['sourceReport'],'sourceSha256':digest,
                    'blockingReasons':payload['observedBlockingReasons'],
                    'warningReasons':payload['observedWarningReasons'],'counts':report.get('counts',{})})
            else:
                atomic_json(directory/(aid+'-findings.json'),{
                    'generatedAt':payload['generatedAt'],'capabilityId':aid,'resolved':True,
                    'sourceReport':payload['sourceReport'],'sourceSha256':digest})
            print(json.dumps(payload,ensure_ascii=False,separators=(',',':')))
            return 0
        except Exception as exc:
            print(json.dumps({'ok':False,'status':'technical_failed',
                              'capabilityId':aid,'errorType':type(exc).__name__,
                              'error':str(exc) if isinstance(exc,ValueError) else 'observation_not_verified'}))
            return 1
if __name__=='__main__': raise SystemExit(main())
