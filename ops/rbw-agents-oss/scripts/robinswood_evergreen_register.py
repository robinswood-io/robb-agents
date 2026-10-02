#!/usr/bin/env python3
"""Install only the six approved evergreen campaign/research schedules, with rollback."""
import asyncio, json, sys
from datetime import datetime,timezone
from pathlib import Path
ROOT=Path('/srv/rbw-agents-oss')
sys.path[:0]=[str(ROOT/'scripts'),str(ROOT/'packages'),str(ROOT/'apps/orchestrator-temporal')]
from lib.config_mutation import ConfigMutation
from rbw_agent_runtime.catalog import CatalogCompiler
from temporalio.client import Client,Schedule,ScheduleActionStartWorkflow,ScheduleSpec,ScheduleState
from temporalio.common import WorkflowIDReusePolicy,RetryPolicy
import robinswood_evergreen_france as campaign
PY=str(ROOT/'.venv/bin/python');WS=str(campaign.WS)
STAMP=lambda:datetime.now(timezone.utc).isoformat().replace('+00:00','Z')
class RecurringAction(ScheduleActionStartWorkflow):
 async def _to_proto(self,client):
  action=await super()._to_proto(client);action.start_workflow.workflow_id_reuse_policy=WorkflowIDReusePolicy.ALLOW_DUPLICATE.value;return action
def entries():
 result=[]
 for lane in campaign.LANES:
  for maintenance in [False,True]:
   id=campaign.IDS[lane]+('-maintenance' if maintenance else '')
   name={'presse':'Presse — notoriété Robinswood','pme':'Prospection PME françaises','eti':'Prospection ETI françaises'}[lane]+(' — recherche et réponses' if maintenance else ' — campagne annuelle autonome')
   argv=[PY,str(ROOT/'scripts/robinswood_evergreen_france.py'),'--lane',lane]+(['--maintain','--research-batch','4'] if maintenance else ['--apply','--research-batch','2'])
   cron='5,35 * * * *' if maintenance else '*/10 9-11,14-17 * * 1-5'
   report=str(campaign.OPS/(id+'-last.json'))
   e={'legacy_id':id,'name':name,'mode':'script','category':'campaign-email-maintenance' if maintenance else 'campaign-email-execution',
    'description':'Year-round human-authorized France-only evidence-first press/SME/ETI outreach; global sender pacing, durable Gmail effect verification and qualified-outcome learning. Legacy sender holds and HDF bounce history remain preserved.',
    'command':' '.join(argv),'execution':{'backend':'argv','argv':argv,'cwd':WS,'timeout_seconds':300},
    'timeout_seconds':300,'runtimeVersion':'v2','contractVersion':'robinswood-evergreen-france-v1','cutover_ready':True,'expectsReport':True,
    'reportJsonPath':report,'businessReportJsonPath':report,'runtimeReportJsonPath':str(campaign.OPS/'runtime-v2'/(id+'-last.json')),
    'riskClass':'bounded_external_campaign_email' if not maintenance else 'bounded_campaign_evidence_maintenance',
    'sideEffects':['filesystem-write:campaign-state-and-evidence','contact-suppression:reply-bounce-or-opposition','no-paid-ads','no-crm-write','no-linkedin-write']+([] if maintenance else ['gmail-send:human-authorized-evergreen-france-only']),
    'task_queue':'campaigns','workflow_id':'rbw.'+id,'triggerType':'SchedulerTick','updatedAt':STAMP(),'updatedBy':'human-evergreen-activation-20261002'}
   payload={'legacy_id':id,'name':name,'llm_connection':'none','model':'deterministic-no-llm','requested_effect':'apply' if maintenance else 'external_send',
    'approvedForApply':True,'approvedForExternalSend':not maintenance,'approvalSource':'human_evergreen_campaign_request_2026-10-02'}
   result.append((e,payload,cron,maintenance))
 return result
