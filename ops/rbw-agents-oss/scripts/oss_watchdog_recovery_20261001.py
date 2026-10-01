#!/usr/bin/env python3
"""Scoped, archive-backed recovery. Never deploy/restart infrastructure."""
from __future__ import annotations
import argparse, ast, asyncio, hashlib, json, sys
from datetime import datetime,timezone
from pathlib import Path
ROOT=Path('/srv/rbw-agents-oss')
sys.path.insert(0,str(ROOT/'scripts'))
from lib.config_mutation import ConfigMutation
from oss_watchdog_observation import SPECS

def prepare():
    from rbw_agent_runtime.catalog import CatalogCompiler
    with ConfigMutation('oss-watchdog-recovery-20261001') as mut:
        config=ROOT/'config'
        policy_path=config/'registry/config-mutation-policy.json'
        policy=mut.load_json(policy_path)
        target='scripts/inqom_guardrail_integration_contract.py'
        digest=hashlib.sha256((ROOT/target).read_bytes()).hexdigest()
        if digest != '516be493dd0866a7eee5ea26a1a1d81ce9934bcfcf8ac73228326ab609c42eb8':
            raise ValueError('reviewed_read_only_source_changed')
        reviewed=policy.setdefault('acceptedReadOnlyProtectedConfigConsumers',[])
        if target not in reviewed: reviewed.append(target)
        records=policy.setdefault('reviewedReadOnlyProtectedConfigConsumers',[])
        if not any(r.get('path')==target and r.get('sha256')==digest for r in records):
            records.append({'id':'inqom-read-only-review-20261001','reviewedAt':datetime.now(timezone.utc).isoformat(),
                'reviewedBy':'Codex OSS watchdog recovery','path':target,'sha256':digest,
                'classification':'read_only_protected_config_consumer',
                'rationale':'Reads protected manifest; writes only dedicated OPS integration reports. No configuration writes, subprocess, network or external mutation.'})
        mut.write_json(policy_path,policy)
        manifest_path=config/'command-manifest.json'
        manifest=mut.load_json(manifest_path)
        for group in manifest.values():
            if not isinstance(group,list):continue
            for row in group:
                if not isinstance(row,dict):continue
                aid=row.get('legacy_id')
                if aid in SPECS:
                    argv=[str(ROOT/'.venv/bin/python'),str(ROOT/'scripts/oss_watchdog_observation.py'),'--legacy-id',aid]
                    row['execution']={**row.get('execution',{}),'argv':argv,'backend':'argv'}
                    row['command']=' '.join(argv)
                    row['businessReportJsonPath']=str(Path('/home/craft/.craft-agent/workspaces/my-workspace-2/campaigns/ops')/SPECS[aid][1])
                    row['reportJsonPath']=row.get('runtimeReportJsonPath',row['reportJsonPath'])
                    row['observationContractVersion']='watchdog-observation-execution-v1'
                    row['note']='Execution success means a fresh observation; observedOk/source business report exclusively govern readiness.'
                    if aid.startswith('infra-'):
                        row['sideEffects']=['ssh-read:core-server-network-and-docker-state','filesystem-write:ops-report',
                            'filesystem-write:agent-action-queue','no_external_send','no_crm_mutation','no_finance_mutation']
                        row['riskClass']='observability_report_only'
                        row['description']='Read-only infrastructure observation. Remediation remains queued; no firewall, Docker, OVH or service mutation is authorized.'
                if aid=='traid-internal-ci':
                    row['triggerType']='manual'
                    row['note']='On demand CI; native schedule intentionally paused to avoid 720 executions per day.'
        manifest['updatedBy']='oss-watchdog-recovery-20261001'
        manifest['updatedAt']=datetime.now(timezone.utc).isoformat()
        mut.write_json(manifest_path,manifest)
        for name in ['temporal/schedules.json','temporal/ready-schedules.json','automation-mapping.json']:
            path=config/name;data=mut.load_json(path)
            collections=[data] if isinstance(data,list) else [data.get(k,[]) for k in ('schedules','items','automations')]
            for rows in collections:
                for row in rows:
                    if not isinstance(row,dict):continue
                    aid=row.get('legacy_id') or row.get('payload',{}).get('legacy_id')
                    if aid=='traid-internal-ci':
                        row['enabled']=False
                        row['note']='On demand; no recurring CI execution. FrequencyOptimization preserved.'
                        if name=='automation-mapping.json':row['triggerType']='Manual'
            mut.write_json(path,data)
        generated=config/'agents-v2'
        for path in generated.rglob('*.json'):
            mut.backup(path)
        built=CatalogCompiler(ROOT).build(write_fragments=True)
        validation=CatalogCompiler(ROOT).validate()
        if not built.get('ok') or not validation.get('ok'):
            raise RuntimeError('catalog_validation_failed; restore archived configurations')
        proof={'generatedAt':datetime.now(timezone.utc).isoformat(),'phase':'prepared',
               'scope':sorted(SPECS),'ciOnDemand':True,'backups':mut.backups,'catalogValidation':validation}
        proof_path=ROOT/'logs/oss-watchdog-recovery-20261001-prepared.json'
        proof_path.write_text(json.dumps(proof,ensure_ascii=False,indent=2)+'\n')
        print(json.dumps({'ok':True,'phase':'prepared','scope':sorted(SPECS),'proof':str(proof_path)}))

