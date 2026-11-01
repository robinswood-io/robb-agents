"""Read-only audit, resume and failure reports over isolated QA ledgers."""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.error import URLError

import evergreen_offline_test_guard as offline_guard
import robinswood_evergreen_audit as audit
from pydantic import JsonValue
from scotland_conference_transport import SENDER

type JsonObject = dict[str, JsonValue]


class ReadGatewayFixture:
    def __init__(self, *, fail: bool = False) -> None:
        self.calls: list[str] = []
        self.fail: bool = fail

    def get(self, mid: str) -> JsonObject:
        self.calls.append(mid)
        if self.fail:
            raise URLError('offline read failure')
        return {
            'id': mid, 'threadId': 'thread-' + mid, 'internalDate': '1790842800000', 'labelIds': ['SENT'],
            'payload': {'mimeType': 'text/plain', 'body': {'data': 'UUE='}, 'headers': [
                {'name': 'To', 'value': 'qa@company.example'},
                {'name': 'From', 'value': SENDER},
                {'name': 'Subject', 'value': 'QA'},
            ]},
        }


def tearDownModule() -> None:
    offline_guard.assert_no_external_attempts()


class LegacyAuditTests(unittest.TestCase):
    def write_ledgers(self, root: Path) -> None:
        for index, name in enumerate(audit.LEDGERS):
            _ = (root / name).write_text(json.dumps({
                'event': 'sent', 'gmailMessageId': str(index), 'email': 'qa@company.example',
                'subject': 'QA', 'threadId': 'thread-' + str(index), 'campaignId': 'qa',
                'sentAt': '2026-10-01T08:20:00+00:00',
            }) + '\n')

    def test_resume_preserves_checked_results_and_has_no_write_gateway(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.write_ledgers(root)
            output = root / 'audit.json'
            gateway = ReadGatewayFixture()
            with patch.object(audit, 'ROOT', root), patch.object(audit, 'OUT', output):
                first = audit.run(1, gateway)
                self.assertFalse(first['completed'])
                self.assertEqual(first['verified'], 1)
                final = audit.run(1, gateway)
                self.assertTrue(final['completed'])
                self.assertEqual(final['verified'], 2)
                self.assertEqual(final['newExternalSends'], 0)
                _ = audit.run(1, gateway)
            self.assertEqual(gateway.calls, ['0', '1'])
            report = audit.OBJECT_ADAPTER.validate_json(output.read_bytes())
            checked = report['checked']
            self.assertIsInstance(checked, dict)
            if not isinstance(checked, dict):
                raise TypeError('checked records expected')
            entry = checked['0']
            if not isinstance(entry, dict):
                raise TypeError('checked result expected')
            self.assertEqual(entry['bodyVerification'], 'historical_body_not_in_ledger_no_exact_body_claim')
            self.assertNotIn('qa@company.example', output.read_text())

    def test_read_failure_is_durable_unverified_and_forbids_replay(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.write_ledgers(root)
            output = root / 'audit.json'
            gateway = ReadGatewayFixture(fail=True)
            with patch.object(audit, 'ROOT', root), patch.object(audit, 'OUT', output):
                report = audit.run(15, gateway)
                self.assertEqual(report['unverified'], 2)
                self.assertTrue(report['completed'])
                self.assertEqual(report['newExternalSends'], 0)
                _ = audit.run(15, gateway)
            self.assertEqual(gateway.calls, ['0', '1'])
            self.assertIn('"replayForbidden": true', output.read_text())

    def test_invalid_checkpoint_fails_before_reading_messages(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / 'audit.json'
            _ = output.write_text('{"checked": []}')
            gateway = ReadGatewayFixture()
            with patch.object(audit, 'ROOT', root), patch.object(audit, 'OUT', output), self.assertRaises(TypeError):
                _ = audit.run(15, gateway)
            self.assertEqual(gateway.calls, [])
