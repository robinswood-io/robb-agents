#!/usr/bin/env python3
"""Deploy only the approved Scottish Gmail campaign capability and its schedule."""
import argparse, asyncio, json, sys
from datetime import datetime, timezone
from pathlib import Path
ROOT=Path('/srv/rbw-agents-oss')
sys.path[:0]=[str(ROOT/'scripts'),str(ROOT/'packages'),str(ROOT/'apps/orchestrator-temporal')]
from lib.config_mutation import ConfigMutation
from rbw_agent_runtime.catalog import CatalogCompiler
from temporalio.client import Client,Schedule,ScheduleActionStartWorkflow,ScheduleSpec,ScheduleState
from temporalio.common import WorkflowIDReusePolicy,RetryPolicy
ID='scotland-executive-conference-october-2026'
SID='sched.'+ID
CRON='0,30 9-16 * * 1-5'
PY=str(ROOT/'.venv/bin/python')
WS='/home/craft/.craft-agent/workspaces/my-workspace-2'
REPORT=WS+'/campaigns/ops/scotland-executive-conference-october-last.json'
STAMP=lambda:datetime.now(timezone.utc).isoformat().replace('+00:00','Z')
class RecurringAction(ScheduleActionStartWorkflow):
 async def _to_proto(self,client):
  action=await super()._to_proto(client)
  action.start_workflow.workflow_id_reuse_policy=WorkflowIDReusePolicy.ALLOW_DUPLICATE.value
  return action
def entry():
 return {'legacy_id':ID,'name':'Scottish executive conference — paced Gmail campaign','mode':'script','category':'campaign-email-execution','description':'English in-company AI conference, 7–14 October 2026. Human-authorized campaign contract; verified >35 Scottish-company executives, native Gmail effect checks, one active contact per company, suppression and qualified-response A/B learning. CRM is owned by the existing inbound pipeline.','command':PY+' '+str(ROOT/'scripts/scotland_executive_conference_october.py')+' --apply','execution':{'backend':'argv','argv':[PY,str(ROOT/'scripts/scotland_executive_conference_october.py'),'--apply'],'cwd':WS,'timeout_seconds':240},'timeout_seconds':240,'runtimeVersion':'v2','contractVersion':'scotland-conference-campaign-v2','cutover_ready':True,'expectsReport':True,'reportJsonPath':REPORT,'businessReportJsonPath':REPORT,'runtimeReportJsonPath':WS+'/campaigns/ops/runtime-v2/'+ID+'-last.json','riskClass':'bounded_external_campaign_email','sideEffects':['gmail-send:approved-scottish-conference-only','filesystem-write:campaign-state-and-evidence','contact-suppression:reply-or-bounce','no-paid-ads','no-crm-write'],'task_queue':'campaigns','workflow_id':'rbw.'+ID,'triggerType':'SchedulerTick','updatedAt':STAMP(),'updatedBy':ID}
def append_unique(rows,row,key):
 existing=[x for x in rows if isinstance(x,dict) and x.get(key)==row[key]]
 if existing:raise RuntimeError('capability_already_registered:'+row[key])
 rows.append(row)
