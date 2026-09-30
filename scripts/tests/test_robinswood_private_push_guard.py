#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "robinswood-private-push-guard.py"
SPEC = importlib.util.spec_from_file_location("private_push_guard", SCRIPT)
assert SPEC and SPEC.loader
GUARD = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = GUARD
SPEC.loader.exec_module(GUARD)
PUBLIC_URL = "https://github.com/robinswood-io/robb-agents.git"
PRIVATE_URL = "https://github.com/robinswood-io/robb-agents-private.git"
ZERO = "0" * 40


class PrivatePushGuardTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.temp = tempfile.TemporaryDirectory(prefix="robb-push-guard-")
        cls.repo = Path(cls.temp.name)
        cls.git("init", "-q")
        cls.git("config", "user.name", "Boundary test")
        cls.git("config", "user.email", "boundary@example.invalid")
        cls.git("commit", "--allow-empty", "-qm", "public base")
        cls.base = cls.git("rev-parse", "HEAD")
        cls.git("checkout", "-qb", "private-work")
        cls.git("commit", "--allow-empty", "-qm", "private root")
        cls.private_root = cls.git("rev-parse", "HEAD")
        cls.git("commit", "--allow-empty", "-qm", "private descendant")
        cls.private_tip = cls.git("rev-parse", "HEAD")
        cls.git("tag", "-am", "private annotated tag", "private-tag")
        cls.private_tag = cls.git("rev-parse", "refs/tags/private-tag")
        cls.git("checkout", "-qb", "public-fix", cls.base)
        cls.git("commit", "--allow-empty", "-qm", "trivial public fix")
        cls.public_tip = cls.git("rev-parse", "HEAD")
        cls.git("tag", "-am", "public annotated tag", "public-tag")
        cls.public_tag = cls.git("rev-parse", "refs/tags/public-tag")
        cls.boundary = {
            "version": 1,
            "privateRepository": "github.com/robinswood-io/robb-agents-private",
            "privateRefPatterns": [
                "refs/heads/robinswood/private-*",
                "refs/heads/codex/private-*",
                "refs/heads/codex/quiet-multi-agent-ui-*",
                "refs/heads/codex/fix-message-blockers-*",
            ],
            "privateCommitRoots": [cls.private_root],
        }

    @classmethod
    def tearDownClass(cls) -> None:
        cls.temp.cleanup()

    @classmethod
    def git(cls, *args: str) -> str:
        return subprocess.check_output(["git", *args], cwd=cls.repo, text=True).strip()

    def record(self, sha: str, local: str = "refs/heads/fix", remote: str = "refs/heads/fix") -> str:
        return f"{local} {sha} {remote} {ZERO}\n"

    def validate(self, records: str, location: str = PUBLIC_URL, boundary: dict | None = None) -> None:
        GUARD.validate_push(location, records, cwd=self.repo, boundary=boundary or self.boundary)

    def test_trivial_public_branch_allowed_without_network(self) -> None:
        with patch.object(GUARD, "verify_private_repository") as verify:
            self.validate(self.record(self.public_tip))
            verify.assert_not_called()

    def test_public_clone_does_not_need_private_commit_objects(self) -> None:
        boundary = {**self.boundary, "privateCommitRoots": ["9" * 40]}
        self.validate(self.record(self.public_tip), boundary=boundary)

    def test_named_private_branches_rejected_even_before_private_commit(self) -> None:
        for name in ("robinswood/private-staging", "codex/private-routing-stabilization", "codex/quiet-multi-agent-ui-20260907", "codex/fix-message-blockers-20260908"):
            with self.subTest(name=name), self.assertRaises(GUARD.GuardError):
                self.validate(self.record(self.base, local=f"refs/heads/{name}"))

    def test_private_destination_ref_rejected(self) -> None:
        with self.assertRaises(GUARD.GuardError):
            self.validate(self.record(self.base, remote="refs/heads/robinswood/private-staging"))

    def test_renamed_private_descendant_rejected(self) -> None:
        with self.assertRaises(GUARD.GuardError):
            self.validate(self.record(self.private_tip))

    def test_explicit_sha_push_rejected(self) -> None:
        with self.assertRaises(GUARD.GuardError):
            self.validate(self.record(self.private_tip, local=self.private_tip))

    def test_private_root_itself_rejected(self) -> None:
        with self.assertRaises(GUARD.GuardError):
            self.validate(self.record(self.private_root))

    def test_private_annotated_tag_rejected(self) -> None:
        with self.assertRaises(GUARD.GuardError):
            self.validate(self.record(self.private_tag, local="refs/tags/v1", remote="refs/tags/v1"))

    def test_public_annotated_tag_allowed(self) -> None:
        self.validate(self.record(self.public_tag, local="refs/tags/v1", remote="refs/tags/v1"))

    def test_mixed_batch_rejects_entire_push(self) -> None:
        with self.assertRaises(GUARD.GuardError):
            self.validate(self.record(self.public_tip) + self.record(self.private_tip))

    def test_delete_or_empty_push_sends_no_private_content(self) -> None:
        self.validate("")
        self.validate(self.record(ZERO, local="(delete)", remote="refs/heads/robinswood/private-staging"))

    def test_unknown_destination_cannot_receive_private_content(self) -> None:
        for destination in ("/tmp/local-repo", "https://github.com/another/private.git", "private", "git@alias:robinswood-io/robb-agents-private.git"):
            with self.subTest(destination=destination), self.assertRaises(GUARD.GuardError):
                self.validate(self.record(self.private_tip), location=destination)

    def test_canonical_private_urls_require_live_verification(self) -> None:
        for url in (PRIVATE_URL, "git@github.com:robinswood-io/robb-agents-private.git", "ssh://git@github.com/robinswood-io/robb-agents-private.git"):
            with self.subTest(url=url), patch.object(GUARD, "verify_private_repository") as verify:
                self.validate(self.record(self.private_tip), location=url)
                verify.assert_called_once_with(self.boundary["privateRepository"], cwd=self.repo)

    def test_destination_lookalikes_and_credentials_rejected(self) -> None:
        for url in (
            "https://github.com.evil.invalid/robinswood-io/robb-agents-private.git",
            "https://github.com@evil.invalid/robinswood-io/robb-agents-private.git",
            PRIVATE_URL + "/../../robb-agents.git",
            PRIVATE_URL + "?redirect=public",
            "https://github.com:444/robinswood-io/robb-agents-private.git",
            "https://token@github.com/robinswood-io/robb-agents-private.git",
        ):
            with self.subTest(url=url), self.assertRaises(GUARD.GuardError):
                self.validate(self.record(self.private_tip), location=url)

    def test_unverifiable_private_destination_rejected(self) -> None:
        with patch.object(GUARD, "verify_private_repository", side_effect=GUARD.GuardError("unavailable")):
            with self.assertRaises(GUARD.GuardError):
                self.validate(self.record(self.private_tip), location=PRIVATE_URL)

    def test_github_identity_and_visibility_must_both_match(self) -> None:
        valid = {"private": True, "visibility": "private", "full_name": "robinswood-io/robb-agents-private"}
        with patch.object(GUARD, "command", return_value=json.dumps(valid)):
            GUARD.verify_private_repository(self.boundary["privateRepository"], cwd=self.repo)
        for invalid in ({**valid, "private": False}, {**valid, "visibility": "public"}, {**valid, "full_name": "other/repo"}, "bad"):
            with self.subTest(invalid=invalid), patch.object(GUARD, "command", return_value=json.dumps(invalid)):
                with self.assertRaises(GUARD.GuardError):
                    GUARD.verify_private_repository(self.boundary["privateRepository"], cwd=self.repo)

    def test_malformed_input_rejected(self) -> None:
        for record in ("broken", "\n", self.record("not-an-object"), "ref " + self.base + " ref bad\n"):
            with self.subTest(record=record), self.assertRaises(GUARD.GuardError):
                self.validate(record)

    def test_shallow_history_rejected(self) -> None:
        with patch.object(GUARD, "command", return_value="true"):
            with self.assertRaises(GUARD.GuardError):
                self.validate(self.record(self.public_tip))

    def test_missing_commit_rejected(self) -> None:
        with self.assertRaises(GUARD.GuardError):
            self.validate(self.record("8" * 40))

    def test_non_commit_object_rejected(self) -> None:
        tree = self.git("rev-parse", f"{self.base}^{{tree}}")
        with self.assertRaises(GUARD.GuardError):
            self.validate(self.record(tree))

    def test_replace_ref_cannot_hide_private_parent(self) -> None:
        self.git("replace", self.private_tip, self.public_tip)
        try:
            with self.assertRaises(GUARD.GuardError):
                self.validate(self.record(self.private_tip))
        finally:
            self.git("replace", "-d", self.private_tip)

    def test_grafts_rejected(self) -> None:
        grafts = self.repo / ".git/info/grafts"
        grafts.write_text(self.private_tip + "\n")
        try:
            with self.assertRaises(GUARD.GuardError):
                self.validate(self.record(self.private_tip))
        finally:
            grafts.unlink()

    def test_missing_or_invalid_manifest_rejected(self) -> None:
        path = self.repo / "boundary.json"
        with self.assertRaises(GUARD.GuardError):
            GUARD.load_boundary(path)
        for content in ("bad", "[]", json.dumps({**self.boundary, "privateCommitRoots": []})):
            path.write_text(content)
            with self.assertRaises(GUARD.GuardError):
                GUARD.load_boundary(path)

    def test_checked_in_manifest_is_valid(self) -> None:
        boundary = GUARD.load_boundary(GUARD.MANIFEST)
        self.assertEqual(boundary["privateRepository"], "github.com/robinswood-io/robb-agents-private")
        self.assertIn("refs/heads/codex/private-*", boundary["privateRefPatterns"])
        self.assertIn("refs/heads/codex/fix-message-blockers-*", boundary["privateRefPatterns"])


if __name__ == "__main__":
    unittest.main()
