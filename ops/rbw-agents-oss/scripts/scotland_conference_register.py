#!/usr/bin/env python3
"""Deploy only the approved Scottish Gmail campaign capability and its schedule."""
import argparse, asyncio, copy, fcntl, hashlib, json, shutil, sys
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path
ROOT=Path('/srv/rbw-agents-oss')
sys.path[:0]=[str(ROOT/'scripts'),str(ROOT/'packages'),str(ROOT/'apps/orchestrator-temporal')]
from lib.config_mutation import ConfigMutation
from rbw_agent_runtime.catalog import CatalogCompiler
from temporalio.client import Client,Schedule,ScheduleActionStartWorkflow,ScheduleSpec,ScheduleState,ScheduleUpdate
from temporalio.common import WorkflowIDReusePolicy,RetryPolicy
ID='scotland-executive-conference-october-2026'
SID='sched.'+ID
CRON='0,20,40 9-16 * * 1-5'
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
def own_row(rows, key, value):
 matches=[x for x in rows if isinstance(x,dict) and x.get(key)==value]
 if len(matches)!=1:raise RuntimeError('expected_one_registered_campaign_row:'+key)
 return matches[0]

async def update_cadence():
 import scotland_executive_conference_october as campaign
 campaign_root=campaign.ROOT
 client=await Client.connect('127.0.0.1:57233')
 handle=client.get_schedule_handle(SID)
 with (campaign_root/'campaign.lock').open('a') as lock:
  fcntl.flock(lock,fcntl.LOCK_EX)
  original=campaign.read(campaign_root/'campaign-contract.json')
  campaign.verify_contract(original)
  campaign.require(original['activation']=='active','campaign_must_be_active')
  campaign.require(original['limits']['dailyTouches']==10 and original['limits']['weeklyTouches']==100 and original['limits']['maxRunTouches']==1,'unexpected_existing_campaign_caps')
  updated=copy.deepcopy(original)
  updated['limits'].update(hourlyTouches=3,minimumSendIntervalSeconds=1200)
  scope=campaign.digest(campaign.signed_scope(updated))
  if scope!=original['authorization']['scopeSha256']:
   updated['authorization']['cadenceChange']={'source':'human_campaign_delivery_pacing_request_2026-10-01','authorizedAt':STAMP(),'previousScopeSha256':original['authorization']['scopeSha256'],'hourlyTouches':3,'minimumSendIntervalSeconds':1200,'dailyTouchesUnchanged':10,'weeklyTouchesUnchanged':100,'rationale':'Gradual first-day pacing, never a Google-guaranteed safe hourly quota.'}
   updated['authorization']['scopeSha256']=scope
  campaign.verify_contract(updated)
  # Backfill actual Gmail effect timestamps before tightening spacing. No mail is sent.
  db=campaign.database(campaign_root)
  pending=db.execute("SELECT count(*) FROM touches WHERE state!='sent_verified'").fetchone()[0]
  campaign.require(not pending,'unknown_effect_prevents_cadence_change')
  campaign.require(not db.execute("SELECT 1 FROM replies WHERE kind IN ('complaint','delivery_failure')").fetchone(),'negative_delivery_signal_prevents_cadence_change')
  verified_rows=db.execute("SELECT * FROM touches WHERE state='sent_verified'").fetchall()
  gateway=campaign.Gateway()
  for row in verified_rows:
   item=next(x for x in original['items'] if x['id']==row['item'])
   ok,msg,checks=campaign.verify_effect(gateway,row['gmail_id'],item,json.loads(row['draft']),row['operation'],row['expected'],row['thread_id'])
   campaign.require(ok,'existing_gmail_effect_must_verify')
   checks['gmailSentAt']=campaign.stamp(datetime.fromtimestamp(int(msg['internalDate'])/1000,timezone.utc))
   db.execute('UPDATE touches SET checks=? WHERE item=? AND step=?',(json.dumps(checks),row['item'],row['step']))
  db.commit();db.close()
  desc=await handle.describe()
  original_spec=copy.deepcopy(desc.schedule.spec)
  campaign.require(not desc.schedule.state.paused,'native_schedule_must_be_active')
  campaign.require(desc.schedule.spec.time_zone_name=='Europe/London','unexpected_schedule_timezone')
  archive=ROOT/'archive'/datetime.now(timezone.utc).strftime('%Y-%m')/(ID+'-cadence-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ'))
  archive.mkdir(parents=True)
  contract_backup=archive/'campaign-contract.json'
  shutil.copy2(campaign_root/'campaign-contract.json',contract_backup)
  cfg=ROOT/'config';changed=[];native_changed=False
  with ConfigMutation(ID+'-cadence') as mut:
   try:
    campaign.save(campaign_root/'campaign-contract.json',updated)
    for rel,list_key,key,value in [
     ('automation-mapping.json',None,'legacy_id',ID),
     ('temporal/schedules.json','schedules','schedule_id',SID),
     ('temporal/ready-schedules.json','schedules','schedule_id',SID)]:
     obj=mut.load_json(cfg/rel);rows=obj[list_key] if list_key else obj
     row=own_row(rows,key,value)
     campaign.require(row['timezone']=='Europe/London','unexpected_config_timezone')
     before_others=campaign.digest([x for x in rows if x is not row])
     row['cron']=CRON
     campaign.require(before_others==campaign.digest([x for x in rows if x is not row]),'unrelated_campaign_rows_changed')
     mut.write_json(cfg/rel,obj);changed.append(rel)
    obj=mut.load_json(cfg/'registry/side-effects-policy.json')
    row=own_row(obj['capabilities'],'legacy_id',ID)
    old_others=campaign.digest([x for x in obj['capabilities'] if x is not row])
    row['guardrails']=[x for x in row['guardrails'] if not x.startswith('one Gmail effect per run;')]
    row['guardrails'].append('one Gmail effect per run; three touches per rolling hour; at least twenty minutes between Gmail effects; ten touches per day; one hundred per week')
    row['updatedAt']=STAMP();row['updatedBy']=ID+'-human-cadence-2026-10-01'
    campaign.require(old_others==campaign.digest([x for x in obj['capabilities'] if x is not row]),'unrelated_side_effect_policy_changed')
    mut.write_json(cfg/'registry/side-effects-policy.json',obj);changed.append('registry/side-effects-policy.json')
    for path in (cfg/'agents-v2').rglob('*.json'):mut.backup(path)
    compiler=CatalogCompiler(ROOT);built=compiler.build(write_fragments=True);valid=compiler.validate()
    campaign.require(built['ok'] and valid['ok'],'catalog_validation_failed')
    def change_schedule(update):
     schedule=update.description.schedule
     schedule.spec=replace(schedule.spec,calendars=[],intervals=[],cron_expressions=[CRON])
     return ScheduleUpdate(schedule=schedule)
    native_changed=True
    await handle.update(change_schedule)
    final=await handle.describe()
    campaign.require(not final.schedule.state.paused and final.schedule.spec.time_zone_name=='Europe/London','cadence_activation_failed')
    result={'ok':True,'checkedAt':STAMP(),'scheduleId':SID,'cron':CRON,'timezone':'Europe/London','paused':final.schedule.state.paused,'nextActions':[x.isoformat() for x in final.info.next_action_times[:5]],'limits':updated['limits'],'authorizationScopeSha256':scope,'previousScopeSha256':original['authorization']['scopeSha256'],'alreadyVerifiedGmailEffects':len(verified_rows),'newGmailEffects':0,'contractBackup':str(contract_backup),'configurationBackups':mut.backups,'changedConfigurationFiles':changed,'unrelatedRowsPreserved':True,'catalogValidation':valid,'sourceSha256':{name:hashlib.sha256((ROOT/'scripts'/name).read_bytes()).hexdigest() for name in ['scotland_executive_conference_october.py','scotland_conference_register.py']}}
    campaign.save(campaign_root/'cadence-activation.json',result)
    return result
   except Exception:
    # Restore under the same locks; never replay an external mail effect.
    if native_changed:
     def restore_schedule(update):
      schedule=update.description.schedule;schedule.spec=original_spec
      return ScheduleUpdate(schedule=schedule)
     try:await handle.update(restore_schedule)
     except Exception:
      original['activation']='paused'
    for target,backup in reversed(list(mut.backups.items())):
     if backup:mut.write_text(Path(target),Path(backup).read_text())
    campaign.save(campaign_root/'campaign-contract.json',original)
    raise

if __name__=='__main__':
 ap=argparse.ArgumentParser();group=ap.add_mutually_exclusive_group();group.add_argument('--activate',action='store_true');group.add_argument('--update-cadence',action='store_true');args=ap.parse_args()
 out=asyncio.run(update_cadence()) if args.update_cadence else {'temporal':asyncio.run(temporal(True))} if args.activate else {'registration':register(),'temporal':asyncio.run(temporal())}
 print(json.dumps(out,ensure_ascii=False))
