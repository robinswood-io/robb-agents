"""Deploy only the approved Scottish Gmail campaign capability and its schedule."""
import argparse
import asyncio
import copy
import fcntl
import hashlib
import json
import shutil
import sqlite3
import sys
from collections.abc import Sequence
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path
from typing import TypeGuard, cast, override

import scotland_conference_transport as transport
from pydantic import JsonValue, TypeAdapter

ROOT=Path('/srv/rbw-agents-oss')
sys.path[:0]=[str(ROOT/'scripts'),str(ROOT/'packages'),str(ROOT/'apps/orchestrator-temporal')]
from lib.config_mutation import ConfigMutation
from rbw_agent_runtime.catalog import CatalogCompiler
from temporalio.api.enums.v1.workflow_pb2 import (
    WORKFLOW_ID_REUSE_POLICY_ALLOW_DUPLICATE,
)
from temporalio.api.schedule.v1 import ScheduleAction as ScheduleActionProto
from temporalio.api.workflow.v1 import NewWorkflowExecutionInfo
from temporalio.client import (
    Client,
    Schedule,
    ScheduleActionStartWorkflow,
    ScheduleSpec,
    ScheduleState,
    ScheduleUpdate,
    ScheduleUpdateInput,
)
from temporalio.common import RetryPolicy

ID='scotland-executive-conference-october-2026'
SID='sched.'+ID
CRON='0,20,40 9-16 * * 1-5'
PY=str(ROOT/'.venv/bin/python')
WS='/home/craft/.craft-agent/workspaces/my-workspace-2'
REPORT=WS+'/campaigns/ops/scotland-executive-conference-october-last.json'
STAMP=lambda:datetime.now(UTC).isoformat().replace('+00:00','Z')
JsonObject = dict[str, JsonValue]
JSON_OBJECT_ADAPTER: TypeAdapter[JsonObject] = TypeAdapter(dict[str, JsonValue])
def is_json_object(value: JsonValue) -> TypeGuard[JsonObject]:
    return isinstance(value, dict)


def as_object(value: JsonValue) -> JsonObject:
    if not is_json_object(value):
        raise TypeError("expected_json_object")
    return value


def is_json_object_list(value: JsonValue) -> TypeGuard[list[JsonObject]]:
    return isinstance(value, list) and all(is_json_object(item) for item in value)


def as_objects(value: JsonValue) -> list[JsonValue]:
    if not isinstance(value, list):
        raise TypeError("expected_json_object_list")
    for item in value:
        if not is_json_object(item):
            raise TypeError("expected_json_object")
    return value


def object_from_data(value: object) -> JsonObject:
    return JSON_OBJECT_ADAPTER.validate_python(value)


def as_strings(value: JsonValue) -> list[str]:
    if not isinstance(value, list):
        raise TypeError('expected_json_string_list')
    result: list[str] = []
    for item in value:
        if not isinstance(item, str):
            raise TypeError('expected_json_string_list')
        result.append(item)
    return result


def as_string(value: JsonValue) -> str:
    if not isinstance(value, str):
        raise TypeError("expected_json_string")
    return value


def as_object_json(value: object) -> JsonObject:
    if not isinstance(value, (str, bytes, bytearray)):
        raise TypeError("expected_json_text")
    return JSON_OBJECT_ADAPTER.validate_json(value)


def fetch_one(cursor: sqlite3.Cursor) -> sqlite3.Row | None:
    value = cast(object, cursor.fetchone())
    if value is None:
        return None
    if not isinstance(value, sqlite3.Row):
        raise TypeError('expected_sqlite_row')
    return value


def row_optional_string(row: sqlite3.Row, key: str) -> str | None:
    value = cast(object, row[key])
    if value is None or isinstance(value, str):
        return value
    raise TypeError('expected_sqlite_optional_string')


def row_string(row: sqlite3.Row, key: str) -> str:
    value = cast(object, row[key])
    if not isinstance(value, str):
        raise TypeError('expected_sqlite_string')
    return value


def is_object_list(value: object) -> TypeGuard[list[object]]:
    return isinstance(value, list)


