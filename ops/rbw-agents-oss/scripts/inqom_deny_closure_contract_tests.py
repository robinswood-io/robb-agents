import copy,json,unittest
from datetime import datetime,timezone
from pathlib import Path
from inqom_native_lettering_denylist_closure import verified_empty_current_queue
FIXTURE=json.loads(Path('/tmp/inqom-deny-closure-fixture-20261005.json').read_text())
NOW=datetime(2026,10,5,9,20,tzinfo=timezone.utc)
class ClosureContract(unittest.TestCase):
    def setUp(self): self.data=copy.deepcopy(FIXTURE)
    def valid(self): return verified_empty_current_queue(self.data['live'], self.data['tests'], NOW)
    def test_real_empty_proof(self): self.assertTrue(self.valid())
    def test_nonempty_current(self):
        self.data['live']['counts']['queuePairs']=1; self.assertFalse(self.valid())
    def test_native_mutation(self):
        self.data['live']['counts']['mutationAttempted']=1; self.assertFalse(self.valid())
    def test_stale(self):
        self.data['live']['generatedAt']='2026-10-05T07:00:00Z'; self.assertFalse(self.valid())
    def test_test_precedes_report(self):
        self.data['tests']['generatedAt']='2026-10-05T09:00:00Z'; self.assertFalse(self.valid())
    def test_missing_checked_coverage(self):
        self.data['tests']['checks']=[c for c in self.data['tests']['checks'] if c['checkId']!='queue_pairs_classified']; self.assertFalse(self.valid())
    def test_failed_proof(self):
        self.data['tests']['checks'][0]['ok']=False; self.assertFalse(self.valid())
    def test_missing_canonical(self):
        del self.data['live']['counts']['canonicalCoverageComplete']; self.assertFalse(self.valid())
if __name__=='__main__': unittest.main()
