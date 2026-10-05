#!/usr/bin/env python3
import json,copy,sys,unittest
from pathlib import Path
from inqom_native_reconciliation_no_link_candidate_review_tests import closed_review_consistent
class NoLinkContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):cls.fixture=json.loads((Path(__file__).with_name('test_fixtures') / 'inqom-no-link-fixture.json').read_text())
    def valid(self,data):return closed_review_consistent(data['rows'],data['queue'],data['counts'],data['classCounts'])
    def check(self,edit):
        data=copy.deepcopy(self.fixture);edit(data);self.assertFalse(self.valid(data))
    def test_real_seventy_closed_ten_expert_valid(self):
        self.assertTrue(self.valid(self.fixture))
        self.assertEqual(self.fixture['counts']['expertReviewItems'],10)
    def test_missing_route_blocks(self):self.check(lambda d:d['queue'].pop())
    def test_count_drift_blocks(self):self.check(lambda d:d['counts'].update(closedNoAction=77))
    def test_duplicate_route_blocks(self):self.check(lambda d:d['queue'].append(copy.deepcopy(d['queue'][0])))
    def test_unsafe_approval_blocks(self):self.check(lambda d:d['queue'][0]['data'].update(approvalRequestAllowed=True))
    def test_canonical_line_drift_blocks(self):self.check(lambda d:d['queue'][0]['data'].update(lineIds=[123]))
    def test_closed_replay_blocks(self):self.check(lambda d:d['rows'][0].update(mutationAllowed=True))
if __name__=='__main__':unittest.main(argv=[sys.argv[0]],verbosity=1)