def fetch_all(cursor: sqlite3.Cursor) -> list[sqlite3.Row]:
    raw = cast(object, cursor.fetchall())
    if not is_object_list(raw):
        raise TypeError('expected_sqlite_rows')
    rows: list[sqlite3.Row] = []
    for value in raw:
        item = value
        if not isinstance(item, sqlite3.Row):
            raise TypeError('expected_sqlite_row')
        rows.append(item)
    return rows


class RecurringAction(ScheduleActionStartWorkflow):
 @override
 async def _to_proto(self, client: Client) -> ScheduleActionProto:
  action=await super()._to_proto(client)
  action.start_workflow.MergeFrom(NewWorkflowExecutionInfo(workflow_id_reuse_policy=WORKFLOW_ID_REUSE_POLICY_ALLOW_DUPLICATE))
  return action
def entry() -> JsonObject:
 return as_object({'legacy_id':ID,'name':'Scottish executive conference — paced Gmail campaign','mode':'script','category':'campaign-email-execution','description':'English in-company AI conference, 7–14 October 2026. Human-authorized campaign contract; verified >35 Scottish-company executives, native Gmail effect checks, one active contact per company, suppression and qualified-response A/B learning. CRM is owned by the existing inbound pipeline.','command':PY+' '+str(ROOT/'scripts/scotland_executive_conference_october.py')+' --apply','execution':{'backend':'argv','argv':[PY,str(ROOT/'scripts/scotland_executive_conference_october.py'),'--apply'],'cwd':WS,'timeout_seconds':240},'timeout_seconds':240,'runtimeVersion':'v2','contractVersion':'scotland-conference-campaign-v2','cutover_ready':True,'expectsReport':True,'reportJsonPath':REPORT,'businessReportJsonPath':REPORT,'runtimeReportJsonPath':WS+'/campaigns/ops/runtime-v2/'+ID+'-last.json','riskClass':'bounded_external_campaign_email','sideEffects':['gmail-send:approved-scottish-conference-only','filesystem-write:campaign-state-and-evidence','contact-suppression:reply-or-bounce','no-paid-ads','no-crm-write'],'task_queue':'campaigns','workflow_id':'rbw.'+ID,'triggerType':'SchedulerTick','updatedAt':STAMP(),'updatedBy':ID})
def append_unique(rows: list[JsonValue], row: object, key: str) -> None:
 normalized=object_from_data(row)
 existing: list[JsonObject]=[]
 for value in rows:
  if is_json_object(value) and value.get(key)==normalized[key]:
   existing.append(value)
 if existing:
  if len(existing)!=1:raise RuntimeError('duplicate_target_entry')
  if existing[0]!=normalized:raise RuntimeError('existing_target_differs:'+str(normalized[key]))
 else:rows.append(normalized)