def export_classifications():
    """Keep tenant-specific labels out of public source; preserve reviewed rules."""
    path=ROOT/'config/registry/oss-business-gate-classification-policy.json'
    source=ROOT/'scripts/oss_agent_business_gate_classifier.py'
    with ConfigMutation('oss-watchdog-classification-export-20261001') as mut:
        if path.exists():
            existing=mut.load_json(path)
            if existing.get('schemaVersion')!='oss-business-gate-classification-policy-v1' or not existing.get('expectedBusinessGates'):
                raise ValueError('existing_classification_policy_invalid')
            print(json.dumps({'ok':True,'alreadyExported':True,'rows':len(existing['expectedBusinessGates'])}))
            return
        raw=source.read_bytes()
        digest=hashlib.sha256(raw).hexdigest()
        if digest!='b64dd3373a0d78a0d789160866e7d191de351205392f4b0c696c98c819a2df2e':
            raise ValueError('classification_export_source_changed')
        tree=ast.parse(raw)
        rules=None
        for node in tree.body:
            if isinstance(node,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='EXPECTED_BUSINESS_GATES' for t in node.targets):
                rules=ast.literal_eval(node.value)
        if not isinstance(rules,dict) or not rules or not all(isinstance(v,dict) and all(v.get(k) for k in ('gateType','owner','reason')) for v in rules.values()):
            raise ValueError('classification_export_invalid')
        mut.write_json(path,{'schemaVersion':'oss-business-gate-classification-policy-v1',
                             'generatedAt':datetime.now(timezone.utc).isoformat(),
                             'sourceSha256':digest,'expectedBusinessGates':rules,
                             'updatedBy':'oss-watchdog-recovery-20261001'})
        proof={'ok':True,'rows':len(rules),'config':str(path),'sourceSha256':digest,'backups':mut.backups}
        (ROOT/'logs/oss-watchdog-recovery-20261001-classification-export.json').write_text(json.dumps(proof,indent=2)+'\n')
        print(json.dumps(proof))

async def resume():
    from temporalio.client import Client
    proof_path=ROOT/'logs/oss-watchdog-recovery-20261001-native-proof.json'
    proof=json.loads(proof_path.read_text())
    if set(proof['completed'])!=set(SPECS) or not proof.get('allCompleted'):
        raise ValueError('seven_native_execution_proofs_required')
    client=await Client.connect('127.0.0.1:57233',namespace='default')
    before=[];after=[]
    for aid in [*SPECS,'traid-internal-ci']:
        h=client.get_schedule_handle('sched.'+aid);d=await h.describe()
        before.append({'legacyId':aid,'paused':d.schedule.state.paused,'note':d.schedule.state.note,
                       'spec':str(d.schedule.spec),'policy':str(d.schedule.policy)})
        if aid in SPECS and d.schedule.state.paused and d.schedule.state.note!='CircuitBreaker: Continuous execution failure':
            raise ValueError('unexpected_pause_state:'+aid)
        if aid=='traid-internal-ci' and not d.schedule.state.paused:
            raise ValueError('ci_expected_to_remain_paused')
    snapshot=ROOT/'logs/oss-watchdog-recovery-20261001-schedule-before.json'
    if not snapshot.exists():snapshot.write_text(json.dumps(before,ensure_ascii=False,indent=2)+'\n')
    for aid in SPECS:
        await client.get_schedule_handle('sched.'+aid).unpause(note='Recovery 2026-10-01: fresh observation execution verified; domain findings remain enforced.')
    for old in before:
        d=await client.get_schedule_handle('sched.'+old['legacyId']).describe()
        if str(d.schedule.spec)!=old['spec'] or str(d.schedule.policy)!=old['policy']:
            raise ValueError('schedule_definition_changed:'+old['legacyId'])
        expected=old['legacyId']=='traid-internal-ci'
        if d.schedule.state.paused!=expected:raise ValueError('resume_state_mismatch')
        after.append({'legacyId':old['legacyId'],'paused':d.schedule.state.paused,'note':d.schedule.state.note})
    path=ROOT/'logs/oss-watchdog-recovery-20261001-schedule-after.json'
    path.write_text(json.dumps(after,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({'ok':True,'resumed':7,'ciOnDemand':True,'proof':str(path)}))

if __name__=='__main__':
    sys.path.insert(0,str(ROOT/'packages'))
    parser=argparse.ArgumentParser();parser.add_argument('phase',choices=['prepare','resume','export-classifications'])
    args=parser.parse_args()
    if args.phase=='prepare':prepare()
    elif args.phase=='export-classifications':export_classifications()
    else:asyncio.run(resume())