def register():
 cfg=ROOT/'config';e=entry()
 payload={'legacy_id':ID,'name':e['name'],'llm_connection':'none','model':'deterministic-no-llm','requested_effect':'external_send','approvedForApply':True,'approvedForExternalSend':True,'approvalSource':'human_campaign_launch_and_schedule_request_2026-09-30'}
 mapping={'legacy_id':ID,'name':e['name'],'triggerType':'SchedulerTick','cron':CRON,'timezone':'Europe/London','enabled':True,'workflow_id':'rbw.'+ID,'task_queue':'campaigns','llm_connection':'none','model':'deterministic-no-llm','payload':payload,'firstExecution':'2026-10-01T09:00:00+01:00','endExecution':'2026-10-21T17:00:00+01:00'}
 schedule={'schedule_id':SID,'workflow_id':'rbw.'+ID,'task_queue':'campaigns','cron':CRON,'timezone':'Europe/London','enabled':True,'payload':payload,'start_at':'2026-10-01T08:00:00Z','end_at':'2026-10-21T16:00:00Z'}
 with ConfigMutation(ID+'-activation') as mut:
  try:
   manifest=mut.load_json(cfg/'command-manifest.json');append_unique(manifest.setdefault('wave1',[]),e,'legacy_id');manifest['updatedAt']=STAMP();mut.write_json(cfg/'command-manifest.json',manifest)
   mp=mut.load_json(cfg/'automation-mapping.json');append_unique(mp,mapping,'legacy_id');mut.write_json(cfg/'automation-mapping.json',mp)
   schedules=mut.load_json(cfg/'temporal/schedules.json');append_unique(schedules['schedules'],schedule,'schedule_id');mut.write_json(cfg/'temporal/schedules.json',schedules)
   ready=mut.load_json(cfg/'temporal/ready-schedules.json');append_unique(ready['schedules'],schedule|{'legacy_id':ID,'name':e['name']},'schedule_id');append_unique(ready['items'],{'capability_id':ID,'enabled':True,'mode':'temporal','payload':payload,'schedule_id':SID,'task_queue':'campaigns','workflow_id':'rbw.'+ID},'capability_id');ready['updatedAt']=STAMP();mut.write_json(cfg/'temporal/ready-schedules.json',ready)
   effects=mut.load_json(cfg/'registry/side-effects-policy.json');append_unique(effects['capabilities'],{'legacy_id':ID,'accepted':True,'policyClass':'human_authorized_paced_campaign_gmail_execution','riskClass':e['riskClass'],'sideEffects':e['sideEffects'],'mutationMode':'bounded_contract_external_send','scheduleAllowed':True,'requiresHumanApprovalForApply':True,'requiresHumanApprovalForExternalSend':True,'requiresExplicitReviewBeforeRiskIncrease':True,'guardrails':['2026-10-01 09:00 Europe/London start','weekday 09:00–17:00 only','one Gmail effect per run; ten touches per day; one hundred per week','one active executive per company; strict >35; fresh public role proof and email verification','unknown send effect pauses; no blind retry; opt-outs/bounces suppress','qualified responses, never opens or technical sends, drive A/B learning','no new spend, ads, LinkedIn action or CRM write'],'updatedAt':STAMP(),'updatedBy':ID},'legacy_id');effects['counts']['capabilities']=len(effects['capabilities']);mut.write_json(cfg/'registry/side-effects-policy.json',effects)
   coverage=mut.load_json(cfg/'registry/script-coverage-policy.json')
   for name in ['scotland_conference_audience.py','scotland_executive_conference_october_tests.py','scotland_conference_register.py']:
    append_unique(coverage['acceptedOrphanScripts'],{'path':'scripts/'+name,'accepted':True,'coverageClass':'reviewed_campaign_helper','manifestCommandExpected':False,'scheduleAllowed':False,'requiresManifestBeforeScheduling':True,'policyClass':'manual_campaign_helper_or_offline_tests','allowedInvocation':['manual_direct'],'rationale':'Scoped conference preparation/deployment/test helper; no independent recurring execution.','updatedAt':STAMP(),'updatedBy':ID},'path')
   coverage['counts']['acceptedOrphanScripts']=len(coverage['acceptedOrphanScripts']);mut.write_json(cfg/'registry/script-coverage-policy.json',coverage)
   sor=mut.load_json(cfg/'system-of-record-policy.json')
   sor['classification']['explicitOverrides'][ID]={'classification':'none','reason':'Execution-only Gmail dispatcher under the human-approved no-CRM-write campaign scope. Gmail message/thread IDs are the canonical proof of mail effects. Existing global inbound-email-sellsy-task-sync owns CRM activity; this wrapper does not create an alternative CRM or claim CRM completion.','reviewedAt':STAMP(),'reviewedBy':ID}
   mut.write_json(cfg/'system-of-record-policy.json',sor)
   # Generated catalog is rebuilt under the same global configuration lock.
   for path in (cfg/'agents-v2').rglob('*.json'):mut.backup(path)
   compiler=CatalogCompiler(ROOT);built=compiler.build(write_fragments=True);valid=compiler.validate()
   if not built['ok'] or not valid['ok']:raise RuntimeError('catalog_validation_failed:'+json.dumps(valid))
   result={'ok':True,'counts':built['counts'],'validation':valid,'backups':mut.backups,'schedule':schedule}
  except Exception:
   for target,backup in reversed(list(mut.backups.items())):
    if backup:mut.write_text(Path(target),Path(backup).read_text())
   raise
 return result
async def temporal(activate=False):
 client=await Client.connect('127.0.0.1:57233')
 handle=client.get_schedule_handle(SID)
 if activate:
  desc=await handle.describe()
  if not desc.schedule.state.paused:return {'alreadyActive':True,'nextActions':[x.isoformat() for x in desc.info.next_action_times[:3]]}
  await handle.unpause(note='Human authorized campaign launch: 2026-10-01 09:00 Scotland; fresh qualification gates enforced')
 else:
  from workflows import RbwAutomationWorkflow
  payload={'legacy_id':ID,'name':entry()['name'],'llm_connection':'none','model':'deterministic-no-llm','requested_effect':'external_send','approvedForApply':True,'approvedForExternalSend':True,'approvalSource':'human_campaign_launch_and_schedule_request_2026-09-30'}
  await client.create_schedule(SID,Schedule(action=RecurringAction(RbwAutomationWorkflow.run,payload,id='rbw.'+ID,task_queue='campaigns',retry_policy=RetryPolicy(maximum_attempts=1)),spec=ScheduleSpec(cron_expressions=[CRON],time_zone_name='Europe/London',start_at=datetime(2026,10,1,8,tzinfo=timezone.utc),end_at=datetime(2026,10,21,16,tzinfo=timezone.utc)),state=ScheduleState(paused=True,note='Prepared for verified launch on 2026-10-01 09:00 Europe/London')))
 desc=await handle.describe()
 return {'scheduleId':SID,'paused':desc.schedule.state.paused,'nextActions':[x.isoformat() for x in desc.info.next_action_times[:4]],'timezone':desc.schedule.spec.time_zone_name,'startAt':desc.schedule.spec.start_at.isoformat(),'endAt':desc.schedule.spec.end_at.isoformat()}
if __name__=='__main__':
 ap=argparse.ArgumentParser();ap.add_argument('--activate',action='store_true');args=ap.parse_args()
 out={'temporal':asyncio.run(temporal(True))} if args.activate else {'registration':register(),'temporal':asyncio.run(temporal())}
 print(json.dumps(out,ensure_ascii=False))
