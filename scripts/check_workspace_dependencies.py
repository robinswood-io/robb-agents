"""Audit maintained direct dependencies using configured registries and actual installs."""
from __future__ import annotations

import concurrent.futures
import datetime
import hashlib
import json
import platform
import re
import subprocess
import sys
import tomllib
import urllib.request
from http.client import HTTPResponse
from pathlib import Path
from typing import TypedDict, cast

from json_sources import object_list, object_mapping

ROOT = Path(__file__).resolve().parents[1]


class Dependency(TypedDict):
    manifest: str
    group: str
    package: str
    registry_name: str
    spec: str
    installed: str | None


class Metadata(TypedDict):
    latest: str
    os: list[str]
    cpu: list[str]


def fields(value: object) -> dict[str, object]:
    if not object_mapping(value):
        raise TypeError("Expected a registry/manifest object")
    result: dict[str, object] = {}
    for key, item in value.items():
        if not isinstance(key, str):
            raise TypeError("Expected string keys")
        result[key] = item
    return result


def strings(value: object) -> list[str]:
    if not object_list(value) or not all(isinstance(item, str) for item in value):
        raise ValueError("Expected a string list")
    return [str(item) for item in value]


def read_json(path: Path) -> dict[str, object]:
    value = cast(object, json.loads(path.read_text()))
    return fields(value)


def command(args: list[str]) -> str:
    result = subprocess.run(
        ["rtk", *args], cwd=ROOT, capture_output=True, text=True, timeout=90, check=False,
    )
    if result.returncode:
        raise RuntimeError("Dependency command failed: " + args[0])
    return result.stdout.strip()


def npm_json(package: str, properties: list[str]) -> object:
    value = cast(object, json.loads(command(["npm", "view", package, *properties, "--json"])))
    return value


def stable(value: str) -> bool:
    return re.fullmatch(r"\d+\.\d+\.\d+", value) is not None


def npm_metadata(package: str) -> tuple[str, Metadata]:
    data = fields(npm_json(package, ["version", "dist-tags", "os", "cpu"]))
    version = data.get("version")
    if not isinstance(version, str):
        raise TypeError("Missing registry version: " + package)
    if not stable(version):
        tags = fields(data.get("dist-tags"))
        legacy = tags.get("legacy")
        if isinstance(legacy, str) and stable(legacy):
            version = legacy
        else:
            values = strings(npm_json(package, ["versions"]))
            candidates = [item for item in values if stable(item)]
            if not candidates:
                raise ValueError("No stable release: " + package)
            version = max(candidates, key=lambda item: tuple(int(part) for part in item.split(".")))
        selected_value = npm_json(package + "@" + version, ["version", "deprecated"])
        selected = {"version": selected_value} if isinstance(selected_value, str) else fields(selected_value)
        if selected.get("version") != version or selected.get("deprecated"):
            raise ValueError("Stable candidate is deprecated: " + package)
    return package, {
        "latest": version, "os": strings(data.get("os", [])), "cpu": strings(data.get("cpu", [])),
    }


def inventory() -> list[str]:
    return sorted(set(command(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"]
    ).split("\0")) - {""})


def installed_version(manifest: Path, package: str) -> str | None:
    parent = manifest.parent
    while parent.is_relative_to(ROOT):
        candidate = parent / "node_modules" / package / "package.json"
        if candidate.is_file():
            version = read_json(candidate).get("version")
            return version if isinstance(version, str) else None
        if parent == ROOT:
            break
        parent = parent.parent
    return None


def dependencies(names: list[str]) -> list[Dependency]:
    result: list[Dependency] = []
    for name in names:
        path = ROOT / name
        if path.name != "package.json" or not path.is_file():
            continue
        manifest = read_json(path)
        for group in ("dependencies", "devDependencies", "optionalDependencies", "overrides"):
            for package, spec in fields(manifest.get(group, {})).items():
                if not isinstance(spec, str):
                    raise TypeError("Invalid dependency spec: " + package)
                if spec.startswith("workspace:"):
                    continue
                alias = re.fullmatch(r"npm:(@[^/]+/[^@]+|[^@]+)(?:@(.+))?", spec)
                result.append({
                    "manifest": name, "group": group, "package": package, "spec": spec,
                    "registry_name": alias.group(1) if alias else package,
                    "installed": installed_version(path, package),
                })
    return result


