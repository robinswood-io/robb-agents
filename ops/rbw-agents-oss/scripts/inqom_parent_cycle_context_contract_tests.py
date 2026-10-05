import ast,copy,json,unittest
from pathlib import Path
from datetime import datetime
F=json.loads((Path(__file__).with_name('test_fixtures')/'inqom-parent-cycle-fixture-20261005.json').read_text())
source=Path(__file__).with_name('inqom_agent_work_expectation_controller.py').read_text()
tree=ast.parse(source);fn=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='_parent_cycle_context_ok')
ns={'datetime':datetime};exec(compile(ast.Module(body=[fn],type_ignores=[]),'<actual_controller_function>','exec'),ns);CHECK=ns['_parent_cycle_context_ok']
class ParentCycleContext(unittest.TestCase):
    def setUp(self):self.data=copy.deepcopy(F['data']);self.context=copy.deepcopy(F['context'])
    def valid(self):return CHECK(self.data,self.context)
    def test_current_running_cycle_is_preparation_only(self):self.assertTrue(self.valid());self.assertFalse(self.data['ok']);self.assertEqual(self.data['businessCompletionStatus'],'blocked_incomplete_work')
    def test_outside_parent(self):self.context['parentScript']='/other.py';self.assertFalse(self.valid())
    def test_previous_cycle(self):self.context['parentStartedAt']+=10;self.assertFalse(self.valid())
    def test_newer_cycle(self):self.context['parentStartedAt']-=10;self.assertFalse(self.valid())
    def test_terminal_is_not_in_progress(self):self.data['status']='processed';self.assertFalse(self.valid())
    def test_active_approval(self):self.context['nativeApprovalsAbsent']=False;self.assertFalse(self.valid())
    def test_child_guards_not_current(self):self.context['childGuardsCurrentAndSafe']=False;self.assertFalse(self.valid())
    def test_parent_expired(self):self.context['now']=self.context['parentStartedAt']+901;self.assertFalse(self.valid())
    def test_unrecognized_blocker(self):self.data['blockingReasons']=['unexpected'];self.assertFalse(self.valid())
if __name__=='__main__':unittest.main()
