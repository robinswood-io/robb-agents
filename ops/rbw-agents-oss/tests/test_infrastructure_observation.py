"""Read-only infrastructure paths with local artifacts and no external access."""
import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from typing import override
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import infrastructure_probe as probe
import oss_infrastructure_observation as observation
from evergreen_offline_test_guard import assert_no_external_attempts
from pydantic import JsonValue, TypeAdapter

OBJECT = TypeAdapter(dict[str, JsonValue])
ROWS = TypeAdapter(list[dict[str, JsonValue]])

class InfrastructureTests(unittest.TestCase):
    @override
    def tearDown(self) -> None:
        assert_no_external_attempts()

    def test_listener_and_smtp_parsing(self) -> None:
        output = 'tcp LISTEN 0 50 0.0.0.0:1080 0.0.0.0:*\ntcp LISTEN 0 50 [::]:9050 [::]:*\ntcp LISTEN 0 50 127.0.0.1:1080 0.0.0.0:*\ntcp LISTEN 0 50 [::1]:1080 [::]:*\ntcp LISTEN 0 50 0.0.0.0:443 0.0.0.0:*\ninvalid'
        rows = probe.parse_listeners(output, [1080, 9050])
        self.assertEqual([row['public'] for row in rows], [True, True, False, False])
        self.assertEqual(len(probe.parse_smtp('tcp ESTAB 0 0 1.2.3.4:25')), 1)
        self.assertEqual(probe.parse_smtp('tcp ESTAB 0 0 1.2.3.4:2525'), [])

    def test_firewall_block_must_match_same_rule_and_exact_port(self) -> None:
        self.assertFalse(probe.has_block('-A OUTPUT --dport 25 -j ACCEPT\n-A OUTPUT --dport 443 -j DROP', 25))
        self.assertFalse(probe.has_block('-A OUTPUT --dport 2525 -j DROP', 25))
        self.assertTrue(probe.has_block('-A OUTPUT --dport 25 -j REJECT', 25))

    def test_failed_commands_cannot_be_reported_as_healthy(self) -> None:
        commands: list[str] = []
        def failed(command: str, timeout: int = 10) -> probe.CommandResult:
            commands.append(command)
            self.assertGreater(timeout, 0)
            return {'ok': False, 'exitCode': 1, 'stdout': '', 'stderr': 'test diagnostic unavailable'}
        with patch.object(probe, 'run', failed), patch.dict('os.environ', {'RBW_DEV_DIAGNOSTICS': '1'}):
            report = probe.collect_probe()
        self.assertEqual(len(ROWS.validate_python(report['probeErrors'])), 5)
        self.assertTrue(ROWS.validate_python(report['dockerIssues']))
        self.assertTrue(any(command.startswith('/opt/ia-webdev/bin/rbw-docker-guard docker -- ps') for command in commands))
        classified = observation.classify({'alias': 'qa'}, {'probe': report}, {'unsafePublicProxyPorts': []})
        self.assertEqual(len(ROWS.validate_python(classified['errors'])), 5)

    def test_docker_rows_and_malformed_output(self) -> None:
        def result(command: str, timeout: int = 10) -> probe.CommandResult:
            self.assertIn('docker', command)
            self.assertEqual(timeout, 15)
            return {'ok': True, 'exitCode': 0, 'stderr': '',
                    'stdout': 'healthy\timage:v1\tUp 2 hours\nbroken\timage:v2\tRestarting (1)\ninvalid'}
        with patch.object(probe, 'run', result):
            rows, issues = probe.docker_rows()
        self.assertEqual(len(rows), 2)
        self.assertEqual([issue['issue'] for issue in issues], ['restarting', 'docker_probe_invalid'])

    def test_probe_server_preserves_dev_guard_and_refuses_invalid_response(self) -> None:
        def ssh(server: dict[str, JsonValue], remote: str, timeout: int = 60) -> dict[str, JsonValue]:
            self.assertEqual(server['alias'], 'dev')
            self.assertIn('RBW_DEV_DIAGNOSTICS=1', remote)
            self.assertEqual(timeout, 90)
            return {'ok': True, 'exitCode': 0, 'stdout': 'invalid json', 'stderr': ''}
        with patch.object(observation, 'ssh_command', ssh):
            result = observation.probe_server({'alias': 'dev'}, {'unsafePublicProxyPorts': [1080]})
        self.assertIsNone(result['probe'])
        classified = observation.classify({'alias': 'dev'}, result, {})
        self.assertEqual(ROWS.validate_python(classified['errors'])[0]['code'], 'ssh_or_probe_failed')

    def test_partial_probe_cannot_pass(self) -> None:
        result = observation.classify({'alias': 'qa'}, {'probe': {'hostname': 'qa'}}, {})
        self.assertEqual(ROWS.validate_python(result['errors'])[0]['code'], 'ssh_or_probe_failed')

    def test_complete_report_pipeline_preserves_read_only_actions(self) -> None:
        servers: list[JsonValue] = [
            {'alias': 'dev', 'host': '164.132.161.150'},
            {'alias': 'interne', 'host': '146.59.230.253'},
            {'alias': 'prod', 'host': '92.222.101.25'}]
        def missing_probe(server: dict[str, JsonValue], policy: dict[str, JsonValue]) -> dict[str, JsonValue]:
            self.assertIn(server['alias'], ['dev', 'interne', 'prod'])
            self.assertIn('servers', policy)
            return {'server': server, 'ssh': {'ok': False}, 'probe': None}
        captured: list[dict[str, JsonValue]] = []
        def writer(slug: str, payload: dict[str, JsonValue], *, title: str) -> dict[str, str]:
            self.assertEqual(slug, observation.SLUG)
            self.assertEqual(title, 'Read-only infrastructure observation')
            captured.append(OBJECT.validate_json(json.dumps(payload)))
            return {'reportJson': 'qa-report.json'}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            policy = root / 'policy.json'
            _ = policy.write_text(json.dumps({'servers': servers}))
            with patch.object(observation, 'POLICY_PATH', policy), patch.object(observation, 'ACTION_QUEUE_PATH', root / 'queue.json'), patch.object(observation, 'HISTORY_PATH', root / 'history.jsonl'), patch.object(observation, 'probe_server', missing_probe), patch.object(observation, 'write_report', writer), patch('sys.argv', ['observer', '--no-remediate']), redirect_stdout(io.StringIO()):
                self.assertEqual(observation.main(), 1)
            queue = OBJECT.validate_json((root / 'queue.json').read_bytes())
            actions = ROWS.validate_python(queue['items'])
            self.assertEqual(len(actions), 3)
            for action in actions:
                self.assertFalse(action['mutationAllowed'])
                self.assertFalse(action['externalSendAllowed'])
                self.assertTrue(action['requiresExplicitInfrastructureApproval'])
            self.assertTrue((root / 'history.jsonl').is_file())
        counts = OBJECT.validate_python(captured[-1]['counts'])
        self.assertEqual(counts['remediationsAttempted'], 0)
        self.assertEqual(counts['sshProbeFailures'], 3)
        self.assertFalse(captured[-1]['ok'])

if __name__ == '__main__':
    _ = unittest.main()
