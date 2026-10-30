"""Exercise the release boundary without CI credentials or application data."""
from __future__ import annotations

import contextlib
import hashlib
import io
import json
import os
import platform
import stat
import subprocess
import tempfile
import unittest
import urllib.request
import zipfile
from pathlib import Path
from unittest.mock import MagicMock, patch

from scripts import robinswood_quality_ci as CI


class ReleaseQualityTests(unittest.TestCase):
    def test_workflow_keeps_private_access_on_trusted_release_events(self) -> None:
        workflow = (Path(__file__).resolve().parents[2] / ".github/workflows/release.yml").read_text()
        quality = workflow.split("\n  quality:", 1)[1].split("\n  macos:", 1)[0]
        self.assertIn("permissions: {contents: read}", quality)
        self.assertIn("run: xvfb-run -a rtk python3 scripts/robinswood_quality_ci.py", quality)
        self.assertRegex(quality, 'ROBB_RULEBOOK_COMMIT: "[0-9a-f]{40}"')
        self.assertIn("runs-on: [self-hosted, Linux, X64, robb-release]", quality)
        self.assertIn("ROBB_QUALITY_CHECKOUT: /home/ubuntu/robb-local-reconcile-20261029", quality)
        self.assertIn("ROBB_RULEBOOK_CHECKOUT: /opt/ia-webdev/rulebook-ai", quality)
        self.assertNotIn("actions/checkout", quality)
        self.assertNotIn("sudo", quality)
        self.assertNotIn("secrets.", quality)
        self.assertNotIn("pull_request", workflow.split("\njobs:", 1)[0])

    def test_only_immutable_commits_are_accepted(self) -> None:
        self.assertEqual(CI.require_commit("a" * 40), "a" * 40)
        for value in ("main", "v0.12.11", "a" * 39, "../private"):
            with self.assertRaises(ValueError):
                _ = CI.require_commit(value)

    def test_tampered_tool_archive_is_rejected_before_execution(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            with (
                patch.object(platform, "system", return_value="Linux"),
                patch.object(platform, "machine", return_value="x86_64"),
                patch.object(urllib.request, "urlopen", return_value=io.BytesIO(b"tampered")),
                self.assertRaisesRegex(ValueError, "integrity"),
            ):
                CI.bootstrap_rtk(root)
            self.assertFalse((root / "robb-quality-rtk/rtk").exists())

    def test_static_tool_archive_digest_is_checked_before_extraction(self) -> None:
        payload = b"not the pinned quality tool archive"
        url = "https://quality-tools.invalid/tool.nupkg"
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with (
                patch.object(CI, "STATIC_TOOLS", ((url, "0" * 64, "Modules"),)),
                patch.object(urllib.request, "urlopen", return_value=io.BytesIO(payload)),
                self.assertRaisesRegex(ValueError, "integrity"),
            ):
                CI.bootstrap_static_tools(root)
            self.assertFalse((root / "robb-quality-tools/Modules").exists())

    def test_static_tool_zip_cannot_extract_outside_target(self) -> None:
        payload_stream = io.BytesIO()
        with zipfile.ZipFile(payload_stream, "w") as archive:
            archive.writestr("../escaped.txt", "must stay absent")
        payload = payload_stream.getvalue()
        url = "https://quality-tools.invalid/module.nupkg"
        digest = hashlib.sha256(payload).hexdigest()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with (
                patch.object(CI, "STATIC_TOOLS", ((url, digest, "Modules"),)),
                patch.object(urllib.request, "urlopen", return_value=io.BytesIO(payload)),
                self.assertRaisesRegex(ValueError, "escapes target"),
            ):
                CI.bootstrap_static_tools(root)
            self.assertFalse((root / "robb-quality-tools/escaped.txt").exists())

    def pipeline(
        self, *, check_code: int = 0, validation_code: int = 0, source: str = "a" * 40,
        gate_timeout: bool = False, check_name: str = "lint", self_hosted: bool = False,
        explicit_roots: bool = False, dirty: bool = False,
    ) -> tuple[int, str, list[tuple[str, ...]]]:
        calls: list[tuple[str, ...]] = []
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory).resolve()
            root = base / "checkout"
            root.mkdir()
            controller = base / "private-rulebook" if explicit_roots else root / ".quality-rulebook"
            controller.mkdir()
            (root / "bmad").mkdir()
            temporary = base / "runner-temp"
            temporary.mkdir()
            github_workspace = base / "different-github-workspace" if explicit_roots else root
            environment = {
                "GITHUB_WORKSPACE": str(github_workspace), "RUNNER_TEMP": str(temporary),
                "ROBB_EXPECTED_SOURCE_COMMIT": "a" * 40, "ROBB_RULEBOOK_COMMIT": "b" * 40,
                "RUNNER_ENVIRONMENT": "self-hosted" if self_hosted else "github-hosted",
            }
            if explicit_roots:
                environment["ROBB_QUALITY_CHECKOUT"] = str(root)
                environment["ROBB_RULEBOOK_CHECKOUT"] = str(controller)

            def execute(argv: list[str], cwd: Path, *, timeout: int = 1500) -> subprocess.CompletedProcess[str]:
                self.assertEqual(timeout, 2100 if len(argv) > 2 and argv[2] == "run" else 1500)
                calls.append(tuple(argv))
                if gate_timeout and len(argv) > 2 and argv[2] == "run":
                    raise subprocess.TimeoutExpired(argv, timeout)
                if argv == ["git", "rev-parse", "HEAD"]:
                    head = "b" * 40 if cwd == controller else source
                    return subprocess.CompletedProcess(argv, 0, head + "\n", "")
                if argv == ["git", "status", "--porcelain"]:
                    return subprocess.CompletedProcess(argv, 0, " M source.ts\n" if dirty else "", "")
                if argv == ["git", "rev-parse", "--git-path", "info/exclude"]:
                    return subprocess.CompletedProcess(argv, 0, ".git/info/exclude\n", "")
                if argv == ["bun", "run", "validate:versions"]:
                    exclude = root / ".git/info/exclude"
                    if explicit_roots:
                        self.assertFalse(exclude.exists())
                    else:
                        self.assertIn("/.quality-rulebook/", exclude.read_text())
                    self.assertEqual(os.environ["CRAFT_CONFIG_DIR"], str(temporary / "robb-quality-test-profile"))
                    return subprocess.CompletedProcess(argv, validation_code, "Public source validation\n", "")
                if argv[0] == "python3" and argv[-2:] == ["run", str(root)]:
                    report = {
                        "state": "FAIL" if check_code else "PASS",
                        "checks": [{"name": check_name, "exit_code": check_code,
                                    "summary": check_name + " diagnostic"}],
                        "rules": {"private-rule": "PRIVATE_RULE_CONTENT"},
                    }
                    _ = (root / "bmad/quality-evidence.json").write_text(json.dumps(report))
                    # RTK console output may be compressed; it is not a machine contract.
                    return subprocess.CompletedProcess(argv, check_code, "compressed console", "")
                if argv[0] == "python3" and argv[-2:] == ["verify", str(root)]:
                    return subprocess.CompletedProcess(argv, 0, "verified", "")
                raise AssertionError("Unexpected release command: " + repr(argv))

            output = io.StringIO()
            with (
                patch.dict(os.environ, environment),
                patch.object(CI, "bootstrap_rtk"),
                patch.object(CI, "bootstrap_static_tools"),
                patch.object(CI, "prepare_electron_sandbox"),
                patch.object(CI, "execute", side_effect=execute),
                contextlib.redirect_stdout(output),
            ):
                code = CI.main()
            self.assertTrue((temporary / "robb-release-validation.log").is_file())
            if explicit_roots:
                gate_run = next(call for call in calls if len(call) > 2 and call[2] == "run")
                self.assertEqual(gate_run[-1], str(root))
                self.assertNotEqual(root, github_workspace)
                self.assertFalse((root / ".git/info/exclude").exists())
            if check_name == "dependencies":
                diagnostic = temporary / "robb-public-quality/dependencies-summary.txt"
                self.assertEqual(diagnostic.read_text(), "dependencies diagnostic")
            return code, output.getvalue(), calls

    def test_dependency_failure_is_visible_without_private_rule_contents(self) -> None:
        code, output, calls = self.pipeline(check_code=1, check_name="dependencies")
        self.assertEqual(code, 1)
        self.assertIn("dependencies diagnostic", output)
        self.assertNotIn("PRIVATE_RULE_CONTENT", output)
        self.assertFalse(any(len(call) > 2 and call[2] == "verify" for call in calls))

    def test_gate_timeout_preserves_failure_and_never_verifies(self) -> None:
        code, output, calls = self.pipeline(gate_timeout=True)
        self.assertEqual(code, 124)
        self.assertIn("exceeded 35 minutes", output)
        self.assertFalse(any(len(call) > 2 and call[2] == "verify" for call in calls))

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
            _ = self.pipeline(source="c" * 40)

    def test_self_hosted_uses_explicit_sibling_checkouts_without_git_exclude(self) -> None:
        code, _, calls = self.pipeline(self_hosted=True, explicit_roots=True)
        self.assertEqual(code, 0)
        self.assertIn(("git", "status", "--porcelain"), calls)

    def test_dirty_self_hosted_checkout_is_rejected_before_source_validation(self) -> None:
        with self.assertRaisesRegex(ValueError, "concurrent or uncommitted changes"):
            _ = self.pipeline(self_hosted=True, dirty=True)


