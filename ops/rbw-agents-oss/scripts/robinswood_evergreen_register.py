"""Install only the six approved evergreen campaign/research schedules, with rollback."""
import asyncio
import contextlib
import json
import sys
from collections.abc import Sequence
from datetime import UTC, datetime
from pathlib import Path
from typing import TypeGuard, override

from pydantic import JsonValue, TypeAdapter

ROOT=Path('/srv/rbw-agents-oss')
sys.path[:0]=[str(ROOT/'scripts'),str(ROOT/'packages'),str(ROOT/'apps/orchestrator-temporal')]
import robinswood_evergreen_france as campaign
from lib.config_mutation import ConfigMutation
from rbw_agent_runtime.catalog import CatalogCompiler
from temporalio.api.common.v1 import Payload
from temporalio.api.enums.v1.workflow_pb2 import (
    WORKFLOW_ID_REUSE_POLICY_ALLOW_DUPLICATE,
)
from temporalio.api.schedule.v1 import ScheduleAction as ScheduleActionProto
from temporalio.api.workflow.v1 import NewWorkflowExecutionInfo
from temporalio.client import (
    Client,
    Schedule,
    ScheduleActionStartWorkflow,
    ScheduleCalendarSpec,
    ScheduleRange,
    ScheduleSpec,
    ScheduleState,
)
from temporalio.common import RetryPolicy

JsonObject = dict[str, JsonValue]
Registration = tuple[JsonObject, JsonObject, str, bool]
JSON_VALUE_ADAPTER: TypeAdapter[JsonValue] = TypeAdapter(JsonValue)
JSON_OBJECT_ADAPTER: TypeAdapter[JsonObject] = TypeAdapter(dict[str, JsonValue])
def is_json_object(value: JsonValue) -> TypeGuard[JsonObject]:
    return isinstance(value, dict)


def as_object(value: JsonValue) -> JsonObject:
    if not is_json_object(value):
        raise TypeError("expected_json_object")
    return value


def object_from_data(value: object) -> JsonObject:
    return JSON_OBJECT_ADAPTER.validate_python(value)


def as_string(value: JsonValue) -> str:
    if not isinstance(value, str):
        raise TypeError("expected_json_string")
    return value


def as_objects(value: JsonValue) -> list[JsonObject]:
    if not isinstance(value, list):
        raise TypeError("expected_json_object_list")
    return [as_object(item) for item in value]


def as_json_values(value: JsonValue) -> list[JsonValue]:
    if not isinstance(value, list):
        raise TypeError("expected_json_array")
    return value


PY=str(ROOT/'.venv/bin/python');WS=str(campaign.WS)
STAMP=lambda:datetime.now(UTC).isoformat().replace('+00:00','Z')
class RecurringAction(ScheduleActionStartWorkflow):
 @override
 async def _to_proto(self, client: Client) -> ScheduleActionProto:
  action=await super()._to_proto(client);action.start_workflow.MergeFrom(NewWorkflowExecutionInfo(workflow_id_reuse_policy=WORKFLOW_ID_REUSE_POLICY_ALLOW_DUPLICATE));return action
