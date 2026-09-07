import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location("session_audit", Path(__file__).parents[1] / "robb-session-audit.py")
AUDIT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(AUDIT)


class SessionAuditTests(unittest.TestCase):
    def write_session(self, root, ident, created, messages=(), **extra):
        path = root / "workspaces" / "workspace" / "sessions" / ident / "session.jsonl"
        path.parent.mkdir(parents=True)
        header = {"id": ident, "createdAt": created, "workspaceRootPath": "workspace", **extra}
        path.write_text("\n".join(json.dumps(row) for row in [header, *messages]) + "\n")
        return path

    def test_creation_order_includes_empty_and_children_excludes_backup(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            old = self.write_session(root, "old", 1000)
            self.write_session(root, "child", 2000, parentSessionId="old")
            self.write_session(root, "new-empty", 3000)
            os.utime(old, (99999999, 99999999))
            backup = root / "backups/workspaces/workspace/sessions/copied/session.jsonl"
            backup.parent.mkdir(parents=True)
            backup.write_text('{"id":"copied","createdAt":9000}\n')
            selected, count = AUDIT.load_profile(root, 2)
            self.assertEqual(count, 3)
            self.assertEqual([row["header"]["id"] for row in selected], ["new-empty", "child"])
            report = AUDIT.summarize(selected, count)
            self.assertEqual(report["summary"]["emptySessions"], 2)
            self.assertEqual(report["summary"]["parentsOutsideCohort"], 1)

    def test_export_contains_no_text_input_title_or_source_identity(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            secret = "UNIQUE_SECRET_NEVER_EXPORT"
            self.write_session(root, "private-session", 1000, [
                {"type": "user", "content": secret},
                {"type": "tool", "toolName": "private-tool", "toolInput": {"token": secret},
                 "toolResult": secret, "toolStatus": "completed"},
            ], name=secret, model=secret, tokenUsage={"costUsd": 2, "totalTokens": 3})
            rows, count = AUDIT.load_profile(root, 1)
            serialized = json.dumps(AUDIT.summarize(rows, count))
            for value in [secret, "private-session", "private-tool", str(root)]:
                self.assertNotIn(value, serialized)

    def test_failed_quota_session_is_not_inferred_success_from_done(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            self.write_session(root, "quota", 1000, [
                {"type": "user", "content": "Do the work"},
                {"type": "error", "content": "Codex error: The usage limit has been reached"},
            ], sessionStatus="done")
            rows, count = AUDIT.load_profile(root, 1)
            summary = AUDIT.summarize(rows, count)["summary"]
            self.assertEqual(summary["quotaWithoutWorkMarkedDone"], 1)
            self.assertEqual(summary["storedObjectives"], {"missing": 1})

    def test_continuation_excludes_initial_and_hidden_and_uses_result_field(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            self.write_session(root, "test", 1000, [
                {"type": "user", "content": "Reprend"},
                {"type": "user", "content": "Poursuit", "hidden": True},
                {"type": "user", "content": "Go"},
                {"type": "tool", "content": "Running tool...", "toolStatus": "completed",
                 "toolResult": "Cost guard checkpoint: call not started"},
            ])
            rows, count = AUDIT.load_profile(root, 1)
            report = AUDIT.summarize(rows, count)
            self.assertEqual(report["summary"]["shortContinuations"], 1)
            self.assertEqual(report["sessions"][0]["shortContinuationLines"], [4])
            self.assertEqual(report["sessions"][0]["signals"]["cost_checkpoint"], [5])
            self.assertEqual(report["summary"]["toolStatuses"], {"completed": 1})

    def test_invalid_creation_timestamp_fails_instead_of_silent_exclusion(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            self.write_session(root, "bad", "yesterday")
            with self.assertRaises(ValueError):
                AUDIT.load_profile(root, 1)


if __name__ == "__main__":
    unittest.main()
