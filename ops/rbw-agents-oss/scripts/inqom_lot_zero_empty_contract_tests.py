import copy,json,unittest
from pathlib import Path
from datetime import datetime,timezone
from inqom_approvalonly_lot_zero_protocol import verified_empty_registry_queue
F=json.loads((Path(__file__).with_name('test_fixtures')/'inqom-lot-zero-empty-fixture-20261005.json').read_text())
NOW=datetime(2026,10,5,9,20,tzinfo=timezone.utc)
class LotZeroEmptyContract(unittest.TestCase):
    def setUp(self):self.d=copy.deepcopy(F)
    def valid(self):return verified_empty_registry_queue(self.d['registry'],self.d['live'],self.d['tests'],NOW)
    def test_valid_no_candidate(self):self.assertTrue(self.valid())
    def test_missing_native_snapshot_proof(self):
        self.d['live']={};self.assertFalse(self.valid())
    def test_unprocessed_registry(self):
        self.d['registry']['ok']=False;self.assertFalse(self.valid())
    def test_ready_native_candidate_conflict(self):
        self.d['registry']['counts']['readyNativeLetteringPreflightCandidates']=1;self.assertFalse(self.valid())
    def test_unverified_tests(self):
        self.d['tests']['checks'][2]['ok']=False;self.assertFalse(self.valid())
    def test_mutating_native_report(self):
        self.d['live']['counts']['mutationAttempted']=1;self.assertFalse(self.valid())
if __name__=='__main__':unittest.main()