def register() -> JsonObject:
 cfg=ROOT/'config';e=entry()
 payload: JsonObject ={'legacy_id':ID,'name':e['name'],'llm_connection':'none','model':'deterministic-no-llm','requested_effect':'external_send','approvedForApply':True,'approvedForExternalSend':True,'approvalSource':'human_campaign_launch_and_schedule_request_2026-09-30'}
 mapping: JsonObject ={'legacy_id':ID,'name':e['name'],'triggerType':'SchedulerTick','cron':CRON,'timezone':'Europe/London','enabled':True,'workflow_id':'rbw.'+ID,'task_queue':'campaigns','llm_connection':'none','model':'deterministic-no-llm','payload':payload,'firstExecution':'2026-10-01T09:00:00+01:00','endExecution':'2026-10-21T17:00:00+01:00'}
 schedule: JsonObject ={'schedule_id':SID,'workflow_id':'rbw.'+ID,'task_queue':'campaigns','cron':CRON,'timezone':'Europe/London','enabled':True,'payload':payload,'start_at':'2026-10-01T08:00:00Z','end_at':'2026-10-21T16:00:00Z'}
 with ConfigMutation(ID+'-activation') as mut:
  try:
   manifest=as_object(mut.load_json(cfg/'command-manifest.json'))
   manifest_rows=as_objects(manifest.setdefault('wave1',[]))
   append_unique(manifest_rows,e,'legacy_id')
   manifest['wave1']=manifest_rows
   manifest['updatedAt']=STAMP()
   mut.write_json(cfg/'command-manifest.json',manifest)
   mp=as_objects(mut.load_json(cfg/'automation-mapping.json'))
   append_unique(mp,mapping,'legacy_id')
   mut.write_json(cfg/'automation-mapping.json',mp)
   schedules=as_object(mut.load_json(cfg/'temporal/schedules.json'))
   schedule_rows=as_objects(schedules['schedules'])
   append_unique(schedule_rows,schedule,'schedule_id')
   schedules['schedules']=schedule_rows
   mut.write_json(cfg/'temporal/schedules.json',schedules)
   ready=as_object(mut.load_json(cfg/'temporal/ready-schedules.json'))
   ready_rows=as_objects(ready['schedules'])
   append_unique(ready_rows,schedule|{'legacy_id':ID,'name':e['name']},'schedule_id')
   ready['schedules']=ready_rows
   ready_items=as_objects(ready['items'])
   append_unique(ready_items,{'capability_id':ID,'enabled':True,'mode':'temporal','payload':payload,'schedule_id':SID,'task_queue':'campaigns','workflow_id':'rbw.'+ID},'capability_id')
   ready['items']=ready_items
   ready['updatedAt']=STAMP()
   mut.write_json(cfg/'temporal/ready-schedules.json',ready)
   effects=as_object(mut.load_json(cfg/'registry/side-effects-policy.json'))
   effect_rows=as_objects(effects['capabilities'])
   append_unique(effect_rows,{'legacy_id':ID,'accepted':True,'policyClass':'human_authorized_paced_campaign_gmail_execution','riskClass':e['riskClass'],'sideEffects':e['sideEffects'],'mutationMode':'bounded_contract_external_send','scheduleAllowed':True,'requiresHumanApprovalForApply':True,'requiresHumanApprovalForExternalSend':True,'requiresExplicitReviewBeforeRiskIncrease':True,'guardrails':['2026-10-01 09:00 Europe/London start','weekday 09:00–17:00 only','one Gmail effect per run; ten touches per day; one hundred per week','one active executive per company; strict >35; fresh public role proof and email verification','unknown send effect pauses; no blind retry; opt-outs/bounces suppress','qualified responses, never opens or technical sends, drive A/B learning','no new spend, ads, LinkedIn action or CRM write'],'updatedAt':STAMP(),'updatedBy':ID},'legacy_id')
   effects['capabilities']=effect_rows
   effect_counts=as_object(effects['counts'])
   effect_counts['capabilities']=len(effect_rows)
   effects['counts']=effect_counts
   mut.write_json(cfg/'registry/side-effects-policy.json',effects)
   coverage=as_object(mut.load_json(cfg/'registry/script-coverage-policy.json'))
   coverage_rows=as_objects(coverage['acceptedOrphanScripts'])
   for name in ['scotland_conference_audience.py','scotland_executive_conference_october_tests.py','scotland_conference_transport.py']:
    append_unique(coverage_rows,{'path':'scripts/'+name,'accepted':True,'coverageClass':'reviewed_campaign_helper','manifestCommandExpected':False,'scheduleAllowed':False,'requiresManifestBeforeScheduling':True,'policyClass':'manual_campaign_helper_or_offline_tests','allowedInvocation':['manual_direct'],'rationale':'Scoped conference preparation/deployment/test helper; no independent recurring execution.','updatedAt':STAMP(),'updatedBy':ID},'path')
   coverage['acceptedOrphanScripts']=coverage_rows
   coverage_counts=as_object(coverage['counts'])
   coverage_counts['acceptedOrphanScripts']=len(coverage_rows)
   coverage['counts']=coverage_counts
   mut.write_json(cfg/'registry/script-coverage-policy.json',coverage)
   sor=as_object(mut.load_json(cfg/'system-of-record-policy.json'))
   classification=as_object(sor['classification'])
   overrides=as_object(classification['explicitOverrides'])
   overrides[ID]={'classification':'none','reason':'Execution-only Gmail dispatcher under the human-approved no-CRM-write campaign scope. Gmail message/thread IDs are the canonical proof of mail effects. Existing global inbound-email-sellsy-task-sync owns CRM activity; this wrapper does not create an alternative CRM or claim CRM completion.','reviewedAt':STAMP(),'reviewedBy':ID}
   classification['explicitOverrides']=overrides
   sor['classification']=classification
   mut.write_json(cfg/'system-of-record-policy.json',sor)
   # Generated catalog is rebuilt under the same global configuration lock.
   for path in (cfg/'agents-v2').rglob('*.json'):_ = mut.backup(path)
   compiler=CatalogCompiler(ROOT);built=compiler.build(write_fragments=True);valid=compiler.validate()
   if not built['ok'] or not valid['ok']:raise RuntimeError('catalog_validation_failed:'+json.dumps(valid))
   result=object_from_data({'ok':True,'counts':built['counts'],'validation':valid,'backups':mut.backups,'schedule':schedule})
  except Exception:
   for target,backup in reversed(list(mut.backups.items())):
    if backup:mut.write_text(Path(target),Path(backup).read_text())
   raise
 return result
