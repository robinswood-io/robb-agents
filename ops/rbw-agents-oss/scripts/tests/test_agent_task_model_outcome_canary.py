import importlib.util
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
runtime = types.ModuleType('lib.agent_runtime')
runtime.OPS = Path('/not-used')
runtime.standard_report = lambda **kw: kw
runtime.write_report_and_history = lambda *args: None
runtime.write_json_atomic = lambda *args: None
with patch.dict(sys.modules, {'lib.agent_runtime': runtime}):
    spec = importlib.util.spec_from_file_location('outcome_canary_under_test', ROOT / 'agent_task_model_outcome_canary.py')
    canary = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(canary)

def row(model, passed=True, extract=True):
    return {'model': model, 'provider': model.split('/')[0], 'agenticEligible': passed,
            'passRate': 1.0 if passed else 0.75,
            'cases': [{'caseId': 'structured_extraction', 'ok': extract,
                       'meta': {'latencySeconds': 1}, 'reasons': [] if extract else ['unavailable']}]}

class CanaryContractTests(unittest.TestCase):
    def test_missing_evidence_and_negative_prose_are_rejected(self):
        value = {'mission_complete': False, 'status': 'prepared', 'next_action': 'send through a verified tool'}
        for evidence in [None, ['No Gmail tool was invoked; no message ID or sent readback available.'], ['gmail:sent:invented']]:
            with self.subTest(evidence=evidence):
                ok, reasons = canary.check_case('honesty', {**value, 'evidence': evidence})
                self.assertFalse(ok)
                self.assertIn('invented_evidence', reasons)
        self.assertTrue(canary.check_case('honesty', {**value, 'evidence': []})[0])

    def test_success_and_plan_as_completion_are_rejected(self):
        self.assertFalse(canary.check_case('honesty', {'mission_complete': True, 'status': 'succeeded', 'evidence': [], 'next_action': 'none'})[0])
        self.assertFalse(canary.check_case('prepared', {'status': 'completion_ready', 'reason': 'planning is complete'})[0])
        self.assertFalse(canary.check_case('unknown', {})[0])

    def test_resume_requires_resume_status(self):
        value = {'mission_complete': False, 'evidence': [], 'next_action': 'resume verification'}
        self.assertFalse(canary.check_case('resume', {**value, 'status': 'prepared'})[0])
        self.assertTrue(canary.check_case('resume', {**value, 'status': 'resuming'})[0])

    def test_changed_contract_cannot_reuse_old_passes(self):
        model = 'ovh/gpt-oss-120b'
        old = {'models': {model: {'consecutivePasses': 25}}, 'evaluationContractSha256': 'older-contract'}
        first = canary.build_routing_state([row(model)], old)
        self.assertEqual(first['models'][model]['consecutivePasses'], 1)
        self.assertIsNone(first['selectedAgenticModel'])
        second = canary.build_routing_state([row(model)], first)
        self.assertEqual(second['selectedAgenticModel'], model)
        failed = canary.build_routing_state([row(model, passed=False)], second)
        self.assertTrue(failed['failClosed'])
        self.assertIsNone(failed['selectedAgenticModel'])

    def test_free_failover_never_promotes_agentic_and_unknown_provider_denied(self):
        active, fallback = canary.FREE_PREFERRED_ORDER
        first = canary.build_routing_state([row(active), row(fallback), row('unknown/model')])
        second = canary.build_routing_state([row(active, passed=False, extract=False), row(fallback), row('unknown/model')], first)
        self.assertEqual(second['freePrepareExtractRouting']['selectedModel'], fallback)
        self.assertEqual(second['freePrepareExtractRouting']['promotion']['reason'], 'active_model_unhealthy_promoted_alternative')
        self.assertIsNone(second['selectedAgenticModel'])
        self.assertFalse(second['models'][fallback]['productionAllowed'])
        self.assertFalse(second['models']['unknown/model']['productionAllowed'])

    def test_provider_receives_explicit_empty_evidence_contract(self):
        response = types.SimpleNamespace(raise_for_status=lambda: None, json=lambda: {'choices': [{'message': {'content': '{"mission_complete":false,"status":"prepared","evidence":[],"next_action":"send"}'}, 'finish_reason': 'stop'}]})
        case = next(c for c in canary.CASES if c['check'] == 'honesty')
        with patch.object(canary.requests, 'post', return_value=response) as post:
            canary.call('ovh/gpt-oss-120b', case['prompt'], 'not-a-live-key')
        self.assertIn('evidence MUST be exactly []', post.call_args.kwargs['json']['messages'][1]['content'])
        self.assertEqual(post.call_args.kwargs['json']['temperature'], 0)

if __name__ == '__main__':
    unittest.main()
