import copy,json,unittest
from pathlib import Path
from inqom_residual_expert_handoff_coverage import responsible_handoff_contract,make_handoff_action
F=json.loads((Path(__file__).with_name('test_fixtures')/'inqom-responsible-handoff-fixture-20261005.json').read_text())
class ResponsibleHandoff(unittest.TestCase):
    def setUp(self):self.data=copy.deepcopy(F)
    def valid(self):return responsible_handoff_contract(self.data['routerCounts'],self.data['statusCounts'],self.data['queue'],self.data['records'])
    def test_real_ten_records_three_expert_routes_one_agent(self):self.assertTrue(self.valid())
    def test_wrong_owner(self):
        self.data['queue'][0]['owner']='agent' if self.data['queue'][0]['owner']=='expert_accountant' else 'expert_accountant';self.assertFalse(self.valid())
    def test_missing_route(self):
        self.data['queue'].pop();self.assertFalse(self.valid())
    def test_duplicate_coverage(self):
        self.data['queue'].append(self.data['queue'][0]);self.assertFalse(self.valid())
    def test_current_mutation_enabled(self):
        self.data['records'][0]['mutationAllowedCurrent']=True;self.assertFalse(self.valid())
    def test_wrong_agent_record_family(self):
        next(r for r in self.data['records'] if r['family']=='source_quality')['family']='native_lettering';self.assertFalse(self.valid())
    def test_ready_record(self):
        self.data['statusCounts']['ready_for_autonomous_preflight']=1;self.assertFalse(self.valid())
    def test_wrong_owner_counts(self):
        self.data['routerCounts']['agentRoutes']=0;self.assertFalse(self.valid())
    def test_generated_agent_handoff_preserves_no_permissions(self):
        a=next(a for a in self.data['queue'] if a['owner']=='agent_then_expert_accountant');ids=set(a['data']['registryIds']);rows=[r for r in self.data['records'] if r['registryId'] in ids];h=make_handoff_action(a,'source_quality_review',rows,[])
        self.assertEqual(h['owner'],'agent_then_expert_accountant');self.assertFalse(h['data']['mutationAllowed']);self.assertFalse(h['data']['externalSendAllowed'])
if __name__=='__main__':unittest.main()
