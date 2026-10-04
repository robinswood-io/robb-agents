#!/usr/bin/env python3
from __future__ import annotations
import copy, importlib, json, os, subprocess, tempfile, unittest
from datetime import datetime,timedelta,timezone
from pathlib import Path
from unittest.mock import patch

TEMP=tempfile.TemporaryDirectory()
os.environ['RBW_OSS_WORKSPACE']=TEMP.name
os.environ['RBW_OSS_ROOT']=str(Path(TEMP.name)/'runtime')
import inqom_source_quality_logical_review_tests as quality
import inqom_accounting_autonomy_pipeline as pipeline
import inqom_operator_guidance_materializer as guidance
import inqom_lettering_autonomy_batcher as batcher
import inqom_accounting_action_dispatcher as dispatcher
from action_queue_contract import normalize_action_list

def stamp(delta=0):
    return (datetime.now(timezone.utc)+timedelta(seconds=delta)).isoformat().replace('+00:00','Z')

def review_report():
    item={'sourceClass':'TaxVatSettlement','classification':'expert_review_unknown_source_quality_class',
          'sampleCount':1,'sampleFingerprints':['synthetic'],'closedNoAction':False,'expertReviewRequired':True,
          'mutationAllowed':False,'nativeReclassificationAllowed':False,'externalSendAllowed':False}
    action={'owner':'agent_then_expert_accountant','actionType':'review_source_quality_logical_classification_residual',
            'target':'inqom:source-quality-logical-review:TaxVatSettlement','priority':'medium','actionableNow':True,
            'blockingReason':'source_quality_logical_review_residual_requires_expert','doneCondition':'Expert evidence decision',
            'data':{k:item[k] for k in ('sourceClass','classification','sampleFingerprints','mutationAllowed','externalSendAllowed','nativeReclassificationAllowed')}}
    actions=normalize_action_list([action],origin_automation='inqom-source-quality-logical-review')
    return {'ok':True,'items':[item],'actionQueue':actions,'counts':{'sourceQualityActions':1,'reviewedClasses':1,
            'closedNoAction':0,'expertReviewItems':1,'queue':1,'mutationAttempted':0,
            'nativeReclassificationAttempted':0,'activeApprovalWritten':0}}

class ReviewQueueTests(unittest.TestCase):
    def test_valid_expert_wait_does_not_stop_independent_work(self):
        self.assertEqual(quality.residual_queue_issues(review_report()),[])
    def test_empty_consistent_queue(self):
        r=review_report();r['items']=[];r['actionQueue']=[]
        r['counts'].update(closedNoAction=0,expertReviewItems=0,queue=0)
        self.assertEqual(quality.residual_queue_issues(r),[])
    def test_missing_route_fails(self):
        r=review_report();r['actionQueue']=[]
        self.assertIn('expert_route_coverage_mismatch',quality.residual_queue_issues(r))
    def test_orphan_route_fails(self):
        r=review_report();r['items'][0].update(closedNoAction=True,expertReviewRequired=False)
        self.assertIn('orphan_expert_route',quality.residual_queue_issues(r))
    def test_duplicate_route_fails(self):
        r=review_report();r['actionQueue'].append(copy.deepcopy(r['actionQueue'][0]))
        self.assertIn('duplicate_expert_route',quality.residual_queue_issues(r))
    def test_mutation_permission_fails(self):
        r=review_report();r['actionQueue'][0]['data']['mutationAllowed']=True
        self.assertIn('unsafe_expert_route_effect',quality.residual_queue_issues(r))
    def test_fingerprint_drift_fails(self):
        r=review_report();r['actionQueue'][0]['data']['sampleFingerprints']=['wrong']
        self.assertIn('expert_evidence_mismatch',quality.residual_queue_issues(r))
    def test_counter_drift_fails(self):
        r=review_report();r['counts']['expertReviewItems']=0
        self.assertIn('review_counts_mismatch',quality.residual_queue_issues(r))
    def test_waiting_account_expert_route_accepted_by_actual_cli(self):
        r=review_report();item=r['items'][0];a=r['actionQueue'][0]
        item['sourceClass']='WaitingAccountReview';item['classification']='expert_review_waiting_account_source_quality_required'
        a['data']['sourceClass']=item['sourceClass'];a['data']['classification']=item['classification']
        a['target']='inqom:source-quality-logical-review:WaitingAccountReview'
        self.run_cli(r)
    def run_cli(self,r):
        with tempfile.TemporaryDirectory() as td:
            base=Path(td);report=base/'review.json';report.write_text(json.dumps(r))
            with patch.multiple(quality,REPORT=report,OUT_JSON=base/'tests.json',OUT_MD=base/'tests.md',ACTIVE_APPROVAL=base/'absent'):
                quality.main()
                self.assertTrue(json.loads((base/'tests.json').read_text())['ok'])
    def test_actual_cli_routes_valid_expert_queue(self):
        self.run_cli(review_report())

