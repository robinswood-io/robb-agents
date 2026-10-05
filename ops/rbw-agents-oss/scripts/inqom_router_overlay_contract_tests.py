import copy,json,unittest
from pathlib import Path
from inqom_execution_blocker_burndown_router_tests import resolved_route_overlay_consistent
F=json.loads((Path(__file__).with_name('test_fixtures')/'inqom-router-overlay-fixture-20261005.json').read_text())
class RouterOverlayContract(unittest.TestCase):
    def setUp(self): self.data=copy.deepcopy(F)
    def valid(self): return resolved_route_overlay_consistent(self.data['router'],self.data['resolver'],self.data['records'])
    def test_real_fifty_records_ten_protected(self): self.assertTrue(self.valid())
    def test_route_count_mismatch(self):
        self.data['router']['routeCounts']['expert_review']=1;self.assertFalse(self.valid())
    def test_unrecognized_route(self):
        self.data['router']['routeCounts']['unknown']=1;self.assertFalse(self.valid())
    def test_expert_prematurely_closed(self):
        r=next(r for r in self.data['records'] if r['readinessStatus']=='requires_expert_decision');r['readinessStatus']='completed_no_action_required';self.assertFalse(self.valid())
    def test_mutation_enabled(self):
        self.data['records'][0]['mutationAllowedCurrent']=True;self.assertFalse(self.valid())
    def test_duplicate_decision(self):
        self.data['resolver']['decisions'][0]=self.data['resolver']['decisions'][1];self.assertFalse(self.valid())
    def test_technical_residual(self):
        self.data['resolver']['counts']['unrecognizedTechnicalResiduals']=1;self.assertFalse(self.valid())
    def test_missing_human(self):
        self.data['resolver']['humanResiduals'].pop();self.assertFalse(self.valid())
if __name__=='__main__': unittest.main()
