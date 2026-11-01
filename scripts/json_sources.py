"""Maintain short JSON source partitions while preserving existing runtime formats."""
from __future__ import annotations

import json
import math
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import TypeAlias, TypeGuard, cast

JsonValue: TypeAlias = None | bool | int | float | str | list["JsonValue"] | dict[str, "JsonValue"]
INDEX = "config-sources/index.json"
MAX_SOURCE_LINES = 450


def object_list(value: object) -> TypeGuard[list[object]]:
    return isinstance(value, list)


def object_mapping(value: object) -> TypeGuard[dict[object, object]]:
    return isinstance(value, dict)


def checked_json(value: object) -> JsonValue:
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float) and math.isfinite(value):
        return value
    if object_list(value):
        return [checked_json(item) for item in value]
    if object_mapping(value):
        result: dict[str, JsonValue] = {}
        for key, item in value.items():
            if not isinstance(key, str):
                raise TypeError("JSON object keys must be strings")
            result[key] = checked_json(item)
        return result
    raise ValueError("Expected finite JSON data")


def unique_pairs(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"Duplicate JSON key: {key}")
        result[key] = value
    return result


def read_json(path: Path, *, source: bool = False) -> JsonValue:
    text = path.read_text(encoding="utf-8")
    if source and len(text.splitlines()) > 500:
        raise ValueError(f"Source exceeds 500 lines: {path}")
    value = cast(object, json.loads(text, object_pairs_hook=unique_pairs))
    return checked_json(value)


def pretty(value: JsonValue) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n"


def canonical(value: JsonValue) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def inside(root: Path, relative: str) -> Path:
    target = (root / relative).resolve()
    if Path(relative).is_absolute() or not target.is_relative_to(root.resolve()):
        raise ValueError(f"JSON source path escapes its owner: {relative}")
    return target


@dataclass(frozen=True)
class DataSource:
    output: str
    source: str


def sources(root: Path) -> list[DataSource]:
    index = read_json(root / INDEX, source=True)
    if not isinstance(index, dict) or index.get("format") != 1:
        raise ValueError("Unsupported JSON source index")
    rows = index.get("sources")
    if not isinstance(rows, list):
        raise TypeError("Missing JSON source registry")
    result: list[DataSource] = []
    for row in rows:
        if not isinstance(row, dict):
            raise TypeError("Invalid JSON source descriptor")
        output, source = row.get("output"), row.get("source")
        if not isinstance(output, str) or not isinstance(source, str):
            raise TypeError("JSON source paths must be strings")
        _ = inside(root, output)
        _ = inside(root, source)
        result.append(DataSource(output, source))
    if len({item.output for item in result}) != len(result):
        raise ValueError("Duplicate JSON source output")
    return result


def capture_plan(root: Path, spec: DataSource) -> dict[Path, str]:
    value = read_json(inside(root, spec.output))
    base = inside(root, spec.source)
    plan: dict[Path, str] = {}
    arrays: dict[str, JsonValue] = {}
    groups: dict[str, JsonValue] = {}
    if isinstance(value, list):
        header: JsonValue = []
        groups["items"] = value
    elif isinstance(value, dict):
        header = {key: [] if isinstance(item, list) else item for key, item in value.items()}
        groups = {key: item for key, item in value.items() if isinstance(item, list)}
    else:
        raise TypeError("Partitioned JSON must have an object or array root")
    for key, rows in groups.items():
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_-]*", key) or not isinstance(rows, list):
            raise ValueError("Invalid partition group")
        paths: list[JsonValue] = []
        chunk: list[JsonValue] = []
        def flush(group: str, partitions: list[JsonValue], batch: list[JsonValue]) -> None:
            name = f"{group}/{len(partitions) + 1:03d}.json"
            plan[inside(base, name)] = pretty(batch)
            partitions.append(name)
        for row in rows:
            if chunk and len(pretty([*chunk, row]).splitlines()) > MAX_SOURCE_LINES:
                flush(key, paths, chunk)
                chunk = []
            chunk.append(row)
        if chunk:
            flush(key, paths, chunk)
        arrays[key] = paths
    plan[inside(base, "header.json")] = pretty(header)
    plan[inside(base, "manifest.json")] = pretty({"format": 1, "arrays": arrays})
    for path, text in plan.items():
        if len(text.splitlines()) > MAX_SOURCE_LINES:
            raise ValueError(f"A JSON record needs a smaller domain boundary: {path}")
    return plan


def assemble(root: Path, spec: DataSource) -> JsonValue:
    base = inside(root, spec.source)
    manifest = read_json(inside(base, "manifest.json"), source=True)
    header = read_json(inside(base, "header.json"), source=True)
    if not isinstance(manifest, dict) or manifest.get("format") != 1:
        raise ValueError("Invalid partition manifest")
    arrays = manifest.get("arrays")
    if not isinstance(arrays, dict):
        raise TypeError("Missing partition groups")
    combined: dict[str, list[JsonValue]] = {}
    for key, names in arrays.items():
        if not isinstance(names, list):
            raise TypeError("Partition paths must be an array")
        rows: list[JsonValue] = []
        for name in names:
            if not isinstance(name, str):
                raise TypeError("Partition paths must be strings")
            part = read_json(inside(base, name), source=True)
            if not isinstance(part, list):
                raise TypeError("A JSON partition must contain an array")
            rows.extend(part)
        combined[key] = rows
    if isinstance(header, list):
        if header or set(combined) != {"items"}:
            raise ValueError("Invalid array-root partition header")
        return combined["items"]
    if not isinstance(header, dict):
        raise TypeError("Invalid object-root partition header")
    for key, rows in combined.items():
        if header.get(key) != []:
            raise ValueError(f"Missing empty array placeholder: {key}")
        header[key] = rows
    return header


def matches(root: Path, spec: DataSource) -> bool:
    return canonical(read_json(inside(root, spec.output))) == canonical(assemble(root, spec))


def main(argv: list[str]) -> int:
    mode = argv[0] if argv else "check"
    if mode not in {"check", "capture", "write"} or len(argv) > 1:
        raise ValueError("Usage: json_sources.py [check|capture|write]")
    root = Path(__file__).resolve().parents[1]
    specs = sources(root)
    writes: dict[Path, str] = {}
    if mode == "capture":
        for spec in specs:
            writes.update(capture_plan(root, spec))
    elif mode == "write":
        for spec in specs:
            writes[inside(root, spec.output)] = pretty(assemble(root, spec))
    for path, text in writes.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        _ = path.write_text(text, encoding="utf-8")
    failed = [spec.output for spec in specs if not matches(root, spec)]
    for name in failed:
        print(f"JSON source drift: {name}", file=sys.stderr)
    print(f"{len(specs)} JSON datasets checked; {len(writes)} source/output files written; {len(failed)} mismatches")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