def add(rows,row,key):
 existing=[x for x in rows if isinstance(x,dict) and x.get(key)==row[key]]
 if existing:
  if len(existing)!=1:raise RuntimeError('duplicate_target_entry')
  if existing[0]!=row:raise RuntimeError('existing_target_differs:'+row[key])
 else:rows.append(row)
async def install():
 campaign.contract();client=await Client.connect('127.0.0.1:57233')
 from workflows import RbwAutomationWorkflow
 cfg=ROOT/'config';created=[];unpaused=[];specs=[];description=[]
 with ConfigMutation('robinswood-evergreen-france-activation') as mut:
  try:
   for e,payload,cron,maintenance in entries():
    id=e['legacy_id'];sid='sched.'+id
    spec=ScheduleSpec(cron_expressions=[cron],time_zone_name='Europe/Paris')
    await client.create_schedule(sid,Schedule(action=RecurringAction(RbwAutomationWorkflow.run,payload,id='rbw.'+id,task_queue='campaigns',retry_policy=RetryPolicy(maximum_attempts=1)),spec=spec,state=ScheduleState(paused=True,note='Prepared: human authorized evergreen campaigns 2026-10-02; verification pending')))
    created.append(sid)
    schedule={'schedule_id':sid,'workflow_id':'rbw.'+id,'task_queue':'campaigns','cron':cron,'timezone':'Europe/Paris','enabled':True,'payload':payload}
    specs.append((e,payload,schedule))
   manifest=mut.load_json(cfg/'command-manifest.json')
   mapping=mut.load_json(cfg/'automation-mapping.json')
   schedules=mut.load_json(cfg/'temporal/schedules.json')
   ready=mut.load_json(cfg/'temporal/ready-schedules.json')
   effects=mut.load_json(cfg/'registry/side-effects-policy.json')
   sor=mut.load_json(cfg/'system-of-record-policy.json')
   for e,payload,schedule in specs:
    id=e['legacy_id'];add(manifest['wave1'],e,'legacy_id')
    mp={'legacy_id':id,'name':e['name'],'triggerType':'SchedulerTick','cron':schedule['cron'],'timezone':'Europe/Paris','enabled':True,'workflow_id':'rbw.'+id,'task_queue':'campaigns','llm_connection':'none','model':'deterministic-no-llm','payload':payload}
    add(mapping,mp,'legacy_id');add(schedules['schedules'],schedule,'schedule_id')
    add(ready['schedules'],schedule|{'legacy_id':id,'name':e['name']},'schedule_id')
    add(ready['items'],{'capability_id':id,'enabled':True,'mode':'temporal','payload':payload,'schedule_id':schedule['schedule_id'],'task_queue':'campaigns','workflow_id':'rbw.'+id},'capability_id')
    add(effects['capabilities'],{'legacy_id':id,'accepted':True,'policyClass':'human_authorized_paced_campaign_gmail_execution','riskClass':e['riskClass'],'sideEffects':e['sideEffects'],'mutationMode':'bounded_contract_external_send' if payload['approvedForExternalSend'] else 'bounded_evidence_maintenance','scheduleAllowed':True,'requiresHumanApprovalForApply':True,'requiresHumanApprovalForExternalSend':True,'requiresExplicitReviewBeforeRiskIncrease':True,
     'guardrails':['Exact authorized sender and signed evergreen contract','France PME/ETI primary registry, professional mandate and exact email qualification; editorial public source for press','One contact per company; no historical contact or legacy press-hold replay','One initial and one original-thread followup without response; all effects including replies consume quotas','Global sender daily 40 weekly 200 rolling-hour 6 interval 600 seconds; lane canary one/day','Unknown effect stops and reconciles; no Gmail write retry','First new-cohort bounce or complaint pauses the lane; suppression is shared','Only attributable editorial requests or quantified business needs reward learning; never opens/SENT/bookings without independent proof','No paid budget, CRM or LinkedIn writes'],'updatedAt':STAMP(),'updatedBy':'human-evergreen-activation-20261002'},'legacy_id')
    sor['classification']['explicitOverrides'][id]={'classification':'none','reason':'Campaign outreach/evidence capability. Gmail exact message/thread and operation are canonical effect evidence. Existing inbound CRM pipeline remains the owner of CRM records; this capability never creates a second CRM.','reviewedAt':STAMP(),'reviewedBy':'human-evergreen-activation-20261002'}
   manifest['updatedAt']=STAMP();ready['updatedAt']=STAMP();effects['counts']['capabilities']=len(effects['capabilities'])
   for name,obj in [('command-manifest.json',manifest),('automation-mapping.json',mapping),('temporal/schedules.json',schedules),('temporal/ready-schedules.json',ready),('registry/side-effects-policy.json',effects),('system-of-record-policy.json',sor)]:mut.write_json(cfg/name,obj)
   coverage=mut.load_json(cfg/'registry/script-coverage-policy.json')
   for name in ['outbound_sender_guard.py','robinswood_evergreen_register.py','robinswood_evergreen_france_tests.py','robinswood_evergreen_audit.py']:
    add(coverage['acceptedOrphanScripts'],{'path':'scripts/'+name,'accepted':True,'coverageClass':'reviewed_campaign_helper','manifestCommandExpected':False,'scheduleAllowed':False,'requiresManifestBeforeScheduling':True,'policyClass':'manual_campaign_helper_or_offline_tests','allowedInvocation':['manual_direct'],'rationale':'Scoped evergreen transport/registration/read-only audit/offline test helper. No independently recurring effect.','updatedAt':STAMP(),'updatedBy':'human-evergreen-activation-20261002'},'path')
   coverage['counts']['acceptedOrphanScripts']=len(coverage['acceptedOrphanScripts']);mut.write_json(cfg/'registry/script-coverage-policy.json',coverage)
   for p in (cfg/'agents-v2').rglob('*.json'):mut.backup(p)
   compiler=CatalogCompiler(ROOT);built=compiler.build(write_fragments=True);valid=compiler.validate()
   if not built['ok'] or not valid['ok']:raise RuntimeError('catalog_validation_failed:'+json.dumps(valid))
   for sid in created:
    handle=client.get_schedule_handle(sid);await handle.unpause(note='Human request 2026-10-02: evergreen press and France SME/ETI; targeted tests and safety contract verified')
    unpaused.append(sid);d=await handle.describe()
    if d.schedule.state.paused or d.schedule.spec.end_at is not None or d.schedule.spec.time_zone_name!='Europe/Paris':raise RuntimeError('native_schedule_readback_failed')
    description.append({'id':sid,'paused':d.schedule.state.paused,'cron':d.schedule.spec.cron_expressions,'endAt':None,'timezone':d.schedule.spec.time_zone_name,'nextActions':[x.isoformat() for x in d.info.next_action_times[:3]]})
   result={'ok':True,'activatedAt':STAMP(),'contractScopeSha256':campaign.contract()['authorization']['scopeSha256'],'schedules':description,'catalogValidation':valid,'counts':built['counts'],'configurationBackups':mut.backups,'externalSendsDuringActivation':0}
   campaign.save(campaign.ROOT/'activation.json',result);return result
  except Exception:
   for sid in created:
    try:await client.get_schedule_handle(sid).pause(note='Evergreen activation rolled back; no automatic replay')
    except Exception:pass
   for target,backup in reversed(list(mut.backups.items())):
    if backup:mut.write_text(Path(target),Path(backup).read_text())
   raise
if __name__=='__main__':
 result=asyncio.run(install())
 print(json.dumps({k:result[k] for k in ['ok','activatedAt','contractScopeSha256','schedules','counts','catalogValidation','externalSendsDuringActivation']},ensure_ascii=False))