class CycleTests(unittest.TestCase):
    def terminal(self,delta=0):
        return {'generatedAt':stamp(delta),'stateSemantics':{'businessCompletionStatus':'complete_verified','safetyStatus':'fail_closed'}}
    def steps(self):
        return [{'stepId':name,'ok':True} for name in ('inqom-terminal-execution-state-guardrail','inqom-terminal-execution-state-guardrail-tests')]
    def test_current_completed_terminal(self):
        self.assertEqual(pipeline.completion_for_cycle(self.terminal(),self.steps(),stamp(-10))[0],'complete_verified')
    def test_old_terminal_cannot_close(self):
        self.assertEqual(pipeline.completion_for_cycle(self.terminal(-20),self.steps(),stamp(-10))[0],'blocked_incomplete_work')
    def test_fatal_step_cannot_close(self):
        self.assertEqual(pipeline.completion_for_cycle(self.terminal(),self.steps()+[{'fatal':True}],stamp(-10))[0],'blocked_incomplete_work')
    def test_missing_terminal_step_cannot_close(self):
        self.assertEqual(pipeline.completion_for_cycle(self.terminal(),[],stamp(-10))[0],'blocked_incomplete_work')
    def test_future_timestamp_cannot_close(self):
        self.assertFalse(pipeline.artifact_from_cycle(self.terminal(100),stamp(-10)))
    def test_old_artifact_counts_are_not_current_results(self):
        with tempfile.TemporaryDirectory() as td:
            path=Path(td)/'old.json';path.write_text(json.dumps({'generatedAt':stamp(-100),'ok':True,'counts':{'terminalClosed':1}}))
            result=pipeline.compact_for_cycle(path,stamp(-10))
            self.assertFalse(result['fromCurrentCycle']);self.assertEqual(result['counts'],{})
            self.assertEqual(result['cachedCounts'],{'terminalClosed':1});self.assertIsNone(result['ok'])
    def test_new_cycle_replaces_old_completion_before_any_step(self):
        start=pipeline.initial_cycle_payload(stamp(),'scheduled')
        self.assertFalse(start['ok']);self.assertEqual(start['businessCompletionStatus'],'blocked_incomplete_work')
        self.assertEqual(start['status'],'running');self.assertEqual(start['steps'],[])
    def test_qualification_is_bounded_and_contains_no_execution(self):
        specs=pipeline.build_specs('qualification',False)
        self.assertEqual([s['id'] for s in specs],['inqom-operator-guidance-materializer','inqom-source-quality-logical-review-tests','inqom-lettering-autonomy-batcher','inqom-accounting-action-dispatcher'])
        self.assertTrue(all(not s.get('extra') for s in specs))
    def test_guidance_is_first_scheduled_step(self):
        self.assertEqual(pipeline.build_specs('scheduled',False)[0]['id'],'inqom-operator-guidance-materializer')

def line(i,amount=10,matched=None,**kw):
    return {'folderId':18627,'entryId':i,'lineId':i,'account':'401TEST','accountId':1,'subAccountId':None,
            'amount':amount,'date':'2026-01-01','docRef':'F202600001','label':'Synthetic supplier',
            'matchedId':matched,'matchedLetter':None,**kw}

def snapshot(rows,delta=0):
    return {'ok':True,'generatedAt':stamp(delta),'lines':rows}