def format_next_actions(values: Sequence[datetime | None]) -> list[JsonValue]:
 return [value.isoformat() if value is not None else None for value in values[:3]]

async def temporal(activate: bool = False) -> JsonObject:
 client=await Client.connect('127.0.0.1:57233')
 handle=client.get_schedule_handle(SID)
 if activate:
  desc=await handle.describe()
  if not desc.schedule.state.paused:return {'alreadyActive':True,'nextActions':format_next_actions(desc.info.next_action_times)}
  await handle.unpause(note='Human authorized campaign launch: 2026-10-01 09:00 Scotland; fresh qualification gates enforced')
 else:
  from workflows import RbwAutomationWorkflow
  payload={'legacy_id':ID,'name':entry()['name'],'llm_connection':'none','model':'deterministic-no-llm','requested_effect':'external_send','approvedForApply':True,'approvedForExternalSend':True,'approvalSource':'human_campaign_launch_and_schedule_request_2026-09-30'}
  _ = await client.create_schedule(SID,Schedule(action=RecurringAction(RbwAutomationWorkflow.run,payload,id='rbw.'+ID,task_queue='campaigns',retry_policy=RetryPolicy(maximum_attempts=1)),spec=ScheduleSpec(cron_expressions=[CRON],time_zone_name='Europe/London',start_at=datetime(2026,10,1,8,tzinfo=UTC),end_at=datetime(2026,10,21,16,tzinfo=UTC)),state=ScheduleState(paused=True,note='Prepared for verified launch on 2026-10-01 09:00 Europe/London')))
 desc=await handle.describe()
 start_at=desc.schedule.spec.start_at
 end_at=desc.schedule.spec.end_at
 if start_at is None or end_at is None:
  raise RuntimeError('schedule_bounds_missing')
 return {'scheduleId':SID,'paused':desc.schedule.state.paused,'nextActions':format_next_actions(desc.info.next_action_times),'timezone':desc.schedule.spec.time_zone_name,'startAt':start_at.isoformat(),'endAt':end_at.isoformat()}
def own_row(rows: list[JsonValue], key: str, value: JsonValue) -> JsonObject:
 matches=[x for x in rows if is_json_object(x) and x.get(key)==value]
 if len(matches)!=1:raise RuntimeError('expected_one_registered_campaign_row:'+key)
 return matches[0]

