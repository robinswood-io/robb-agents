"""Exercise the release boundary without CI credentials or application data."""
from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "robb_quality_ci", Path(__file__).resolve().parents[1] / "robinswood_quality_ci.py"
)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("Release quality runner is missing")
CI = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CI)


class ReleaseQualityTests(unittest.TestCase):
    def test_workflow_keeps_private_access_on_trusted_release_events(self) -> None:
        workflow = (Path(__file__).resolve().parents[2] / ".github/workflows/release.yml").read_text()
        quality = workflow.split("\n  quality:", 1)[1].split("\n  macos:", 1)[0]
        self.assertIn("permissions: {contents: read}", quality)
        self.assertIn("run: xvfb-run -a python3 scripts/robinswood_quality_ci.py", quality)
        self.assertRegex(quality, 'ROBB_RULEBOOK_COMMIT: "[0-9a-f]{40}"')
        self.assertIn('repository: Aoleon/rulebook-ai, ref: "${{ env.ROBB_RULEBOOK_COMMIT }}"', quality)
        self.assertIn('ssh-key: "${{ secrets.ROBB_RULEBOOK_READONLY_SSH_KEY }}"', quality)
        self.assertEqual(quality.count("persist-credentials: false"), 2)
        self.assertNotIn("pull_request", workflow.split("\njobs:", 1)[0])

    def test_only_immutable_commits_are_accepted(self) -> None:
        self.assertEqual(CI.require_commit("a" * 40), "a" * 40)
        for value in ("main", "v0.12.11", "a" * 39, "../private"):
            with self.assertRaises(ValueError):
                CI.require_commit(value)

    def test_tampered_tool_archive_is_rejected_before_execution(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            with (
                patch.object(CI.platform, "system", return_value="Linux"),
                patch.object(CI.platform, "machine", return_value="x86_64"),
                patch.object(CI.urllib.request, "urlopen", return_value=io.BytesIO(b"tampered")),
                self.assertRaisesRegex(ValueError, "integrity"),
            ):
                CI.bootstrap_rtk(root)
            self.assertFalse((root / "robb-quality-rtk/rtk").exists())

    def pipeline(
        self, *, check_code: int = 0, validation_code: int = 0, source: str = "a" * 40,
    ) -> tuple[int, str, list[tuple[str, ...]]]:
        calls: list[tuple[str, ...]] = []
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            controller = root / ".quality-rulebook"
            controller.mkdir()
            (root / "bmad").mkdir()
            temporary = root / "runner-temp"
            temporary.mkdir()
            environment = {
                "GITHUB_WORKSPACE": str(root), "RUNNER_TEMP": str(temporary),
                "ROBB_EXPECTED_SOURCE_COMMIT": "a" * 40, "ROBB_RULEBOOK_COMMIT": "b" * 40,
            }

            def execute(argv: list[str], cwd: Path) -> subprocess.CompletedProcess[str]:
                calls.append(tuple(argv))
                if argv == ["git", "rev-parse", "HEAD"]:
                    head = "b" * 40 if cwd == controller else source
                    return subprocess.CompletedProcess(argv, 0, head + "\n", "")
                if argv == ["git", "rev-parse", "--git-path", "info/exclude"]:
                    return subprocess.CompletedProcess(argv, 0, ".git/info/exclude\n", "")
                if argv == ["bun", "run", "validate:versions"]:
                    self.assertIn("/.quality-rulebook/", (root / ".git/info/exclude").read_text())
                    self.assertEqual(os.environ["CRAFT_CONFIG_DIR"], str(temporary / "robb-quality-test-profile"))
                    return subprocess.CompletedProcess(argv, validation_code, "Public source validation\n", "")
                if argv[0] == "python3" and argv[-2:] == ["run", str(root)]:
                    report = {
                        "state": "FAIL" if check_code else "PASS",
                        "checks": [{"name": "lint", "exit_code": check_code}],
                        "rules": {"private-rule": "PRIVATE_RULE_CONTENT"},
                    }
                    (root / "bmad/quality-evidence.json").write_text(json.dumps(report))
                    # RTK console output may be compressed; it is not a machine contract.
                    return subprocess.CompletedProcess(argv, check_code, "compressed console", "")
                if argv[0] == "python3" and argv[-2:] == ["verify", str(root)]:
                    return subprocess.CompletedProcess(argv, 0, "verified", "")
                raise AssertionError("Unexpected release command: " + repr(argv))

            output = io.StringIO()
            with (
                patch.dict(os.environ, environment),
                patch.object(CI, "bootstrap_rtk"),
                patch.object(CI, "prepare_electron_sandbox"),
                patch.object(CI, "execute", side_effect=execute),
                contextlib.redirect_stdout(output),
            ):
                code = CI.main()
            self.assertTrue((temporary / "robb-release-validation.log").is_file())
            return code, output.getvalue(), calls

    def test_full_boundary_uses_report_file_and_verifies_exact_commit(self) -> None:
        code, output, calls = self.pipeline()
        self.assertEqual(code, 0)
        self.assertIn('"state": "PASS"', output)
        self.assertNotIn("PRIVATE_RULE_CONTENT", output)
        self.assertEqual(sum("verify" in call for call in calls), 1)
        self.assertEqual(calls[-1], ("git", "rev-parse", "HEAD"))

    def test_failed_canonical_check_preserves_exit_code_and_never_verifies(self) -> None:
        code, output, calls = self.pipeline(check_code=7)
        self.assertEqual(code, 7)
        self.assertIn('"name": "lint"', output)
        self.assertNotIn("PRIVATE_RULE_CONTENT", output)
        self.assertFalse(any("verify" in call for call in calls))

    def test_source_validation_failure_blocks_the_canonical_stage(self) -> None:
        code, _, calls = self.pipeline(validation_code=13)
        self.assertEqual(code, 13)
        self.assertFalse(any(call[0] == "python3" for call in calls))

    def test_wrong_source_commit_is_rejected_before_validation(self) -> None:
        with self.assertRaisesRegex(ValueError, "differs from preflight"):
            self.pipeline(source="c" * 40)


class ElectronSandboxPreparationTests(unittest.TestCase):
    def test_refuses_local_or_self_hosted_execution(self) -> None:
        for host in ("", "self-hosted"):
            with (
                patch.dict(os.environ, {"GITHUB_ACTIONS": "true", "RUNNER_ENVIRONMENT": host}),
                patch.object(CI, "execute") as execute,
                self.assertRaisesRegex(ValueError, "ephemeral GitHub Linux"),
            ):
                CI.prepare_electron_sandbox(Path.cwd())
            execute.assert_not_called()

    def test_rejects_external_symlink_before_changing_permissions(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory).resolve()
            root = base / "checkout"
            helper = root / "node_modules/electron/dist/chrome-sandbox"
            helper.parent.mkdir(parents=True)
            outside = base / "outside"
            outside.write_text("fixture")
            helper.symlink_to(outside)
            with (
                patch.dict(os.environ, {"GITHUB_ACTIONS": "true", "RUNNER_ENVIRONMENT": "github-hosted"}),
                patch.object(CI.platform, "system", return_value="Linux"),
                patch.object(CI, "execute") as execute,
                self.assertRaisesRegex(ValueError, "inside the checkout"),
            ):
                CI.prepare_electron_sandbox(root)
            execute.assert_not_called()

    def test_stops_on_permission_command_failure(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            helper = root / "node_modules/electron/dist/chrome-sandbox"
            helper.parent.mkdir(parents=True)
            helper.write_text("fixture")
            with (
                patch.dict(os.environ, {"GITHUB_ACTIONS": "true", "RUNNER_ENVIRONMENT": "github-hosted"}),
                patch.object(CI.platform, "system", return_value="Linux"),
                patch.object(CI, "execute", return_value=subprocess.CompletedProcess([], 1, "", "refused")) as execute,
                self.assertRaisesRegex(RuntimeError, "preparation failed"),
            ):
                CI.prepare_electron_sandbox(root)
            execute.assert_called_once_with(["sudo", "chown", "root:root", "--", str(helper)], root)


if __name__ == "__main__":
    unittest.main()