def matches_platform(values: list[str], current: str) -> bool:
    if "!" + current in values:
        return False
    positive = [item for item in values if not item.startswith("!")]
    return not positive or current in positive or "any" in positive


def compatibility_exceptions() -> set[tuple[str, str, str]]:
    path = ROOT / "bmad/dependency-exceptions.json"
    if not path.exists():
        return set()
    document = read_json(path)
    if document.get("release") != read_json(ROOT / "package.json").get("version"):
        raise ValueError("Compatibility exceptions do not apply to this release")
    if document.get("approved_by") != "Thibault" or not document.get("authorization_reference"):
        raise ValueError("Missing explicit human authorization reference")
    entries = document.get("dependencies")
    if not object_list(entries):
        raise TypeError("Invalid compatibility exceptions")
    allowed = {
        ("package.json", "typescript", "6.0.3"),
        ("packages/messaging-whatsapp-worker/package.json", "@whiskeysockets/baileys", "7.0.0-rc14"),
    }
    result: set[tuple[str, str, str]] = set()
    for entry in entries:
        data = fields(entry)
        values = (data.get("manifest"), data.get("package"), data.get("version"))
        if not all(isinstance(value, str) for value in values):
            raise ValueError("Invalid exception identity")
        key = (str(values[0]), str(values[1]), str(values[2]))
        if key not in allowed or not data.get("reason"):
            raise ValueError("Exception outside the two proposed compatibility versions")
        result.add(key)
    # These fields record a separately established user decision; they do not grant authority.
    return result


def python_pins(names: list[str]) -> dict[str, str]:
    result: dict[str, str] = {}
    for name in names:
        path = ROOT / name
        if not path.is_file():
            continue
        specs: list[str]
        if path.name == "requirements.txt" or path.name.endswith("-requirements.txt"):
            specs = [line.strip() for line in path.read_text().splitlines()
                     if line.strip() and not line.lstrip().startswith("#")]
        elif path.suffix == ".py":
            match = re.search(r"(?ms)^# /// script\n(.*?)^# ///", path.read_text())
            if not match:
                continue
            header = "\n".join(line.removeprefix("# ") for line in match.group(1).splitlines())
            specs = strings(fields(cast(object, tomllib.loads(header))).get("dependencies", []))
        else:
            continue
        for spec in specs:
            pinned = re.fullmatch(r"([\w.-]+)(?:\[[^]]+\])?==([\w.]+)", spec)
            if not pinned:
                raise ValueError("Python runtime dependency must be pinned: " + name)
            package, version = pinned.groups()
            package = re.sub(r"[-_.]+", "-", package).lower()
            if package in result and result[package] != version:
                raise ValueError("Inconsistent Python runtime pin: " + package)
            result[package] = version
    return result


def check_python(pin: tuple[str, str]) -> str | None:
    package, version = pin
    with cast(HTTPResponse, urllib.request.urlopen("https://pypi.org/pypi/" + package + "/json", timeout=30)) as response:
        value = cast(object, json.load(response))
    latest = fields(fields(value).get("info")).get("version")
    return None if latest == version else "python_not_latest_stable:" + package


def binary_issues() -> list[str]:
    source = (ROOT / "scripts/build/common/binary-downloads.ts").read_text()
    versions = {"rtk-ai/rtk": "v" + str(read_json(ROOT / "scripts/vendor/rtk-manifest.json")["version"])}
    for repository, constant in [("astral-sh/uv", "UV_VERSION"), ("oven-sh/bun", "BUN_VERSION")]:
        match = re.search(r"export const " + constant + r" = '([^']+)'", source)
        if not match:
            raise ValueError("Missing binary runtime pin: " + constant)
        versions[repository] = match.group(1)
    issues: list[str] = []
    for repository, expected in versions.items():
        request = urllib.request.Request("https://api.github.com/repos/" + repository + "/releases/latest",
                                         headers={"User-Agent": "Robb-release-quality"})
        with cast(HTTPResponse, urllib.request.urlopen(request, timeout=30)) as response:
            value = cast(object, json.load(response))
        if fields(value).get("tag_name") != expected:
            issues.append("binary_not_latest_stable:" + repository)
    return issues


