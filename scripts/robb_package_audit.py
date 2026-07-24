#!/usr/bin/env python3
"""Audit a packaged Robb Agents directory for recursive releases and size drift."""
from __future__ import annotations

import argparse
from dataclasses import dataclass
import os
from pathlib import Path
import sys


MIB = 1024 * 1024
DEFAULT_MAX_UNPACKED_BYTES = 900 * MIB
DEFAULT_MAX_ARTIFACT_BYTES = 450 * MIB

FORBIDDEN_DIRECTORY_NAMES = frozenset({"release-artifacts"})
ALWAYS_FORBIDDEN_ARTIFACT_SUFFIXES = frozenset({".appimage", ".deb", ".dmg", ".msi", ".pkg", ".rpm"})
ROBB_DISTRIBUTION_PREFIXES = ("robb-agents", "robb_agents")


@dataclass(frozen=True)
class PackageFinding:
    path: str
    reason: str


@dataclass(frozen=True)
class PackageAuditReport:
    root: Path
    total_bytes: int
    file_count: int
    inventory: tuple[tuple[str, int], ...]
    findings: tuple[PackageFinding, ...]

    @property
    def ok(self) -> bool:
        return not self.findings


def format_bytes(value: int) -> str:
    if value >= 1024**3:
        return f"{value / 1024**3:.2f} GiB"
    if value >= MIB:
        return f"{value / MIB:.1f} MiB"
    if value >= 1024:
        return f"{value / 1024:.1f} KiB"
    return f"{value} B"


def _inventory_key(relative: Path) -> str:
    parts = relative.parts
    if not parts:
        return "."
    if len(parts) >= 3 and parts[:2] == ("Contents", "Resources"):
        return "/".join(parts[:3])
    return "/".join(parts[: min(2, len(parts))])


def _contains_release_output_path(relative: Path) -> bool:
    lowered = tuple(part.casefold() for part in relative.parts)
    return any(
        lowered[index : index + 3] == ("apps", "electron", "release")
        for index in range(max(0, len(lowered) - 2))
    )


def _nested_distribution_reason(relative: Path) -> str | None:
    suffix = relative.suffix.casefold()
    name = relative.name.casefold()
    if suffix in ALWAYS_FORBIDDEN_ARTIFACT_SUFFIXES:
        return f"nested distribution artifact ({suffix})"
    if suffix in {".exe", ".zip"} and name.startswith(ROBB_DISTRIBUTION_PREFIXES):
        return f"nested Robb distribution artifact ({suffix})"
    return None


def audit_package(root: Path, *, max_bytes: int | None = DEFAULT_MAX_UNPACKED_BYTES) -> PackageAuditReport:
    resolved_root = root.resolve()
    if not resolved_root.is_dir():
        raise ValueError(f"Package root is not a directory: {resolved_root}")
    if max_bytes is not None and max_bytes < 0:
        raise ValueError("Package size budget cannot be negative")

    total_bytes = 0
    file_count = 0
    inventory: dict[str, int] = {}
    findings: list[PackageFinding] = []

    for current_text, directory_names, file_names in os.walk(resolved_root, followlinks=False):
        current = Path(current_text)
        relative_current = current.relative_to(resolved_root)

        kept_directories: list[str] = []
        for directory_name in directory_names:
            directory = current / directory_name
            relative = directory.relative_to(resolved_root)
            if directory.is_symlink():
                continue
            kept_directories.append(directory_name)
            if directory_name.casefold() in FORBIDDEN_DIRECTORY_NAMES:
                findings.append(PackageFinding(str(relative), "forbidden recursive release directory"))
            if _contains_release_output_path(relative):
                findings.append(PackageFinding(str(relative), "source release output embedded in package"))
        directory_names[:] = kept_directories

        if _contains_release_output_path(relative_current):
            findings.append(PackageFinding(str(relative_current), "source release output embedded in package"))

        for file_name in file_names:
            path = current / file_name
            if path.is_symlink():
                continue
            relative = path.relative_to(resolved_root)
            try:
                size = path.stat().st_size
            except OSError as error:
                findings.append(PackageFinding(str(relative), f"cannot inspect file: {error}"))
                continue

            total_bytes += size
            file_count += 1
            key = _inventory_key(relative)
            inventory[key] = inventory.get(key, 0) + size

            reason = _nested_distribution_reason(relative)
            if reason is not None:
                findings.append(PackageFinding(str(relative), reason))

    if max_bytes is not None and total_bytes > max_bytes:
        findings.append(
            PackageFinding(
                ".",
                f"unpacked package is {format_bytes(total_bytes)}, budget is {format_bytes(max_bytes)}",
            )
        )

    sorted_inventory = tuple(sorted(inventory.items(), key=lambda item: (-item[1], item[0])))
    unique_findings = tuple(
        PackageFinding(path, reason)
        for path, reason in sorted({(finding.path, finding.reason) for finding in findings})
    )
    return PackageAuditReport(
        root=resolved_root,
        total_bytes=total_bytes,
        file_count=file_count,
        inventory=sorted_inventory,
        findings=unique_findings,
    )


def artifact_size_finding(path: Path, *, max_bytes: int = DEFAULT_MAX_ARTIFACT_BYTES) -> PackageFinding | None:
    resolved = path.resolve()
    if not resolved.is_file():
        return PackageFinding(str(resolved), "distribution artifact is missing")
    size = resolved.stat().st_size
    if size > max_bytes:
        return PackageFinding(
            str(resolved),
            f"artifact is {format_bytes(size)}, budget is {format_bytes(max_bytes)}",
        )
    return None


def print_report(report: PackageAuditReport, *, inventory_limit: int = 12) -> None:
    print(
        f"Package audit: {report.root} — {report.file_count} files, "
        f"{format_bytes(report.total_bytes)} unpacked"
    )
    for label, size in report.inventory[:inventory_limit]:
        print(f"  {format_bytes(size):>10}  {label}")
    for finding in report.findings:
        print(f"::error::{finding.path}: {finding.reason}", file=sys.stderr)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True, help="Packaged application directory to audit")
    parser.add_argument(
        "--max-mib",
        type=int,
        default=DEFAULT_MAX_UNPACKED_BYTES // MIB,
        help="Maximum unpacked package size in MiB; use 0 to disable the size budget",
    )
    parser.add_argument("--inventory-limit", type=int, default=12)
    args = parser.parse_args()

    max_bytes = None if args.max_mib == 0 else args.max_mib * MIB
    try:
        report = audit_package(args.root, max_bytes=max_bytes)
    except ValueError as error:
        print(f"::error::{error}", file=sys.stderr)
        raise SystemExit(2) from error
    print_report(report, inventory_limit=max(0, args.inventory_limit))
    if not report.ok:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
