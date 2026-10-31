from __future__ import annotations

import base64
import json
import socket
import subprocess
import sys
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
_external_attempts: list[str] = []

def _reject_external(*_args: object, **_kwargs: object) -> None:
    _external_attempts.append("external")
    raise RuntimeError("offline_test_external_attempt")

_socket_connect = patch.object(socket.socket, "connect", _reject_external)
_ = _socket_connect.start()
_create_connection = patch.object(socket, "create_connection", _reject_external)
_ = _create_connection.start()
_subprocess = patch.object(subprocess, "Popen", _reject_external)
_ = _subprocess.start()

import robinswood_flow_core as core
import robinswood_flow_core_support as support

_profile_directory = tempfile.TemporaryDirectory(prefix="flow-profile-tests-")
_profile_path = Path(_profile_directory.name) / "profile.json"
support.PROFILE_PATH = _profile_path


def _valid_profile() -> support.JsonObject:
    return support.JSON_OBJECT_ADAPTER.validate_python({
        "sender": "qa@example.invalid",
        "accountKey": "qa-account-0",
        "sourceMessageId": "qa-message",
        "sourceThreadId": "qa-thread",
        "accounts": [{"key": f"qa-account-{index}"} for index in range(13)],
        "staleMessageIds": [],
        "privateTextValues": {},
    })


def tearDownModule() -> None:
    assert not _external_attempts, f"external attempts blocked: {_external_attempts}"
    _socket_connect.stop()
    _create_connection.stop()
    _subprocess.stop()
    _profile_directory.cleanup()


class GmailBodyTests(unittest.TestCase):
    def test_decodes_gmail_body_data_for_declared_mime_type(self) -> None:
        _ = _profile_path.write_text(json.dumps(_valid_profile()), encoding="utf-8")
        encoded = base64.urlsafe_b64encode(b"synthetic message body").decode("ascii").rstrip("=")
        payload = support.JSON_OBJECT_ADAPTER.validate_python(
            {"mimeType": "text/plain", "body": {"data": encoded}}
        )
        self.assertEqual(support.btext(payload), "synthetic message body")


class TechnicalDuplicatesProfileTests(unittest.TestCase):
    def _write(self, value: support.JsonObject) -> None:
        support.PROFILE_PATH = _profile_path
        _ = _profile_path.write_text(json.dumps(value), encoding="utf-8")

    def test_object_is_preserved(self) -> None:
        profile = _valid_profile()
        expected = support.JSON_OBJECT_ADAPTER.validate_python(
            {"companyKeys": ["qa-company"], "excludedRows": [{"id": "qa-only"}]}
        )
        profile["technicalDuplicates"] = expected
        self._write(profile)
        self.assertEqual(support.technical_duplicates(), expected)

    def test_missing_optional_field_refuses_getter(self) -> None:
        self._write(_valid_profile())
        with self.assertRaisesRegex(RuntimeError, "flow_profile_technical_duplicates_missing"):
            _ = support.technical_duplicates()

    def test_non_object_field_is_rejected(self) -> None:
        profile = _valid_profile()
        profile["technicalDuplicates"] = []
        self._write(profile)
        with self.assertRaisesRegex(TypeError, "flow_profile_technical_duplicates_invalid"):
            _ = support.technical_duplicates()
    def test_missing_profile_refuses_materialization_before_writes(self) -> None:
        support.PROFILE_PATH = Path(_profile_directory.name) / "absent-profile.json"
        with (
            patch.object(core, "save") as save,
            patch.object(core, "append_unique") as append_unique,
            self.assertRaises(RuntimeError),
        ):
            _ = core.main("materializer")
        save.assert_not_called()
        append_unique.assert_not_called()
    def test_materializer_restart_is_idempotent_with_qa_paths(self) -> None:
        profile = _valid_profile()
        profile["accounts"] = [
            {
                "key": f"qa-account-{index}",
                "name": f"QA account {index}",
                "campaign_id": f"qa-campaign-{index}",
                "domain": f"qa{index}.example.invalid",
                "email": f"qa{index}@example.invalid",
            }
            for index in range(13)
        ]
        profile["privateTextValues"] = {
            f"text_{index:03d}": f"qa-private-text-{index:03d}"
            for index in (1, 3, 5, 6, 7, 8, 9, 10, 17, 22, 23, 24, 25, 27, 28, 43, 44, 68, 81)
        }
        self._write(profile)
        qa_root = Path(_profile_directory.name) / "ops"
        paths = {
            "REG": qa_root / "registry.json",
            "APPROVAL": qa_root / "approval.json",
            "EMAILQ": qa_root / "email.json",
            "LIQ": qa_root / "linkedin.json",
            "LEDGER": qa_root / "ledger.jsonl",
            "EVENTS": qa_root / "events.jsonl",
            "REPLY": qa_root / "reply.json",
            "HUMAN": qa_root / "human.json",
        }
        with ExitStack() as stack:
            for name, path in paths.items():
                _ = stack.enter_context(patch.object(core, name, path))
            _ = stack.enter_context(patch.object(support, "OPS", qa_root))
            self.assertEqual(core.materialize(), 0)
            initial = (len(support.rows(paths["LEDGER"])), len(support.rows(paths["EVENTS"])))
            self.assertEqual(core.materialize(), 0)
            restarted = (len(support.rows(paths["LEDGER"])), len(support.rows(paths["EVENTS"])))
        self.assertEqual(initial, restarted)
        self.assertEqual(initial, (1, 1))

    def test_invalid_existing_state_is_not_replaced_by_default(self) -> None:
        path = Path(_profile_directory.name) / "invalid-state.json"
        _ = path.write_text("{invalid", encoding="utf-8")
        with self.assertRaisesRegex(RuntimeError, "state_file_invalid"):
            _ = support.load(path, {})