class ElectronSandboxPreparationTests(unittest.TestCase):
    def test_failed_runtime_installation_never_changes_permissions(self) -> None:
        execute: MagicMock
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            installer = root / "node_modules/electron/install.js"
            installer.parent.mkdir(parents=True)
            _ = installer.write_text("fixture")
            with (
                patch.dict(os.environ, dict[str, str](GITHUB_ACTIONS="true", RUNNER_ENVIRONMENT="github-hosted")),
                patch.object(platform, "system", return_value="Linux"),
                patch.object(CI, "execute", return_value=subprocess.CompletedProcess[str](list[str](), 1, "", "download failed")) as execute,
                self.assertRaisesRegex(RuntimeError, "runtime installation failed"),
            ):
                CI.prepare_electron_sandbox(root)
            execute.assert_called_once_with(list[str](("node", str(installer))), root)

    def test_refuses_local_execution_without_commands(self) -> None:
        execute: MagicMock
        with (
            patch.dict(os.environ, dict[str, str](GITHUB_ACTIONS="true", RUNNER_ENVIRONMENT="")),
            patch.object(CI, "execute") as execute,
            self.assertRaisesRegex(ValueError, "ephemeral GitHub Linux"),
        ):
            CI.prepare_electron_sandbox(Path.cwd())
        execute.assert_not_called()

    def test_self_hosted_accepts_prepared_helper_without_running_commands(self) -> None:
        execute: MagicMock
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            helper = root / "node_modules/electron/dist/chrome-sandbox"
            helper.parent.mkdir(parents=True)
            _ = helper.write_text("fixture")
            metadata = os.stat_result((stat.S_IFREG | 0o4755, 1, 1, 1, 0, 0, 7, 0, 0, 0))
            with (
                patch.dict(os.environ, dict[str, str](RUNNER_ENVIRONMENT="self-hosted")),
                patch.object(platform, "system", return_value="Linux"),
                patch.object(Path, "stat", autospec=True, return_value=metadata),
                patch.object(CI, "execute") as execute,
            ):
                CI.prepare_electron_sandbox(root)
            execute.assert_not_called()

    def test_self_hosted_rejects_unprepared_helper_without_commands(self) -> None:
        execute: MagicMock
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            helper = root / "node_modules/electron/dist/chrome-sandbox"
            helper.parent.mkdir(parents=True)
            _ = helper.write_text("fixture")
            metadata = os.stat_result((stat.S_IFREG | 0o755, 1, 1, 1, 1000, 1000, 7, 0, 0, 0))
            with (
                patch.dict(os.environ, dict[str, str](RUNNER_ENVIRONMENT="self-hosted")),
                patch.object(platform, "system", return_value="Linux"),
                patch.object(Path, "stat", autospec=True, return_value=metadata),
                patch.object(CI, "execute") as execute,
                self.assertRaisesRegex(ValueError, "must already be authorized and prepared"),
            ):
                CI.prepare_electron_sandbox(root)
            execute.assert_not_called()

    def test_self_hosted_rejects_helper_symlink_without_commands(self) -> None:
        execute: MagicMock
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            helper = root / "node_modules/electron/dist/chrome-sandbox"
            helper.parent.mkdir(parents=True)
            target = helper.parent / "sandbox-target"
            _ = target.write_text("fixture")
            helper.symlink_to(target)
            with (
                patch.dict(os.environ, dict[str, str](RUNNER_ENVIRONMENT="self-hosted")),
                patch.object(platform, "system", return_value="Linux"),
                patch.object(CI, "execute") as execute,
                self.assertRaisesRegex(ValueError, "must not be a symlink"),
            ):
                CI.prepare_electron_sandbox(root)
            execute.assert_not_called()

    def test_rejects_external_symlink_before_changing_permissions(self) -> None:
        execute: MagicMock
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory).resolve()
            root = base / "checkout"
            helper = root / "node_modules/electron/dist/chrome-sandbox"
            helper.parent.mkdir(parents=True)
            outside = base / "outside"
            _ = outside.write_text("fixture")
            helper.symlink_to(outside)
            with (
                patch.dict(os.environ, dict[str, str](GITHUB_ACTIONS="true", RUNNER_ENVIRONMENT="github-hosted")),
                patch.object(platform, "system", return_value="Linux"),
                patch.object(CI, "execute") as execute,
                self.assertRaisesRegex(ValueError, "inside the checkout"),
            ):
                CI.prepare_electron_sandbox(root)
            execute.assert_not_called()

    def test_stops_on_permission_command_failure(self) -> None:
        execute: MagicMock
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            helper = root / "node_modules/electron/dist/chrome-sandbox"
            helper.parent.mkdir(parents=True)
            _ = helper.write_text("fixture")
            with (
                patch.dict(os.environ, dict[str, str](GITHUB_ACTIONS="true", RUNNER_ENVIRONMENT="github-hosted")),
                patch.object(platform, "system", return_value="Linux"),
                patch.object(CI, "execute", return_value=subprocess.CompletedProcess[str](list[str](), 1, "", "refused")) as execute,
                self.assertRaisesRegex(RuntimeError, "preparation failed"),
            ):
                CI.prepare_electron_sandbox(root)
            execute.assert_called_once_with(list[str](("sudo", "chown", "root:root", "--", str(helper))), root)


if __name__ == "__main__":
    _ = unittest.main()
