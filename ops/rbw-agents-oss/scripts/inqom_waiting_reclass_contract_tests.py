import ast,copy,re,unittest
from pathlib import Path
tree=ast.parse(Path(__file__).with_name('inqom_operator_guidance_materializer.py').read_text())
ns={'re':re}
for name in ['open_compact','existing_waiting_reclass_pair']:
 fn=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name==name)
 exec(compile(ast.Module(body=[fn],type_ignores=[]),'<actual_waiting_pair_contract>','exec'),ns)
CHECK=ns['existing_waiting_reclass_pair']
class WaitingReclassContract(unittest.TestCase):
 def setUp(self):
  common=dict(folderId=18627,account='4731WEMINDCBEDABSCNZWWT',accountId=674,subAccountId=53658942,date='2026-09-03',matchedId=None,matchedLetter=None)
  self.rows=[dict(common,entryId=997211415,lineId=3759529492,amount=-32,source='Banking',docRef='BQ114854008',entryLabel='PRLV WEMIND'),dict(common,entryId=1047092315,lineId=3935784374,amount=32,source='ByUser',docRef='OD-RECLASS-4731-WEMIND-ASSURANCE',entryLabel='RECLASSEMENT ASSURANCE WEMIND VERS 616')]
 def valid(self):return CHECK(self.rows)
 def test_identifies_existing_native_reclassification(self):self.assertTrue(self.valid());self.assertEqual(self.rows[0]['amount']+self.rows[1]['amount'],0)
 def test_already_lettered_excluded(self):self.rows[0]['matchedId']=264069777;self.assertFalse(self.valid())
 def test_other_folder(self):self.rows[1]['folderId']=124920;self.assertFalse(self.valid())
 def test_other_account(self):self.rows[1]['accountId']=815;self.assertFalse(self.valid())
 def test_other_auxiliary(self):self.rows[1]['subAccountId']=58317527;self.assertFalse(self.valid())
 def test_other_period(self):self.rows[1]['date']='2026-10-05';self.assertFalse(self.valid())
 def test_third_open_line_ambiguous(self):self.rows.append(copy.deepcopy(self.rows[0]));self.assertFalse(self.valid())
 def test_amount_only_insufficient(self):self.rows[1]['docRef']='OD123';self.assertFalse(self.valid())
 def test_no_existing_manual_od(self):self.rows[1]['source']='Banking';self.assertFalse(self.valid())
 def test_not_balanced(self):self.rows[1]['amount']=64;self.assertFalse(self.valid())
 def materialized(self, incomplete=False):
  import inqom_operator_guidance_materializer as guidance
  from datetime import datetime,timezone
  native=[]
  for folder in guidance.FOLDERS:
   for a,b in guidance.periods(2026,datetime.now(timezone.utc).date()):
    rows=[]
    if a.startswith('2026-09') and folder==18627:
     for row in self.rows:
      rows.append(dict(Id=row['lineId'],EntryId=row['entryId'],AccountId=row['accountId'],SubAccountId=row['subAccountId'],Amount=row['amount'],Date=row['date'],DocRef=row['docRef'],EntryLabel=row['entryLabel'],Label='WEMIND',Source=row['source'],BookAccountDto={'AccountName':row['account']},MatchedId=row['matchedId']))
    if a.startswith('2026-01') and folder!=18627:
     rows=[dict(Id=folder,EntryId=folder,Amount=0,BookAccountDto={'AccountName':'51200000'},MatchedId=1)]
    native.append(dict(folderId=folder,request=dict(folderId=folder,startDate=a,endDate=b),period=dict(startDate=a,endDate=b),lines=rows,lineCount=len(rows),pages=[dict(rawItemCount=len(rows),lineCount=len(rows))]))
  if incomplete:native.pop()
  return guidance.materialize(dict(scope={'period':'2026'},rules=[{'id':'invoice_collection'}],process={'steps':['verify native evidence']}),native)
 def test_routes_exact_existing_pair_for_preparation_only(self):
  result=self.materialized();self.assertEqual(result['issues'],[])
  pair=next(x for x in result['actions'] if x['data']['ruleId']=='existing_waiting_reclassification_lettering')
  self.assertEqual(sorted(x['lineId'] for x in pair['data']['canonicalLines']),[3759529492,3935784374])
  self.assertFalse(pair['data']['mutationAllowed']);self.assertIn('entry_creation',pair['data']['blockedEffects'])
 def test_partial_native_coverage_cannot_qualify_existing_pair(self):
  result=self.materialized(True);self.assertIn('incomplete_period_coverage',result['issues'])
  self.assertFalse(any(x['data']['ruleId']=='existing_waiting_reclassification_lettering' for x in result['actions']))
if __name__=='__main__':unittest.main()