def entries() -> list[Registration]:
 result: list[Registration] = []
 for lane in campaign.LANES:
  for maintenance in [False,True]:
   id=campaign.IDS[lane]+('-maintenance' if maintenance else '')
   name={'presse':'Presse — notoriété Robinswood','pme':'Prospection PME françaises','eti':'Prospection ETI françaises'}[lane]+(' — recherche et réponses' if maintenance else ' — campagne annuelle autonome')
   argv=[PY,str(ROOT/'scripts/robinswood_evergreen_france.py'),'--lane',lane]+(['--maintain','--research-batch','4'] if maintenance else ['--apply','--research-batch','2'])
   cron='5,35 * * * *' if maintenance else '*/10 9-11,14-17 * * 1-5'
   report=str(campaign.OPS/(id+'-last.json'))
   e_data={'legacy_id':id,'name':name,'mode':'script','category':'campaign-email-maintenance' if maintenance else 'campaign-email-execution',
    'description':'Year-round human-authorized France-only evidence-first press/SME/ETI outreach; global sender pacing, durable Gmail effect verification and qualified-outcome learning. Legacy sender holds and HDF bounce history remain preserved.',
    'command':' '.join(argv),'execution':{'backend':'argv','argv':argv,'cwd':WS,'timeout_seconds':300},
    'timeout_seconds':300,'runtimeVersion':'v2','contractVersion':'robinswood-evergreen-france-v1','cutover_ready':True,'expectsReport':True,
    'reportJsonPath':report,'businessReportJsonPath':report,'runtimeReportJsonPath':str(campaign.OPS/'runtime-v2'/(id+'-last.json')),
    'riskClass':'bounded_external_campaign_email' if not maintenance else 'bounded_campaign_evidence_maintenance',
    'sideEffects':['filesystem-write:campaign-state-and-evidence','contact-suppression:reply-bounce-or-opposition','no-paid-ads','no-crm-write','no-linkedin-write']+([] if maintenance else ['gmail-send:human-authorized-evergreen-france-only']),
    'task_queue':'campaigns','workflow_id':'rbw.'+id,'triggerType':'SchedulerTick','updatedAt':STAMP(),'updatedBy':'human-evergreen-activation-20261002'}
   e=object_from_data(e_data)
   payload_data={'legacy_id':id,'name':name,'llm_connection':'none','model':'deterministic-no-llm','requested_effect':'apply' if maintenance else 'external_send',
    'approvedForApply':True,'approvedForExternalSend':not maintenance,'approvalSource':'human_evergreen_campaign_request_2026-10-02'}
   payload=object_from_data(payload_data)
   result.append((e,payload,cron,maintenance))
 return result
def calendar_matches(spec: ScheduleSpec, cron: str) -> bool:
 if spec.end_at is not None or spec.time_zone_name!='Europe/Paris':return False
 if list(spec.cron_expressions)==[cron]:return True
 if len(spec.calendars)!=1:return False
 cal: ScheduleCalendarSpec = spec.calendars[0]
 def values(rs: Sequence[ScheduleRange]) -> set[int]:return {i for r in rs for i in range(r.start,r.end+1,r.step or 1)}
 maintenance=cron=='5,35 * * * *'
 return values(cal.second)=={0} and values(cal.minute)==({5,35} if maintenance else set(range(0,60,10))) and values(cal.hour)==(set(range(24)) if maintenance else set(range(9,12))|set(range(14,18))) and values(cal.day_of_week)==(set(range(7)) if maintenance else set(range(1,6))) and values(cal.day_of_month)==set(range(1,32)) and values(cal.month)==set(range(1,13)) and not cal.year
def add(rows: list[JsonValue], row: object, key: str) -> None:
 normalized=object_from_data(row)
 existing: list[JsonObject]=[]
 for value in rows:
  if is_json_object(value) and value.get(key)==normalized[key]:
   existing.append(value)
 if existing:
  if len(existing)!=1:raise RuntimeError('duplicate_target_entry')
  if existing[0]!=normalized:raise RuntimeError('existing_target_differs:'+str(normalized[key]))
 else:rows.append(normalized)
