import ast,copy,json,unittest
from pathlib import Path
F=json.loads((Path(__file__).with_name('test_fixtures')/'inqom-controller-business-wait-fixture-20261005.json').read_text())
tree=ast.parse(Path(__file__).with_name('inqom_agent_work_expectation_controller_tests.py').read_text())
fn=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='documented_business_wait_valid')
ns={};exec(compile(ast.Module(body=[fn],type_ignores=[]),'<actual_controller_test_contract>','exec'),ns);CHECK=ns['documented_business_wait_valid']
class BusinessWaitControllerContract(unittest.TestCase):
    def setUp(self):self.terminal=copy.deepcopy(F['terminal']);self.row=copy.deepcopy(F['row']);self.proven=True
    def valid(self):return CHECK(self.terminal,self.row,self.proven)
    def test_documented_wait_is_control_health_with_incomplete_books(self):self.assertTrue(self.valid());self.assertFalse(self.terminal['ok']);self.assertFalse(self.row['businessCompleted'])
    def test_unproven_current_scope(self):self.proven=False;self.assertFalse(self.valid())
    def test_unknown_blocker(self):self.terminal['blockingReasons']=['unexpected'];self.assertFalse(self.valid())
    def test_falsely_complete_terminal(self):self.terminal['ok']=True;self.assertFalse(self.valid())
    def test_closed_count(self):self.terminal['counts']['terminalClosed']=1;self.assertFalse(self.valid())
    def test_safety_not_closed(self):self.terminal['stateSemantics']['safetyStatus']='open';self.assertFalse(self.valid())
    def test_native_mutation(self):self.terminal['counts']['nativeMutationAttempted']=1;self.assertFalse(self.valid())
    def test_false_business_completion(self):self.row['businessCompleted']=True;self.assertFalse(self.valid())
    def test_source_report_status_preserved(self):self.row['sourceReportOk']=True;self.assertFalse(self.valid())
    def test_unqualified_row(self):self.row['stateQualified']='other';self.assertFalse(self.valid())
if __name__=='__main__':unittest.main()
