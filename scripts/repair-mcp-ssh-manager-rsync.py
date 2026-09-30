#!/usr/bin/env python3
"""Apply a bounded, reversible rsync-statistics repair to mcp-ssh-manager 3.2.0.

The live connector is a separate local Node package used by Robb Agents. This
helper refuses a changed package, backs up its exact source, syntax-checks the
candidate, and supports an exact-hash rollback.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


OLD = """          const filesMatch = output.match(/Number of files transferred: (\\d+)/);
          const sizeMatch = output.match(/Total transferred file size: ([\\d,]+) bytes/);
          const speedMatch = output.match(/([\\d.]+) bytes\\/sec/);

          if (filesMatch) stats.filesTransferred = parseInt(filesMatch[1]);"""
NEW = """          const filesMatch = output.match(/Number of (?:regular )?files transferred: (\\d+)/);
          const sizeMatch = output.match(/Total transferred file size: ([\\d,]+) bytes/);
          const speedMatch = output.match(/([\\d.]+) bytes\\/sec/);

          if (!filesMatch) {
            reject(new Error('Rsync succeeded but its file transfer count could not be parsed'));
            return;
          }
          stats.filesTransferred = parseInt(filesMatch[1], 10);"""
OLD_LABEL = "resultText += `Files transferred: ${stats.filesTransferred}\\n`;"
NEW_LABEL = "resultText += `${dryRun ? 'Files planned' : 'Files transferred'}: ${stats.filesTransferred}\\n`;"
OLD_ZERO = "resultText += 'No files needed to be transferred\\n';"
NEW_ZERO = "resultText += dryRun ? 'No files would be transferred\\n' : 'No files needed to be transferred\\n';"
OLD_STATS = """      if (verbose || logger.verbose) {
        // Only add stats, not progress to avoid blocking with too much output
        rsyncOptions.push('--stats');
      }"""
NEW_STATS = """      // The result parser needs statistics even when verbose output is disabled.
      rsyncOptions.push('--stats');"""


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def check_target(target: Path) -> Path:
    if target.is_symlink() or target.name != "index.js" or target.parent.name != "src":
        raise RuntimeError("Target must be a regular mcp-ssh-manager/src/index.js")
    package = target.parent.parent
    if package.name != "mcp-ssh-manager":
        raise RuntimeError("Target is not in mcp-ssh-manager")
    version = json.loads((package / "package.json").read_text())["version"]
    if version != "3.2.0":
        raise RuntimeError(f"Expected mcp-ssh-manager 3.2.0, found {version}")
    return target


def syntax_check(path: Path) -> None:
    subprocess.run(["node", "--check", str(path)], check=True, capture_output=True, text=True)


def atomic_write(target: Path, data: bytes) -> None:
    mode = target.stat().st_mode & 0o777
    with tempfile.NamedTemporaryFile(dir=target.parent, suffix=".js", delete=False) as temp:
        temporary = Path(temp.name)
        temp.write(data)
        temp.flush()
        os.fsync(temp.fileno())
    try:
        os.chmod(temporary, mode)
        syntax_check(temporary)
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)


def apply(target: Path, expected_sha: str, backup_root: Path) -> dict[str, str]:
    original = target.read_bytes()
    original_sha = digest(original)
    if original_sha != expected_sha:
        raise RuntimeError(f"Source SHA mismatch: {original_sha}")
    source = original.decode("utf-8")
    if source.count(OLD_STATS) != 1 or NEW_STATS in source:
        raise RuntimeError("Expected the original conditional rsync statistics option")
    if all(source.count(fragment) == 1 for fragment in (OLD, OLD_LABEL, OLD_ZERO)):
        source = source.replace(OLD, NEW).replace(OLD_LABEL, NEW_LABEL).replace(OLD_ZERO, NEW_ZERO)
    elif not all(source.count(fragment) == 1 for fragment in (NEW, NEW_LABEL, NEW_ZERO)):
        raise RuntimeError("Expected either original or previously repaired rsync result parser")
    candidate = source.replace(OLD_STATS, NEW_STATS).encode()
    checkpoint = backup_root / (dt.datetime.now(dt.UTC).strftime("%Y%m%d-%H%M%S") + "-" + original_sha[:12])
    checkpoint.mkdir(parents=True, exist_ok=False)
    backup = checkpoint / "index.js"
    shutil.copy2(target, backup)
    if digest(backup.read_bytes()) != original_sha:
        raise RuntimeError("Backup verification failed")
    try:
        atomic_write(target, candidate)
        if digest(target.read_bytes()) != digest(candidate):
            raise RuntimeError("Installed source verification failed")
    except Exception:
        atomic_write(target, original)
        raise
    result = {"status": "applied", "target": str(target), "backup": str(backup),
              "originalSha256": original_sha, "installedSha256": digest(candidate)}
    (checkpoint / "manifest.json").write_text(json.dumps(result, indent=2) + "\n")
    return result


def rollback(target: Path, expected_sha: str, backup: Path) -> dict[str, str]:
    current_sha = digest(target.read_bytes())
    if current_sha != expected_sha:
        raise RuntimeError(f"Installed source SHA mismatch: {current_sha}")
    original = backup.read_bytes()
    if OLD_STATS.encode() not in original or NEW_STATS.encode() in original:
        raise RuntimeError("Backup does not contain the expected conditional statistics option")
    atomic_write(target, original)
    return {"status": "rolled_back", "target": str(target), "restoredSha256": digest(original)}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["apply", "rollback"])
    parser.add_argument("--target", type=Path, required=True)
    parser.add_argument("--expected-sha256", required=True)
    parser.add_argument("--backup", type=Path)
    parser.add_argument("--backup-root", type=Path, default=Path.home() /
                        "Library/Application Support/Robb Agents/Staging Backups/mcp-ssh-manager")
    args = parser.parse_args()
    if len(args.expected_sha256) != 64 or any(char not in "0123456789abcdef" for char in args.expected_sha256):
        raise RuntimeError("Expected SHA must be 64 lowercase hex characters")
    target = check_target(args.target)
    if args.mode == "apply":
        result = apply(target, args.expected_sha256, args.backup_root)
    else:
        if args.backup is None:
            raise RuntimeError("Rollback requires --backup")
        result = rollback(target, args.expected_sha256, args.backup)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
