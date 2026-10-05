import copy,json,unittest,datetime as dt
from pathlib import Path
from inqom_business_autonomy_control_plane import current_human_residual_records
F=json.loads((Path(__file__).with_name('test_fixtures')/'inqom-current-human-scope-fixture-20261005.json').read_text())
class CurrentHumanScope(unittest.TestCase):
    def setUp(self):
        self.data=copy.deepcopy(F)
        for k in ['registry','resolver']:self.data[k]['generatedAt']=dt.datetime.now(dt.timezone.utc).isoformat()
    def result(self):return current_human_residual_records(self.data['resolver'],self.data['registry'])
    def test_real_ten_three_doctrine_two_manual_five_expert(self):
        d,m,e,issues=self.result();self.assertEqual((len(d),len(m),len(e)),(3,2,5));self.assertFalse(issues);self.assertTrue(all(x['family'] and len(x['sourceFingerprint'])==64 for x in d+m+e))
    def test_stale(self):
        self.data['resolver']['generatedAt']=(dt.datetime.now(dt.timezone.utc)-dt.timedelta(hours=2)).isoformat();self.assertTrue(self.result()[3])
    def test_missing_residual(self):
        self.data['resolver']['humanResiduals'].pop();self.assertTrue(self.result()[3])
    def test_duplicate_residual(self):
        self.data['resolver']['humanResiduals'][0]=self.data['resolver']['humanResiduals'][1];self.assertTrue(self.result()[3])
    def test_mutation_enabled(self):
        self.data['registry']['records'][0]['mutationAllowedCurrent']=True;self.assertTrue(self.result()[3])
    def test_unknown_technical_not_delegated(self):
        self.data['resolver']['counts']['unrecognizedTechnicalResiduals']=1;self.assertTrue(self.result()[3])
    def test_resolver_not_verified(self):
        self.data['resolver']['ok']=False;self.assertTrue(self.result()[3])
    def test_inconsistent_declared_input_count(self):
        self.data['resolver']['counts']['inputRecords']=9;self.assertTrue(self.result()[3])
    def test_scope_status_changed(self):
        self.data['registry']['records'][0]['readinessStatus']='completed_no_action_required';self.assertTrue(self.result()[3])
    def test_empty_scope_only_verified_completed(self):
        r=self.data['registry']['records'][0];r['readinessStatus']='completed_no_action_required';self.data['registry']['records']=[r]
        self.data['resolver']['humanResiduals']=[];self.data['resolver']['counts'].update(inputRecords=1,humanResiduals=0);self.assertFalse(self.result()[3])
    def test_human_preparation_keeps_permissions_blocked(self):
        d,m,e,issues=self.result();self.assertTrue(all(x['mutationAllowed'] is False and x['technicalExecutionDelegatedToHuman'] is False for x in d+m+e));self.assertEqual(sum(x['owner']=='agent_then_expert_accountant' for x in e),3)
if __name__=='__main__':unittest.main()
