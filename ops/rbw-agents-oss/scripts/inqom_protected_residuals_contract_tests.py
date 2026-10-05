import copy,json,unittest
from pathlib import Path
from inqom_execution_readiness_registry_tests import protected_residuals_consistent
F=json.loads((Path(__file__).with_name('test_fixtures')/'inqom-protected-residuals-fixture-20261005.json').read_text())
class ProtectedResidualsContract(unittest.TestCase):
    def setUp(self): self.data=copy.deepcopy(F)
    def valid(self): return protected_residuals_consistent(self.data['records'],self.data['residuals'])
    def test_real_ten_open_including_five_expert(self): self.assertTrue(self.valid())
    def test_missing_residual(self):
        self.data['residuals'].pop();self.assertFalse(self.valid())
    def test_duplicate_residual(self):
        self.data['residuals'].append(self.data['residuals'][0]);self.assertFalse(self.valid())
    def test_unexpected_residual(self):
        self.data['residuals'][0]['registryId']='unexpected';self.assertFalse(self.valid())
    def test_expert_autoclosed(self):
        self.data['records'][0]['autonomousResolution']={};self.assertFalse(self.valid())
    def test_mutation_enabled(self):
        self.data['records'][0]['mutationAllowedCurrent']=True;self.assertFalse(self.valid())
    def test_approval_enabled(self):
        self.data['records'][0]['canEnterApprovalOnlyPreflight']=True;self.assertFalse(self.valid())
    def test_residual_wrong_status(self):
        self.data['residuals'][0]['readinessStatus']='completed_no_action_required';self.assertFalse(self.valid())
if __name__=='__main__': unittest.main()
