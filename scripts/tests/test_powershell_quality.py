"""The real PowerShell parser and analyzer inspect files without executing them."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

def check(mode: str, file: Path) -> subprocess.CompletedProcess[str]:
    executable = shutil.which("pwsh")
    if executable is None:
        raise RuntimeError("PowerShell quality runtime is required")
    env = {**os.environ, "ROBB_POWERSHELL_CHECK_FILES": json.dumps([str(file)])}
    return subprocess.run([executable, "-NoLogo", "-NoProfile", "-NonInteractive",
        "-File", str(ROOT / "scripts/check-powershell.ps1"), "-Mode", mode],
        cwd=ROOT, env=env, capture_output=True, text=True, timeout=30, check=False)

class PowerShellQualityTests(unittest.TestCase):
    def test_parser_does_not_execute_script(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "valid.ps1"
            sentinel = Path(directory) / "must-not-exist.txt"
            _ = file.write_text(f"Set-Content -LiteralPath '{sentinel}' -Value 'not executed'\n")
            result = check("syntax", file)
            self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
            self.assertFalse(sentinel.exists())

    def test_invalid_syntax_is_a_failure(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "invalid.ps1"
            _ = file.write_text("function Broken {\n")
            result = check("syntax", file)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("diagnostics", result.stdout)

    def test_lint_warning_is_a_failure(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "warning.ps1"
            _ = file.write_text("Write-Host 'lint fixture'\n")
            result = check("lint", file)
            self.assertNotEqual(result.returncode, 0, result.stderr + result.stdout)
            self.assertIn("PSAvoidUsingWriteHost", result.stdout)

    def test_missing_file_cannot_pass(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            result = check("syntax", Path(directory) / "missing.ps1")
            self.assertNotEqual(result.returncode, 0)

if __name__ == "__main__":
    _ = unittest.main()
