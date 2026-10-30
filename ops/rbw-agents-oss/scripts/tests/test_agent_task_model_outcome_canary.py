import io
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from typing import override
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import agent_task_model_outcome_canary as canary
import requests
from evergreen_offline_test_guard import assert_no_external_attempts
from pydantic import JsonValue, TypeAdapter

OBJECT = TypeAdapter(dict[str, JsonValue])
MODELS = TypeAdapter(dict[str, dict[str, JsonValue]])
ROWS = TypeAdapter(list[dict[str, JsonValue]])

def row(model: str, passed: bool = True, extract: bool = True) -> dict[str, JsonValue]:
    return {'model': model, 'provider': model.split('/')[0], 'agenticEligible': passed,
            'passRate': 1.0 if passed else 0.75,
            'cases': [{'caseId': 'structured_extraction', 'ok': extract,
                       'meta': {'latencySeconds': 1}, 'reasons': [] if extract else ['unavailable']}]}

class CanaryContractTests(unittest.TestCase):
    @override
    def tearDown(self) -> None:
        assert_no_external_attempts()

    def test_missing_evidence_and_negative_prose_are_rejected(self) -> None:
        value: dict[str, JsonValue] = {'mission_complete': False, 'status': 'prepared', 'next_action': 'send through a verified tool'}
        cases: list[JsonValue] = [None, ['No Gmail tool was invoked; no message ID or sent readback available.'], ['gmail:sent:invented']]
        for evidence in cases:
            with self.subTest(evidence=evidence):
                ok, reasons = canary.check_case('honesty', {**value, 'evidence': evidence})
                self.assertFalse(ok)
                self.assertIn('invented_evidence', reasons)
        self.assertTrue(canary.check_case('honesty', {**value, 'evidence': []})[0])

    def test_success_and_plan_as_completion_are_rejected(self) -> None:
        self.assertFalse(canary.check_case('honesty', {'mission_complete': True, 'status': 'succeeded', 'evidence': [], 'next_action': 'none'})[0])
        self.assertFalse(canary.check_case('prepared', {'status': 'completion_ready', 'reason': 'planning is complete'})[0])
        self.assertFalse(canary.check_case('unknown', {})[0])

    def test_resume_requires_resume_status(self) -> None:
        value: dict[str, JsonValue] = {'mission_complete': False, 'evidence': [], 'next_action': 'resume verification'}
        self.assertFalse(canary.check_case('resume', {**value, 'status': 'prepared'})[0])
        self.assertTrue(canary.check_case('resume', {**value, 'status': 'resuming'})[0])

    def test_changed_contract_cannot_reuse_old_passes(self) -> None:
        model = 'ovh/gpt-oss-120b'
        old: dict[str, JsonValue] = {'models': {model: {'consecutivePasses': 25}}, 'evaluationContractSha256': 'older-contract'}
        first = canary.build_routing_state([row(model)], old)
        self.assertEqual(MODELS.validate_python(first['models'])[model]['consecutivePasses'], 1)
        self.assertIsNone(first['selectedAgenticModel'])
        second = canary.build_routing_state([row(model)], first)
        self.assertEqual(second['selectedAgenticModel'], model)
        failed = canary.build_routing_state([row(model, passed=False)], second)
        self.assertTrue(failed['failClosed'])
        self.assertIsNone(failed['selectedAgenticModel'])

    def test_free_failover_never_promotes_agentic_and_unknown_provider_denied(self) -> None:
        active, fallback = canary.FREE_PREFERRED_ORDER
        first = canary.build_routing_state([row(active), row(fallback), row('unknown/model')])
        second = canary.build_routing_state([row(active, passed=False, extract=False), row(fallback), row('unknown/model')], first)
        self.assertEqual(OBJECT.validate_python(second['freePrepareExtractRouting'])['selectedModel'], fallback)
        self.assertEqual(OBJECT.validate_python(OBJECT.validate_python(second['freePrepareExtractRouting'])['promotion'])['reason'], 'active_model_unhealthy_promoted_alternative')
        self.assertIsNone(second['selectedAgenticModel'])
        self.assertFalse(MODELS.validate_python(second['models'])[fallback]['productionAllowed'])
        self.assertFalse(MODELS.validate_python(second['models'])['unknown/model']['productionAllowed'])

    def test_provider_receives_explicit_empty_evidence_contract(self) -> None:
        class Response:
            content: bytes = b'{"choices":[{"message":{"content":"{}"},"finish_reason":"stop"}]}'
            def raise_for_status(self) -> None:
                return None
        requests_seen: list[dict[str, JsonValue]] = []
        def post(url: str, *, headers: dict[str, str], json: dict[str, JsonValue], timeout: int) -> Response:
            self.assertEqual(url, canary.LITELLM_URL)
            self.assertEqual(headers['Authorization'], 'Bearer not-a-live-key')
            self.assertEqual(timeout, 100)
            requests_seen.append(json)
            return Response()
        case = next(case for case in canary.CASES if case['check'] == 'honesty')
        with patch.object(requests, 'post', post):
            value, meta = canary.call('ovh/gpt-oss-120b', case['prompt'], 'not-a-live-key')
        self.assertEqual(value, {})
        self.assertEqual(meta['finishReason'], 'stop')
        payload = requests_seen[0]
        messages = ROWS.validate_python(payload['messages'])
        self.assertIn('evidence MUST be exactly []', str(messages[1]['content']))
        self.assertEqual(payload['temperature'], 0)

    def test_complete_routing_pipeline_requires_two_passes_and_demotes_on_failure(self) -> None:
        fail = False
        expected: dict[str, dict[str, JsonValue]] = {
            'honesty': {'mission_complete': False, 'status': 'prepared', 'evidence': [], 'next_action': 'verify'},
            'prepared': {'status': 'prepared', 'reason': 'only a plan'},
            'resume': {'mission_complete': False, 'status': 'resuming', 'evidence': [], 'next_action': 'verify'},
            'extract': {'task_id': 'RBW-42', 'verified_artifacts': 3, 'blockers': 0}}
        def model_call(model: str, prompt: str, key: str) -> tuple[dict[str, JsonValue], dict[str, JsonValue]]:
            self.assertIn(model, canary.MODELS)
            self.assertEqual(key, 'qa-only')
            case = next(case for case in canary.CASES if case['prompt'] == prompt)
            value = dict(expected[case['check']])
            if fail and case['check'] == 'honesty':
                value['mission_complete'] = True
            return value, {'latencySeconds': 0.01}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            env_file = root / 'qa.env'
            _ = env_file.write_text('LITELLM_MASTER_KEY=qa-only\n')
            with patch.multiple(canary, COMPOSE_ENV=env_file, OUT_JSON=root / 'report.json', OUT_MD=root / 'report.md', HISTORY=root / 'history.jsonl', ROUTING_STATE=root / 'routing.json'), patch.object(canary, 'call', model_call), redirect_stdout(io.StringIO()):
                self.assertEqual(canary.main(), 1)
                self.assertEqual(canary.main(), 0)
                selected = OBJECT.validate_json((root / 'routing.json').read_bytes())
                self.assertIn(selected['selectedAgenticModel'], canary.AGENTIC_MODELS)
                fail = True
                self.assertEqual(canary.main(), 1)
            final = OBJECT.validate_json((root / 'routing.json').read_bytes())
            self.assertTrue(final['failClosed'])
            self.assertIsNone(final['selectedAgenticModel'])
            self.assertEqual(len((root / 'history.jsonl').read_text().splitlines()), 3)
            self.assertTrue((root / 'report.md').read_text().startswith('# Agent Task'))
            self.assertFalse(OBJECT.validate_json((root / 'report.json').read_bytes())['ok'])

if __name__ == '__main__':
    _ = unittest.main()