async def update_cadence(daily40: bool = False) -> JsonObject:
 import scotland_executive_conference_october as campaign
 campaign_root=campaign.OPS_REPORT.parent/'product-campaigns/scotland-executive-conference-october-2026'
 client=await Client.connect('127.0.0.1:57233')
 handle=client.get_schedule_handle(SID)
 with (campaign_root/'campaign.lock').open('a') as lock:
  fcntl.flock(lock,fcntl.LOCK_EX)
  original=campaign.CONTRACT_ADAPTER.validate_python(campaign.read(campaign_root/'campaign-contract.json'))
  campaign.verify_contract(original)
  transport.require(original['activation']=='active','campaign_must_be_active')
  cron=campaign.DAILY40_CRON if daily40 else CRON
  if daily40:
   updated=campaign.daily40_contract(original)
   scope=updated['authorization']['scopeSha256']
  else:
   transport.require(original['limits']['dailyTouches']==10 and original['limits']['weeklyTouches']==100 and original['limits'].get('maxRunTouches')==1,'unexpected_existing_campaign_caps')
   updated=copy.deepcopy(original)
   updated['limits'].update(hourlyTouches=3,minimumSendIntervalSeconds=1200)
   scope=as_string(campaign.digest(campaign.signed_scope(updated)))
   if scope!=original['authorization']['scopeSha256']:
    updated['authorization']['cadenceChange']={'source':'human_campaign_delivery_pacing_request_2026-10-01','authorizedAt':STAMP(),'previousScopeSha256':original['authorization']['scopeSha256'],'hourlyTouches':3,'minimumSendIntervalSeconds':1200,'dailyTouchesUnchanged':10,'weeklyTouchesUnchanged':100,'rationale':'Gradual first-day pacing, never a Google-guaranteed safe hourly quota.'}
    updated['authorization']['scopeSha256']=scope
   campaign.verify_contract(updated)
  # Backfill actual Gmail effect timestamps before tightening spacing. No mail is sent.
  db: sqlite3.Connection=campaign.database(campaign_root)
  pending_row=fetch_one(db.execute("SELECT count(*) FROM touches WHERE state!='sent_verified'"))
  transport.require(pending_row is not None and pending_row[0]==0,'unknown_effect_prevents_cadence_change')
  transport.require(not db.execute("SELECT 1 FROM replies WHERE kind IN ('complaint','delivery_failure')").fetchone(),'negative_delivery_signal_prevents_cadence_change')
  verified_rows=fetch_all(db.execute("SELECT * FROM touches WHERE state='sent_verified'"))
  gateway=campaign.Gateway()
  for row in verified_rows:
   item=next(x for x in original['items'] if x['id']==row_string(row,'item'))
   draft=campaign.DRAFT_ADAPTER.validate_json(row_string(row,'draft'))
   effect: object = campaign.verify_effect(gateway,row_string(row,'gmail_id'),item,draft,row_string(row,'operation'),row_string(row,'expected'),row_optional_string(row,'thread_id'))
   ok,msg,checks=TypeAdapter(tuple[bool, JsonObject, dict[str, bool | str]]).validate_python(effect)
   transport.require(ok,'existing_gmail_effect_must_verify')
   internal_date=as_string(msg['internalDate'])
   internal_date_ms=int(internal_date)
   checks['gmailSentAt']=campaign.stamp(datetime.fromtimestamp(internal_date_ms/1000,UTC))
   _ = db.execute('UPDATE touches SET checks=? WHERE item=? AND step=?',(json.dumps(checks),row['item'],row['step']))
  db.commit();db.close()
  desc=await handle.describe()
  original_spec=copy.deepcopy(desc.schedule.spec)
  transport.require(not desc.schedule.state.paused,'native_schedule_must_be_active')
  transport.require(desc.schedule.spec.time_zone_name=='Europe/London','unexpected_schedule_timezone')
  archive=ROOT/'archive'/datetime.now(UTC).strftime('%Y-%m')/(ID+'-cadence-'+datetime.now(UTC).strftime('%Y%m%dT%H%M%S%fZ'))
  _ = archive.mkdir(parents=True)
  contract_backup=archive/'campaign-contract.json'
  _ = shutil.copy2(campaign_root/'campaign-contract.json',contract_backup)
  cfg=ROOT/'config';changed: list[str]=[];native_changed=False
  with ConfigMutation(ID+'-cadence') as mut:
   try:
    campaign.save(campaign_root/'campaign-contract.json',updated)
    for rel,list_key,key,value in [
     ('automation-mapping.json',None,'legacy_id',ID),
     ('temporal/schedules.json','schedules','schedule_id',SID),
     ('temporal/ready-schedules.json','schedules','schedule_id',SID)]:
     loaded=mut.load_json(cfg/rel)
     if list_key is None:
      rows=as_objects(loaded)
     else:
      config=as_object(loaded)
      rows=as_objects(config[list_key])
     row=own_row(rows,key,value)
     transport.require(row['timezone']=='Europe/London','unexpected_config_timezone')
     before_others=campaign.digest([x for x in rows if x is not row])
     row['cron']=cron
     transport.require(before_others==campaign.digest([x for x in rows if x is not row]),'unrelated_campaign_rows_changed')
     mut.write_json(cfg/rel,loaded);changed.append(rel)
    policy=as_object(mut.load_json(cfg/'registry/side-effects-policy.json'))
    capabilities=as_objects(policy['capabilities'])
    row=own_row(capabilities,'legacy_id',ID)
    old_others=campaign.digest([x for x in capabilities if x is not row])
    guardrails=as_strings(row['guardrails'])
    row['guardrails']=[x for x in guardrails if not x.startswith('one Gmail effect per run;')]
    row['guardrails'].append('one Gmail effect per run; six touches per rolling hour; at least ten minutes between Gmail effects; forty touches per day; two hundred per week; weekdays 09:00-12:00 and 14:00-18:00 Europe/London' if daily40 else 'one Gmail effect per run; three touches per rolling hour; at least twenty minutes between Gmail effects; ten touches per day; one hundred per week')
    row['updatedAt']=STAMP();row['updatedBy']=ID+('-human-daily40-2026-10-02' if daily40 else '-human-cadence-2026-10-01')
    transport.require(old_others==campaign.digest([x for x in capabilities if x is not row]),'unrelated_side_effect_policy_changed')
    mut.write_json(cfg/'registry/side-effects-policy.json',policy);changed.append('registry/side-effects-policy.json')
    for path in (cfg/'agents-v2').rglob('*.json'):_ = mut.backup(path)
    compiler=CatalogCompiler(ROOT);built=compiler.build(write_fragments=True);valid=compiler.validate()
    transport.require(built['ok'] and valid['ok'],'catalog_validation_failed')
    def change_schedule(update: ScheduleUpdateInput) -> ScheduleUpdate:
     schedule=update.description.schedule
     schedule.spec=replace(schedule.spec,calendars=[],intervals=[],cron_expressions=[cron])
     return ScheduleUpdate(schedule=schedule)
    native_changed=True
    await handle.update(change_schedule)
    final=await handle.describe()
    transport.require(not final.schedule.state.paused and final.schedule.spec.time_zone_name=='Europe/London','cadence_activation_failed')
    result=object_from_data({'ok':True,'checkedAt':STAMP(),'scheduleId':SID,'cron':cron,'timezone':'Europe/London','paused':final.schedule.state.paused,'nextActions':[x.isoformat() for x in final.info.next_action_times[:5]],'limits':updated['limits'],'authorizationScopeSha256':scope,'previousScopeSha256':original['authorization']['scopeSha256'],'alreadyVerifiedGmailEffects':len(verified_rows),'newGmailEffects':0,'contractBackup':str(contract_backup),'configurationBackups':mut.backups,'changedConfigurationFiles':changed,'unrelatedRowsPreserved':True,'catalogValidation':valid,'sourceSha256':{name:hashlib.sha256((ROOT/'scripts'/name).read_bytes()).hexdigest() for name in ['scotland_executive_conference_october.py','scotland_conference_register.py']}})
    campaign.save(campaign_root/'cadence-activation.json',result)
    return result
   finally:
    if sys.exception() is not None:
     # Restore under the same locks; never replay an external mail effect.
     def restore_schedule(update: ScheduleUpdateInput) -> ScheduleUpdate:
      schedule=update.description.schedule;schedule.spec=original_spec
      return ScheduleUpdate(schedule=schedule)
     if native_changed:
      restore_result=await asyncio.gather(handle.update(restore_schedule),return_exceptions=True)
      if any(isinstance(value,BaseException) for value in restore_result):
       original['activation']='paused'
     for target,backup in reversed(list(mut.backups.items())):
      if backup:mut.write_text(Path(target),Path(backup).read_text())
     campaign.save(campaign_root/'campaign-contract.json',original)
if __name__=='__main__':
 class Arguments(argparse.Namespace):
  activate: bool = False
  update_cadence: bool = False
  update_daily40: bool = False
 ap=argparse.ArgumentParser()
 group=ap.add_mutually_exclusive_group()
 _ = group.add_argument('--activate',action='store_true')
 _ = group.add_argument('--update-cadence',action='store_true')
 _ = group.add_argument('--update-daily40',action='store_true')
 args=ap.parse_args(namespace=Arguments())
 out=asyncio.run(update_cadence(daily40=args.update_daily40)) if (args.update_cadence or args.update_daily40) else {'ok':True,'registration':register(),'temporal':asyncio.run(temporal(activate=args.activate))}
 print(json.dumps(out,ensure_ascii=False))
