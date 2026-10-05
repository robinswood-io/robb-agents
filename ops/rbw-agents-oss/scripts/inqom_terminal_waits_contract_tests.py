import copy,json,datetime as dt,unittest
from pathlib import Path
from inqom_terminal_execution_state_guardrail import current_residual_context,documented_wait_state,documented_pending_waiting_lots
F=json.loads((Path(__file__).with_name('test_fixtures')/'inqom-terminal-waits-fixture-20261005.json').read_text())
class TerminalWaits(unittest.TestCase):
    def setUp(self):
        self.data=copy.deepcopy(F)
        for p in self.data['payloads'].values():p['generatedAt']=dt.datetime.now(dt.timezone.utc).isoformat()
    def valid(self):return current_residual_context(self.data['payloads'],self.data['queue'])
    def wait(self):return documented_wait_state(self.data['report'],self.data['payloads'],self.data['queue'])
    def test_real_responsible_wait_and_single_nonquarantined_input(self):
        self.assertTrue(self.valid());self.assertTrue(self.wait());self.assertEqual(documented_pending_waiting_lots(self.data['payloads'],self.data['queue']),1)
    def test_wrong_route_owner(self):
        self.data['queue'][0]['owner']='agent';self.assertFalse(self.valid())
    def test_source_mutation(self):
        self.data['payloads']['businessAutonomy']['metrics']['mutationAttempts']=1;self.assertFalse(self.valid())
    def test_stale_source(self):
        self.data['payloads']['executionRegistry']['generatedAt']=(dt.datetime.now(dt.timezone.utc)-dt.timedelta(hours=2)).isoformat();self.assertFalse(self.valid())
    def test_unsafe_registry(self):
        self.data['payloads']['executionRegistry']['records'][0]['mutationAllowedCurrent']=True;self.assertFalse(self.valid())
    def test_unknown_terminal_failure(self):
        self.data['report']['failedChecks'].append({'checkId':'unknown'});self.assertFalse(self.wait())
    def test_premature_business_completion(self):
        self.data['payloads']['businessAutonomy']['businessAutonomyStatus']='complete_verified';self.assertFalse(self.valid())
    def test_waiting_lot_hash_drift(self):
        r=next(r for r in self.data['payloads']['executionRegistry']['records'] if r['family']=='waiting_account' and r['readinessStatus']=='requires_expert_decision');r['sourceActionHash']='wrong';self.assertEqual(documented_pending_waiting_lots(self.data['payloads'],self.data['queue']),0)
if __name__=='__main__':unittest.main()
