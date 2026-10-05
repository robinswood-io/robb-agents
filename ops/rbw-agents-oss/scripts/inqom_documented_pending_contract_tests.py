import copy,json,unittest
from pathlib import Path
from datetime import datetime,timezone
from inqom_expert_route_autonomous_resolver import pending_input_contract
F=json.loads((Path(__file__).with_name('test_fixtures')/'inqom-documented-pending-fixture-20261005.json').read_text())
NOW=datetime(2026,10,5,10,0,tzinfo=timezone.utc)
class PendingContract(unittest.TestCase):
    def setUp(self):self.d=copy.deepcopy(F)
    def valid(self,index=0,proof=True,quality=True,quarantine=None):
        r=self.d['records'][index];q=[x['sourceAction'] for x in self.d['records'] if x['sourceQueue']==r['sourceQueue']]
        return pending_input_contract(r,self.d['reports'][Path(r['sourceReport']).name],q,self.d['native'],self.d['guidance'],quarantine or set(),proof,quality,NOW)
    def test_all_six_real_pending_routes(self):
        self.assertTrue(all(self.valid(i) for i in range(6)))
    def test_hash_changed(self):
        self.d['records'][0]['sourceActionHash']='0'*64;self.assertFalse(self.valid())
    def test_external_permission(self):
        self.d['records'][0]['mutationAllowedCurrent']=True;self.assertFalse(self.valid())
    def test_native_proof_missing(self):self.assertFalse(self.valid(proof=False))
    def test_logical_proof_missing(self):self.assertFalse(self.valid(quality=False))
    def test_stale_source(self):
        self.d['reports']['inqom-source-quality-normalizer-last.json']['generatedAt']='2026-10-05T07:00:00Z';self.assertFalse(self.valid())
    def test_unrecognized_source(self):
        self.d['records'][0]['sourceQueue']='/tmp/unknown';self.assertFalse(self.valid())
    def test_already_lettered_native(self):
        self.d['native']['lines'][0]['matchedId']=123
        self.assertFalse(self.valid(3) if self.d['native']['lines'][0]['lineId']==3961791128 else self.valid(4))
    def test_missing_invoice_route(self):
        self.d['guidance']=[];self.assertFalse(self.valid(3))
    def test_quarantined_case_keeps_old_resolution(self):
        self.assertFalse(self.valid(3,quarantine={3961791128}))
    def test_missing_source_validation(self):
        del self.d['reports']['inqom-source-quality-normalizer-last.json']['counts']['validationIssues'];self.assertFalse(self.valid())
if __name__=='__main__':unittest.main()