def verified_sprintf_patch(row: Dependency, latest: str) -> bool:
    if row["package"] != "sprintf-js" or row["spec"] != "file:./scripts/vendor/sprintf-js":
        return False
    vendor = ROOT / "scripts/vendor/sprintf-js"
    provenance = read_json(vendor / "upstream.json")
    installed = ROOT / "node_modules/sprintf-js/src/sprintf.js"
    digest = provenance.get("patched_source_sha256")
    return (provenance.get("base_version") == latest and installed.exists()
            and hashlib.sha256((vendor / "src/sprintf.js").read_bytes()).hexdigest() == digest
            and hashlib.sha256(installed.read_bytes()).hexdigest() == digest)
def main() -> int:
    names = inventory()
    rows = dependencies(names)
    approved = compatibility_exceptions()
    with concurrent.futures.ThreadPoolExecutor(max_workers=10) as pool:
        metadata = dict(pool.map(npm_metadata, sorted({row["registry_name"] for row in rows})))
        python_issues = list(pool.map(check_python, python_pins(names).items()))
    issues: list[str] = [item for item in python_issues if item is not None] + binary_issues()
    nonlocal_binaries: list[str] = []
    declared_only_overrides: list[str] = []
    lock = (ROOT / "bun.lock").read_text()
    cpu = {"aarch64": "arm64", "amd64": "x64", "x86_64": "x64"}.get(platform.machine().lower(), platform.machine())
    for row in rows:
        data = metadata[row["registry_name"]]
        actual = row["installed"]
        if verified_sprintf_patch(row, data["latest"]):
            continue
        if row["group"] == "overrides" and actual is None:
            pinned = row["spec"]
            if pinned.startswith("file:"):
                local = (ROOT / pinned.removeprefix("file:") / "package.json").resolve()
                if not local.is_relative_to(ROOT):
                    raise ValueError("Local dependency outside the public checkout")
                local_version = read_json(local).get("version")
                pinned = local_version if isinstance(local_version, str) else ""
            if pinned != data["latest"]:
                issues.append("override_not_latest_stable:" + row["package"])
            declared_only_overrides.append(row["package"])
            continue
        if not matches_platform(data["os"], sys.platform) or not matches_platform(data["cpu"], cpu):
            version = data["latest"]
            if version not in row["spec"] or ('"' + row["registry_name"] + "@" + version + '"') not in lock:
                issues.append("nonlocal_binary_not_locked_latest:" + row["package"])
            nonlocal_binaries.append(row["package"])
        elif actual != data["latest"] and (row["manifest"], row["package"], actual or "") not in approved:
            issues.append("not_latest_stable:" + row["manifest"] + ":" + row["package"])
    report = {
        "checked_at": datetime.datetime.now(datetime.UTC).isoformat(),
        "direct_entries": rows, "latest_stable": metadata, "issues": issues,
        "nonlocal_binaries": nonlocal_binaries, "approved_compatibility_versions": sorted(approved),
        "declared_only_overrides": declared_only_overrides,
        "scope": "Configured npm registries; installed direct trees; off-platform binary locks; PEP723 pins on PyPI.",
    }
    destination = ROOT / "bmad/quality-logs/dependencies.json"
    destination.parent.mkdir(parents=True, exist_ok=True)
    _ = destination.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"dependencies": len(rows), "issues": issues,
                      "off_platform_binaries": len(nonlocal_binaries)}))
    return 1 if issues else 0


if __name__ == "__main__":
    raise SystemExit(main())
