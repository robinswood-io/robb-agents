"""Cross-architecture ripgrep binary staging for POSIX release packages."""

from __future__ import annotations

import os
import pathlib
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]


class RipgrepPackagingTests(unittest.TestCase):
    @unittest.skipIf(os.name == "nt", "POSIX packaging scripts")
    def test_cross_arch_ripgrep_fallback_packs_target_binary(self) -> None:
        builds = (
            (
                "darwin",
                "x64",
                ROOT / "apps/electron/scripts/build-dmg.sh",
                "# Vite can exceed",
            ),
            (
                "linux",
                "arm64",
                ROOT / "apps/electron/scripts/build-linux.sh",
                "# 6. Copy network interceptor",
            ),
        )
        for platform_name, architecture, script_path, end_marker in builds:
            source = script_path.read_text(encoding="utf-8")
            start = source.index("# 5. Copy target-architecture ripgrep")
            end = source.index(end_marker, start)
            staging_script = source[start:end]
            temporary_directory = tempfile.TemporaryDirectory()
            self.addCleanup(temporary_directory.cleanup)
            fixture_root = pathlib.Path(temporary_directory.name)
            repo_root = fixture_root / "repo"
            wrapper = repo_root / "node_modules" / "@vscode" / "ripgrep"
            _ = wrapper.mkdir(parents=True)
            _ = (wrapper / "package.json").write_text(
                '{"name":"@vscode/ripgrep","version":"1.18.0"}',
                encoding="utf-8",
            )
            electron_dir = fixture_root / "electron"
            temp_dir = fixture_root / "temp"
            _ = temp_dir.mkdir()
            fake_bin = fixture_root / "bin"
            _ = fake_bin.mkdir()
            newline = chr(10)
            _ = (fake_bin / "node").write_text(
                newline.join(("#!/usr/bin/env bash", "printf '1.18.0'", "")),
                encoding="utf-8",
            )
            _ = (fake_bin / "npm").write_text(
                newline.join(
                    (
                        "#!/usr/bin/env bash",
                        "set -euo pipefail",
                        '[[ "$1" == "pack" && "$2" == "$ROBB_TEST_PACKAGE" ]]',
                        "mkdir -p package/bin",
                        'printf "%s" "$ROBB_TEST_BINARY_CONTENT" > package/bin/rg',
                        "chmod +x package/bin/rg",
                        'tar -czf "vscode-ripgrep-$ROBB_TEST_PLATFORM-$ROBB_TEST_ARCH-1.18.0.tgz" package',
                        "",
                    )
                ),
                encoding="utf-8",
            )
            _ = (fake_bin / "node").chmod(0o755)
            _ = (fake_bin / "npm").chmod(0o755)
            environment = dict(os.environ)
            environment.update(
                {
                    "ROOT_DIR": str(repo_root),
                    "ELECTRON_DIR": str(electron_dir),
                    "TEMP_DIR": str(temp_dir),
                    "ARCH": architecture,
                    "PATH": f"{fake_bin}:{environment.get('PATH', '')}",
                    "ROBB_TEST_PLATFORM": platform_name,
                    "ROBB_TEST_ARCH": architecture,
                    "ROBB_TEST_PACKAGE": f"@vscode/ripgrep-{platform_name}-{architecture}@1.18.0",
                    "ROBB_TEST_BINARY_CONTENT": f"target-{platform_name}-rg",
                }
            )
            prelude = newline.join(
                (
                    "set -euo pipefail",
                    'require_path() { [[ -e "$1" ]] || { printf "missing %s" "$1" >&2; return 1; }; }',
                    "",
                )
            )
            result = subprocess.run(
                ["bash", "-c", prelude + staging_script],
                capture_output=True,
                check=False,
                cwd=fixture_root,
                env=environment,
                text=True,
            )
            self.assertEqual(result.returncode, 0, f"{platform_name}: {result.stderr}")
            staged_binary = electron_dir / "node_modules/@vscode/ripgrep/bin/rg"
            self.assertEqual(
                staged_binary.read_text(encoding="utf-8").strip(),
                f"target-{platform_name}-rg",
            )
            self.assertTrue(staged_binary.stat().st_mode & 0o111)
