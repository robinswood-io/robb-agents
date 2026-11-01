"""SLO evidence and reporting paths: no Temporal service or external actions."""
import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import override
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import oss_temporal_execution_slo_guard as execution
import temporal_performance_slo_core as performance
from evergreen_offline_test_guard import assert_no_external_attempts
from lib.slo_effective import (
    effective_slo_state,
    is_governance_self_cycle_item,
    is_recovered_watch_item,
)
from pydantic import JsonValue, TypeAdapter

OBJECT = TypeAdapter(dict[str, JsonValue])
ROWS = TypeAdapter(list[dict[str, JsonValue]])

class SloTests(unittest.TestCase):
    @override
    def tearDown(self) -> None:
        assert_no_external_attempts()

    def test_effective_actions_preserve_business_blockers(self) -> None:
        governance: dict[str, JsonValue] = {'target': 'oss-agent-control-plane', 'reasons': ['current:canaryPlanner']}
        business: dict[str, JsonValue] = {'target': 'billing', 'severity': 'blocking', 'reasons': ['missing_invoice']}
        recovered: dict[str, JsonValue] = {'target': 'qa', 'severity': 'watch', 'metrics': {'currentHealth': {'ok': True}}}
        state = effective_slo_state({'counts': {'actions': 3, 'blockingIssues': 1}}, {'items': [governance, business, recovered]})
        self.assertEqual(state['effectiveActions'], 1)
        self.assertEqual(state['effectiveBlockingIssues'], 1)
        self.assertEqual(state['effectiveTargets'], ['billing'])
        self.assertEqual(state['ignoredGovernanceSelfCycleActions'], 1)
        self.assertEqual(state['ignoredRecoveredWatchActions'], 1)
        self.assertFalse(is_governance_self_cycle_item({**governance, 'reasons': ['missing_invoice']}))
        self.assertFalse(is_recovered_watch_item({**recovered, 'severity': 'blocking'}))
        fallback = effective_slo_state({'counts': {'actions': 4, 'blockingIssues': 2}}, {})
        self.assertEqual(fallback['effectiveActions'], 4)
        self.assertEqual(fallback['effectiveBlockingIssues'], 2)

    def test_controlled_business_failure_requires_policy_and_matching_evidence(self) -> None:
        now = datetime.now(UTC)
        item: dict[str, JsonValue] = {'workflowId': 'rbw.manual-monitor-123456abcdef', 'status': 'FAILED', 'startTime': now.isoformat()}
        policy: dict[str, JsonValue] = {'acceptedNonOkReports': [{'legacy_id': 'monitor', 'statuses': ['business_failed']}]}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            report = root / 'monitor-last.json'
            valid: dict[str, JsonValue] = {'generatedAt': now.isoformat(), 'status': 'business_failed', 'counts': {'businessFailures': 1, 'technicalFailures': 0}}
            _ = report.write_text(json.dumps(valid))
            evidence = execution.controlled_business_failure(item, runtime_dir=root, runtime_status_policy=policy)
            self.assertIsNotNone(evidence)
            self.assertIsNone(execution.controlled_business_failure(item, runtime_dir=root, runtime_status_policy={}))
            invalid: list[dict[str, JsonValue]] = [
                {**valid, 'counts': {'businessFailures': 1, 'technicalFailures': 1}},
                {**valid, 'generatedAt': (now - timedelta(hours=2)).isoformat()},
                {**valid, 'status': 'technical_failed'}]
            for value in invalid:
                _ = report.write_text(json.dumps(value))
                self.assertIsNone(execution.controlled_business_failure(item, runtime_dir=root, runtime_status_policy=policy))

    def test_execution_report_marks_old_runs_and_failures(self) -> None:
        calls: list[dict[str, JsonValue]] = []
        async def collect(policy: dict[str, JsonValue]) -> dict[str, JsonValue]:
            calls.append(policy)
            self.assertEqual(policy['maxRunningAgeMinutes'], 90)
            return {'running': [{'workflowId': 'old', 'ageMinutes': 120}], 'recent': [
                {'workflowId': 'bad', 'status': 'TIMED_OUT'},
                {'workflowId': 'good', 'status': 'COMPLETED'},
                {'workflowId': 'rbw.oss-temporal-execution-slo-guard-qa', 'status': 'FAILED'}]}
        def writer(slug: str, payload: dict[str, JsonValue], *, title: str) -> dict[str, str]:
            self.assertEqual(slug, execution.SLUG)
            self.assertTrue(title)
            self.assertFalse(payload['ok'])
            return {'reportJson': 'qa-report.json'}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            policy = root / 'policy.json'
            _ = policy.write_text(json.dumps({'maxRunningAgeMinutes': 90, 'recentBadTerminalMode': 'error_above_rate', 'maxRecentBadTerminalRate': 0.1}))
            with patch.object(execution, 'POLICY', policy), patch.object(execution, 'RUNTIME_STATUS_POLICY', root / 'runtime.json'), patch.object(execution, 'collect', collect), patch.object(execution, 'write_report', writer), redirect_stdout(io.StringIO()):
                report = execution.main()
                policy.unlink()
                missing = execution.main()
        self.assertEqual(len(calls), 1)
        self.assertEqual(ROWS.validate_python(missing['errors'])[0]['code'], 'temporal_slo_policy_missing_or_invalid')
        counts = OBJECT.validate_python(report['counts'])
        self.assertEqual(counts['oldRunningWorkflows'], 1)
        self.assertEqual(counts['selfCycleWorkflowsExcluded'], 1)
        self.assertEqual(counts['recentBadTerminalRate'], 0.5)
        self.assertEqual(counts['errors'], 2)

    def run_performance(self, root: Path) -> dict[str, JsonValue]:
        with patch.object(performance, 'OPS', root), patch.object(performance, 'RUN_LOG', root / 'runs.jsonl'), patch.object(performance, 'OUT_JSON', root / 'report.json'), patch.object(performance, 'OUT_MD', root / 'report.md'), patch.object(performance, 'ACTION_QUEUE', root / 'queue.json'), patch.object(performance, 'ARCHITECTURE_V2_BASELINE', root / 'baseline.json'), patch.dict('os.environ', {'TEMPORAL_PERFORMANCE_SLO_HORIZON_HOURS': '2', 'TEMPORAL_PERFORMANCE_SLO_CUTOVER_AT': ''}), redirect_stdout(io.StringIO()):
            performance.main()
        return OBJECT.validate_json((root / 'report.json').read_bytes())

    def test_performance_missing_log_is_not_success(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            report = self.run_performance(Path(directory))
        self.assertFalse(report['ok'])
        self.assertEqual(report['blockingReasons'], ['workflow_run_log_missing'])

    def test_performance_timeout_is_technical_even_with_business_label(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            rows: list[dict[str, JsonValue]] = []
            for _ in range(3):
                rows.append({'legacyId': 'mixed', 'completedAt': datetime.now(UTC).isoformat(), 'result': {'businessFailure': True, 'timeout': True, 'ok': False, 'durationSeconds': 5}})
                rows.append({'legacyId': 'business', 'completedAt': datetime.now(UTC).isoformat(), 'result': {'businessFailure': True, 'ok': False, 'exitCode': 1, 'durationSeconds': 1}})
            _ = (root / 'runs.jsonl').write_text('\n'.join(json.dumps(row) for row in rows))
            report = self.run_performance(root)
            self.assertTrue((root / 'report.md').read_text().startswith('# Temporal Performance SLO'))
            queue = OBJECT.validate_json((root / 'queue.json').read_bytes())
        counts = OBJECT.validate_python(report['counts'])
        self.assertEqual(counts['technicalFailures'], 3)
        self.assertEqual(counts['businessFailuresExcluded'], 3)
        self.assertEqual(counts['actions'], 1)
        self.assertEqual(ROWS.validate_python(queue['items'])[0]['target'], 'mixed')
        self.assertEqual(performance.percentile([5, 1, 3], 95), 5)

if __name__ == '__main__':
    _ = unittest.main()
