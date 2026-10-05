import copy, json, unittest
from datetime import datetime, timezone
from pathlib import Path
from inqom_native_lettering_live_state_reconciler_tests import queue_pairs_classified
FIXTURE = json.loads(Path('/tmp/inqom-live-reconciler-fixture-20261005.json').read_text())
NOW = datetime(2026,10,5,9,5,tzinfo=timezone.utc)
class EmptyQueueContract(unittest.TestCase):
    def setUp(self): self.data=copy.deepcopy(FIXTURE)
    def valid(self, exists=True):
        d=self.data
        return queue_pairs_classified(d['report'], d['batcher'], d['queue'], d['snapshot'], exists, NOW)
    def test_real_verified_empty(self): self.assertTrue(self.valid())
    def test_missing_queue(self): self.assertFalse(self.valid(False))
    def test_missing_count(self):
        del self.data['report']['counts']['queuePairs']; self.assertFalse(self.valid())
    def test_nonempty_queue(self):
        self.data['queue']=[{'pairId':'unsafe'}]; self.assertFalse(self.valid())
    def test_producer_disagreement(self):
        self.data['batcher']['counts']['executableQueue']=1; self.assertFalse(self.valid())
    def test_incomplete_native(self):
        self.data['snapshot']['coverage'].pop(); self.assertFalse(self.valid())
    def test_false_canonical(self):
        self.data['report']['counts']['canonicalCoverageComplete']=0; self.assertFalse(self.valid())
    def test_stale_producer(self):
        self.data['batcher']['generatedAt']='2026-10-05T07:00:00Z'; self.assertFalse(self.valid())
    def test_native_mismatch(self):
        self.data['batcher']['operatorNativeSnapshotGeneratedAt']='2026-10-05T08:00:00Z'; self.assertFalse(self.valid())
    def test_missing_producer(self):
        self.data['batcher']={}; self.assertFalse(self.valid())
    def test_records_disagreement(self):
        self.data['report']['records']=[{'pairId':'1'}]; self.assertFalse(self.valid())
    def test_nonempty_records_still_counted(self):
        self.data['report']['records']=[{'pairId':'1'}]
        self.data['report']['counts']['queuePairs']=1; self.assertTrue(self.valid())
if __name__=='__main__': unittest.main()