class NativeGuidanceTests(unittest.TestCase):
    def test_matched_rows_are_excluded(self):
        a,b=line(1,10,1),line(2,-10)
        self.assertEqual(guidance.open_candidates(snapshot([a,b]),18627),{'client':[],'supplier':[]})
    def test_matched_letter_alone_is_excluded(self):
        a,b=line(1,10,matchedLetter='A'),line(2,-10)
        self.assertEqual(guidance.open_candidates(snapshot([a,b]),18627)['supplier'],[])
    def test_complete_candidates_are_not_limited_to_200(self):
        rows=[]
        for i in range(301):
            rows.extend([line(i*2+1,10,docRef=f'F{202600001+i}'),line(i*2+2,-10,docRef=f'F{202600001+i}')])
        self.assertEqual(len(guidance.open_candidates(snapshot(rows),18627)['supplier']),301)
    def test_amount_alone_is_not_reference(self):
        a,b=line(1,10,docRef='BANK',label='Payment'),line(2,-10,docRef='OTHER',label='Supplier')
        self.assertEqual(guidance.open_candidates(snapshot([a,b]),18627)['supplier'],[])
    def test_generic_bank_label_ignored(self):
        self.assertEqual(guidance.reference(line(1,docRef='FACT-20190612-00001',label='Bank')), '')
    def test_ambiguous_reference_not_automatic_pair(self):
        rows=[line(1,10),line(2,-10),line(3,-10)]
        self.assertEqual(guidance.open_candidates(snapshot(rows),18627)['supplier'],[])
    def test_stale_snapshot_blocks_batch(self):
        rows=[line(1,10),line(2,-10)];c=guidance.open_candidates(snapshot(rows),18627)['supplier']
        accepted,rejected=guidance.filter_candidates(c,snapshot(rows,-4000))
        self.assertEqual(accepted,[]);self.assertEqual(rejected[0]['reason'],'native_snapshot_missing_or_stale')
    def test_native_drift_blocks_candidate(self):
        rows=[line(1,10),line(2,-10)];c=guidance.open_candidates(snapshot(rows),18627)['supplier'];c[0]['positive']['amount']=12
        accepted,rejected=guidance.filter_candidates(c,snapshot([line(1,10),line(2,-10)]))
        self.assertEqual(accepted,[]);self.assertEqual(rejected[0]['reason'],'native_candidate_drift')
    def test_closed_preexisting_workbench_pair_excluded(self):
        rows=[line(1,10),line(2,-10)];c=guidance.open_candidates(snapshot(rows),18627)['supplier']
        accepted,rejected=guidance.filter_candidates(c,snapshot([line(1,10,10),line(2,-10,10)]))
        self.assertEqual(accepted,[]);self.assertEqual(rejected[0]['reason'],'already_lettered_native')
    def test_edf_and_antonini_do_not_generate_chase(self):
        for label,rule in [('EDF','edf_annual_upload'),('Antonini','antonini_final_invoice')]:
            self.assertEqual(guidance.classify(line(1,label=label)),(rule,False))
    def test_urssaf_scope_excludes_610_and_other_folders(self):
        self.assertEqual(guidance.classify(line(1,606.30,folderId=124920,account='43100000'))[0],'ursaff_settlement_difference_030')
        self.assertNotEqual(guidance.classify(line(1,610,folderId=124920,account='43100000'))[0],'ursaff_settlement_difference_030')
        self.assertNotEqual(guidance.classify(line(1,606.30,account='43100000'))[0],'ursaff_settlement_difference_030')
    def test_pns_wait_and_jlm_balance_wait(self):
        self.assertEqual(guidance.classify(line(2593322531)),('pns_credit_note',False))
        self.assertEqual(guidance.classify(line(1,docRef='FC-02147')),('jlm_5000_balance',False))
    def test_metadata_mismatch_fails_coverage(self):
        r={'lines':[],'lineCount':0,'pages':[{'rawItemCount':0,'lineCount':0,'metadata':{'LinesCount':1}}]}
        self.assertIn('metadata_lines_mismatch',guidance.validate_period(r))
    def test_page_cap_fails_coverage(self):
        r={'lines':[],'lineCount':0,'pages':[{'rawItemCount':9999,'lineCount':0}]}
        self.assertIn('page_cap_reached',guidance.validate_period(r))
    def test_missing_months_do_not_claim_complete_coverage(self):
        data=guidance.materialize({'scope':{'period':str(datetime.now(timezone.utc).year)},'rules':[]},[])
        self.assertIn('incomplete_period_coverage',data['issues'])
    def test_node_reader_syntax_and_readonly_environment(self):
        def fake_run(args,**kw):
            self.assertEqual(kw['env']['INQOM_ENABLE_MUTATIONS'],'false')
            self.assertEqual(kw['env']['INQOM_ENABLE_NATIVE_LETTERING'],'false')
            checked=subprocess.run(['node','--check',args[1]],capture_output=True,text=True)
            self.assertEqual(checked.returncode,0,checked.stderr)
            config=json.loads(Path(args[2]).read_text())
            Path(config['output']).write_text('[]')
            return subprocess.CompletedProcess(args,0,'','')
        with patch.object(guidance.oss_process,'run',side_effect=fake_run):
            self.assertEqual(guidance.fetch_native({'scope':{'period':str(datetime.now(timezone.utc).year)}}),[])

class DispatcherTests(unittest.TestCase):
    def test_guidance_and_expert_queues_are_consumed(self):
        self.assertIn(dispatcher.OPS/'inqom-operator-guidance-action-queue.json',dispatcher.QUEUE_FILES)
        self.assertIn(dispatcher.OPS/'inqom-source-quality-logical-review-queue.json',dispatcher.QUEUE_FILES)
    def test_documented_wait_not_dispatched(self):
        with tempfile.TemporaryDirectory() as td:
            p=Path(td)
            q=normalize_action_list([{'owner':'finance-ops','actionType':'wait_documented_accounting_evidence','target':'edf','priority':'medium',
                'actionableNow':False,'blockingReason':'annual_upload','doneCondition':'Annual invoice received'}],origin_automation='test')
            with patch.multiple(dispatcher,WORKDIR=p/'papers',OUT_JSON=p/'report.json',OUT_MD=p/'report.md',LEDGER=p/'ledger.jsonl',FOLLOWUP_QUEUE=p/'followup.json'),patch.object(dispatcher,'load_actions',return_value=q):
                dispatcher.main()
                report=json.loads((p/'report.json').read_text())
                self.assertEqual(report['counts']['executedPrepareOnly'],0)
                self.assertEqual(report['skipped'][0]['reason'],'documented_wait_not_actionable')
                self.assertFalse((p/'ledger.jsonl').exists())

if __name__=='__main__':
    unittest.main()