async def install() -> JsonObject:
 _ = campaign.contract();client=await Client.connect('127.0.0.1:57233')
 from workflows import RbwAutomationWorkflow
 cfg=ROOT/'config';created: list[str]=[];unpaused: list[str]=[];specs: list[tuple[JsonObject,JsonObject,JsonObject]]=[];description: list[JsonObject]=[]
 with ConfigMutation('robinswood-evergreen-france-activation') as mut:
  try:
   for e,payload,cron,_maintenance in entries():
    raw_id=e['legacy_id']
    if not isinstance(raw_id,str):raise TypeError('schedule_id_must_be_string')
    id=raw_id;sid='sched.'+id
    spec=ScheduleSpec(cron_expressions=[cron],time_zone_name='Europe/Paris')
    try:
     prior=await client.get_schedule_handle(sid).describe()
    except Exception as exc:
     from temporalio.service import RPCError, RPCStatusCode
     if not isinstance(exc,RPCError) or exc.status!=RPCStatusCode.NOT_FOUND:raise
     prior=None
    if prior:
     action=prior.schedule.action
     if not isinstance(action,ScheduleActionStartWorkflow):
      raise RuntimeError('existing_schedule_ownership_mismatch:'+sid)
     args=action.args
     if (not calendar_matches(prior.schedule.spec,cron) or action.id!='rbw.'+id or action.task_queue!='campaigns'
         or action.workflow!='RbwAutomationWorkflow' or len(args)!=1 or not isinstance(args[0],Payload)
         or JSON_VALUE_ADAPTER.validate_json(args[0].data)!=payload):
      raise RuntimeError('existing_schedule_ownership_mismatch:'+sid)
    else:
     _ = await client.create_schedule(sid,Schedule(action=RecurringAction(RbwAutomationWorkflow.run,payload,id='rbw.'+id,task_queue='campaigns',retry_policy=RetryPolicy(maximum_attempts=1)),spec=spec,state=ScheduleState(paused=True,note='Prepared: human authorized evergreen campaigns 2026-10-02; verification pending')))
    created.append(sid)
    schedule: JsonObject={'schedule_id':sid,'workflow_id':'rbw.'+id,'task_queue':'campaigns','cron':cron,'timezone':'Europe/Paris','enabled':True,'payload':payload}
    specs.append((e,payload,schedule))
   manifest=as_object(mut.load_json(cfg/'command-manifest.json'))
   mapping=as_json_values(mut.load_json(cfg/'automation-mapping.json'))
   schedules=as_object(mut.load_json(cfg/'temporal/schedules.json'))
   ready=as_object(mut.load_json(cfg/'temporal/ready-schedules.json'))
   effects=as_object(mut.load_json(cfg/'registry/side-effects-policy.json'))
   sor=as_object(mut.load_json(cfg/'system-of-record-policy.json'))
   for e,payload,schedule in specs:
    id=as_string(e['legacy_id']);name=as_string(e['name']);add(as_json_values(manifest['wave1']),e,'legacy_id')
    mp=object_from_data({'legacy_id':id,'name':name,'triggerType':'SchedulerTick','cron':schedule['cron'],'timezone':'Europe/Paris','enabled':True,'workflow_id':'rbw.'+id,'task_queue':'campaigns','llm_connection':'none','model':'deterministic-no-llm','payload':payload})
    add(mapping,mp,'legacy_id');add(as_json_values(schedules['schedules']),schedule,'schedule_id')
    add(as_json_values(ready['schedules']),schedule|{'legacy_id':id,'name':name},'schedule_id')
    add(as_json_values(ready['items']),{'capability_id':id,'enabled':True,'mode':'temporal','payload':payload,'schedule_id':schedule['schedule_id'],'task_queue':'campaigns','workflow_id':'rbw.'+id},'capability_id')
    add(as_json_values(effects['capabilities']),{'legacy_id':id,'accepted':True,'policyClass':'human_authorized_paced_campaign_gmail_execution','riskClass':e['riskClass'],'sideEffects':e['sideEffects'],'mutationMode':'bounded_contract_external_send' if payload['approvedForExternalSend'] else 'bounded_evidence_maintenance','scheduleAllowed':True,'requiresHumanApprovalForApply':True,'requiresHumanApprovalForExternalSend':True,'requiresExplicitReviewBeforeRiskIncrease':True,
     'guardrails':['Exact authorized sender and signed evergreen contract','France PME/ETI primary registry, professional mandate and exact email qualification; editorial public source for press','One contact per company; no historical contact or legacy press-hold replay','One initial and one original-thread followup without response; all effects including replies consume quotas','Global sender daily 40 weekly 200 rolling-hour 6 interval 600 seconds; lane canary one/day','Unknown effect stops and reconciles; no Gmail write retry','First new-cohort bounce or complaint pauses the lane; suppression is shared','Only attributable editorial requests or quantified business needs reward learning; never opens/SENT/bookings without independent proof','No paid budget, CRM or LinkedIn writes'],'updatedAt':STAMP(),'updatedBy':'human-evergreen-activation-20261002'},'legacy_id')
    as_object(as_object(sor['classification'])['explicitOverrides'])[id]={'classification':'none','reason':'Campaign outreach/evidence capability. Gmail exact message/thread and operation are canonical effect evidence. Existing inbound CRM pipeline remains the owner of CRM records; this capability never creates a second CRM.','reviewedAt':STAMP(),'reviewedBy':'human-evergreen-activation-20261002'}
   manifest['updatedAt']=STAMP();ready['updatedAt']=STAMP();as_object(effects['counts'])['capabilities']=len(as_json_values(effects['capabilities']))
   for name,obj in [('command-manifest.json',manifest),('automation-mapping.json',mapping),('temporal/schedules.json',schedules),('temporal/ready-schedules.json',ready),('registry/side-effects-policy.json',effects),('system-of-record-policy.json',sor)]:mut.write_json(cfg/name,obj)
   coverage=as_object(mut.load_json(cfg/'registry/script-coverage-policy.json'))
   for name in ['outbound_sender_guard.py','robinswood_evergreen_register.py','robinswood_evergreen_france_tests.py','robinswood_evergreen_audit.py']:
    add(as_json_values(coverage['acceptedOrphanScripts']),{'path':'scripts/'+name,'accepted':True,'coverageClass':'reviewed_campaign_helper','manifestCommandExpected':False,'scheduleAllowed':False,'requiresManifestBeforeScheduling':True,'policyClass':'manual_campaign_helper_or_offline_tests','allowedInvocation':['manual_direct'],'rationale':'Scoped evergreen transport/registration/read-only audit/offline test helper. No independently recurring effect.','updatedAt':STAMP(),'updatedBy':'human-evergreen-activation-20261002'},'path')
   as_object(coverage['counts'])['acceptedOrphanScripts']=len(as_json_values(coverage['acceptedOrphanScripts']));mut.write_json(cfg/'registry/script-coverage-policy.json',coverage)
   for p in (cfg/'agents-v2').rglob('*.json'):_ = mut.backup(p)
   compiler=CatalogCompiler(ROOT);built=compiler.build(write_fragments=True);valid=compiler.validate()
   if not built['ok'] or not valid['ok']:raise RuntimeError('catalog_validation_failed:'+json.dumps(valid))
   for sid in created:
    handle=client.get_schedule_handle(sid);await handle.unpause(note='Human request 2026-10-02: evergreen press and France SME/ETI; targeted tests and safety contract verified')
    unpaused.append(sid);d=await handle.describe()
    if d.schedule.state.paused or d.schedule.spec.end_at is not None or d.schedule.spec.time_zone_name!='Europe/Paris':raise RuntimeError('native_schedule_readback_failed')
    native_cron=as_string(next(x[2]['cron'] for x in specs if x[2]['schedule_id']==sid))
    if not calendar_matches(d.schedule.spec,native_cron):raise RuntimeError('native_calendar_mismatch')
    description.append({'id':sid,'paused':d.schedule.state.paused,'cron':native_cron,'nativeCalendarMatches':True,'endAt':None,'timezone':d.schedule.spec.time_zone_name,'nextActions':[x.isoformat() for x in d.info.next_action_times[:3]]})
   contract=object_from_data(campaign.contract())
   authorization=as_object(contract['authorization'])
   result=object_from_data({'ok':True,'activatedAt':STAMP(),'contractScopeSha256':as_string(authorization['scopeSha256']),
    'schedules':description,'catalogValidation':valid,'counts':built['counts'],'configurationBackups':mut.backups,
    'externalSendsDuringActivation':0})
   campaign.save(campaign.OPS/'product-campaigns/robinswood-evergreen-france/activation.json',result);return result
  except Exception:
   for sid in created:
    with contextlib.suppress(Exception):
     await client.get_schedule_handle(sid).pause(note='Evergreen activation rolled back; no automatic replay')
   for target,backup in reversed(list(mut.backups.items())):
    if backup:mut.write_text(Path(target),Path(backup).read_text())
   raise
if __name__=='__main__':
 result=asyncio.run(install())
 print(json.dumps({k:result[k] for k in ['ok','activatedAt','contractScopeSha256','schedules','counts','catalogValidation','externalSendsDuringActivation']},ensure_ascii=False))
