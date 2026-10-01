#!/usr/bin/env python3
import ast, importlib.util, json, os, tempfile, time, unittest, io
from types import SimpleNamespace
from unittest.mock import patch
from contextlib import redirect_stdout
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any
SCRIPTS=Path(__file__).resolve().parents[1]/'scripts'

def funcs(file,names,constants=()):
 tree=ast.parse((SCRIPTS/file).read_text())
 nodes=[n for n in tree.body if isinstance(n,(ast.FunctionDef,ast.AsyncFunctionDef)) and n.name in names or
        isinstance(n,ast.Assign) and any(isinstance(x,ast.Name) and x.id in constants for x in n.targets)]
 scope={'Any':Any,'Path':Path,'str':str}
 exec(compile(ast.Module(body=nodes,type_ignores=[]),file,'exec'),scope)
 return scope

spec=importlib.util.spec_from_file_location('observation',SCRIPTS/'oss_watchdog_observation.py')
obs=importlib.util.module_from_spec(spec);spec.loader.exec_module(obs)

class RecoveryTests(unittest.TestCase):
 def test_large_drift_payload_is_artifact_only(self):
  f=funcs('schedule_drift_report.py',['compact_summary'])['compact_summary']
  d={'ok':False,'status':'degraded','summary':'drift=8','counts':{'driftCount':8},
     'blockingReasons':['schedule_drift'],'artifacts':{'reportJson':'/ops/report.json'},
     'rows':[{'huge':'x'*1000} for _ in range(208)],'actionQueue':[{'x':1}]*208}
  payload=f(d)
  self.assertLess(len(json.dumps(payload)),1000);self.assertNotIn('rows',payload)
  self.assertEqual(len(d['rows']),208);self.assertFalse(payload['ok'])
 def test_failed_classification_never_healthy(self):
  f=funcs('oss_agent_business_gate_classifier.py',['classify'],
     ['EXPECTED_BUSINESS_GATES','TECHNICAL_REASON_MARKERS','EXPECTED_BUSINESS_REASON_MARKERS'])['classify']
  for aid in ('oss-config-mutation-guard','oss-agent-production-health-audit','unknown'):
   self.assertEqual(f({'id':aid,'reportStatus':'failed'})['classification'],'technical_defect')
  self.assertEqual(f({'id':'traid-onchain-liquidation-shadow-monitor','reportStatus':'blocked',
                    '_bucket':'technicalReportFailures'})['classification'],'technical_defect')
  self.assertEqual(f({'id':'traid-onchain-liquidation-shadow-monitor','reportStatus':'blocked',
                    '_bucket':'businessGates'})['classification'],'expected_business_gate')
 def test_safety_negations_and_mutations(self):
  f=funcs('oss_runtime_warning_processor.py',['side_effects','is_safe_refresh'])['is_safe_refresh']
  policy={'explicitAllowIds':['safe'],'safeRiskClasses':['observability'],
          'denySideEffectSubstrings':['crm_mutation','delete','gmail-send']}
  safe={'sideEffects':['filesystem-read:state','filesystem-write:ops-report','no_external_send','no_crm_mutation'],
        'command':'python read_report.py','riskClass':'observability'}
  self.assertTrue(f('safe',safe,policy)[0])
  for danger in ['crm_mutation','ssh-mutate:firewall','bounded-docker-restart','runtime_restart',
                 'systemctl restart','gmail-send','no_crm_mutation_and_crm_mutation','delete_records']:
   self.assertFalse(f('safe',{**safe,'sideEffects':safe['sideEffects']+[danger]},policy)[0],danger)
  self.assertFalse(f('other',{'sideEffects':['no_external_send','unreviewed_effect']},policy)[0])
 def test_canonical_growth_is_bound_to_verified_registry(self):
  f=funcs('robinswood_flow_structural_tests.py',['canonical_contacts_valid'])['canonical_contacts_valid']
  c={'yousign-youtrust':56542846,'gitguardian':56542859,'filigran':56542860,'quarkslab':56542861}
  a=[{'key':'edflex','sellsyContactId':56543337,'contactVerified':True}]
  self.assertTrue(f(c,[]));self.assertTrue(f({**c,'edflex':56543337},a))
  self.assertFalse(f({**c,'edflex':999},a));self.assertFalse(f({**c,'edflex':56543337},[]))
  self.assertFalse(f({**c,'gitguardian':999},a));self.assertFalse(f({**c,'unknown':56542846},a))
 def make_report(self,path,**kw):
  d={'capabilityId':'oss-agent-production-health-audit','generatedAt':datetime.now(timezone.utc).isoformat(),
     'ok':False,'status':'degraded','blockingReasons':['technical_report_failures']}
  d.update(kw);path.write_text(json.dumps(d));return d
 def test_fresh_findings_remain_false_and_bound_to_hash(self):
  with tempfile.TemporaryDirectory() as t:
   p=Path(t)/'r.json';ns=time.time_ns();d=self.make_report(p);raw=p.read_bytes()
   found,sha=obs.validate_observation(d['capabilityId'],p,ns,1,'')
   self.assertFalse(found['ok']);self.assertEqual(p.read_bytes(),raw);self.assertEqual(len(sha),64)
   with self.assertRaises(ValueError):obs.validate_observation(d['capabilityId'],p,ns,1,'',sha)
 def test_stale_wrong_identity_exception_nonreport_exit_fail_closed(self):
  with tempfile.TemporaryDirectory() as t:
   p=Path(t)/'r.json';ns=time.time_ns();aid='oss-agent-production-health-audit'
   for kwargs,rc,err in [
      ({'capabilityId':'other'},1,''),({'generatedAt':(datetime.now(timezone.utc)-timedelta(hours=1)).isoformat()},1,''),
      ({'ok':True},1,''),({},2,''),({},1,'Traceback (most recent call last)'),
      ({'status':'timeout'},1,''),({'ok':'false'},1,'')]:
    self.make_report(p,**kwargs)
    with self.assertRaises(ValueError):obs.validate_observation(aid,p,ns,rc,err)
   self.make_report(p);os.utime(p,ns=(ns-2000000000,ns-2000000000))
   with self.assertRaises(ValueError):obs.validate_observation(aid,p,ns,1,'')
 def test_bad_observer_report_is_technical_failure_not_business_failure(self):
  aid='oss-agent-production-health-audit'
  with tempfile.TemporaryDirectory() as t:
   root=Path(t);ops=root/'ops';ops.mkdir()
   def child(*args,**kwargs):
    self.make_report(ops/obs.SPECS[aid][1],capabilityId='forged')
    return SimpleNamespace(returncode=1,stderr='')
   buf=io.StringIO()
   with patch.object(obs,'ROOT',root),patch.object(obs,'OPS',ops),patch.object(obs.subprocess,'run',child),patch('sys.argv',['observer','--legacy-id',aid]),redirect_stdout(buf):
    self.assertEqual(obs.main(),1)
   d=json.loads(buf.getvalue())
   self.assertEqual(d['status'],'technical_failed');self.assertNotIn('ok',d)
 def test_read_only_infra_scope_and_dev_probe_wrapper(self):
  self.assertEqual(obs.SPECS['infra-exposure-autoremediation-guard'][3],('--no-remediate',))
  source=(SCRIPTS/'oss_infrastructure_observation.py').read_text()
  self.assertIn('/opt/ia-webdev/bin/rbw-docker-guard docker -- ps',source)
  self.assertIn("if server.get('alias') == 'dev':",source)
  self.assertNotIn('def remediate(',source)
  self.assertNotIn('docker restart',source)
  self.assertNotIn('iptables -I',source)
  self.assertNotIn('systemctl restart',source)
  self.assertNotIn('OVH_SECRET_ENV',source)
if __name__=='__main__':unittest.main()
