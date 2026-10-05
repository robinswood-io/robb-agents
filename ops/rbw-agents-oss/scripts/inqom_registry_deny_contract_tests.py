import copy,json,unittest
from pathlib import Path
from inqom_execution_readiness_registry_tests import denylist_respected
F=json.loads(Path('/tmp/inqom-registry-deny-fixture-20261005.json').read_text())
class DenylistContract(unittest.TestCase):
    def setUp(self): self.data=copy.deepcopy(F)
    def valid(self): return denylist_respected(self.data['records'],self.data['report'],set(self.data['blockedIds']))
    def test_real_no_intersection(self): self.assertTrue(self.valid())
    def test_wrong_count(self):
        self.data['report']['counts']['livePreflightDenylistRecordsBlocked']=1;self.assertFalse(self.valid())
    def test_missing_guard(self):
        self.data['report']['guardrails']['livePreflightDenylistApplied']=False;self.assertFalse(self.valid())
    def test_missing_metadata(self):
        self.data['report']['livePreflightDenylist']['blockedLineIds']=[];self.assertFalse(self.valid())
    def test_ready_blocked(self):
        r=self.data['records'][0];r['lineIds']=[self.data['blockedIds'][0]];r['readinessStatus']='ready_for_autonomous_preflight';self.assertFalse(self.valid())
    def test_unprotected_intersection(self):
        self.data['records'][0]['lineIds']=[self.data['blockedIds'][0]];self.assertFalse(self.valid())
    def test_protected_positive_intersection(self):
        r=self.data['records'][0];r.update(lineIds=[self.data['blockedIds'][0]],readinessStatus='completed_no_action_required',livePreflightBlockedByDenylist=True,canEnterApprovalOnlyPreflight=False)
        self.data['report']['counts']['livePreflightDenylistRecordsBlocked']=1
        self.data['report']['livePreflightDenylist']['recordsBlocked']=1
        self.assertTrue(self.valid())
if __name__=='__main__': unittest.main()
