"""Read-only session audit. Export allowlisted metadata, never chat text or inputs.

Use --profile ~/.craft-agent to explicitly select the real application profile.
--snapshot accepts private numbered JSON snapshots captured for an earlier audit.
Signals are triage indicators, not ground-truth outcomes or human interventions.
"""

import argparse
import hashlib
import json
import re
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal, Required, TypedDict, TypeGuard, cast

SIGNALS = {
    "provider_quota": r"usage limit has been reached|usable Antigravity quota|insufficient_quota",
    "browser_guide": r"You must read the browser tools guide before",
    "status_contract": r"Unknown status:",
    "packaged_runtime": r"resources/bin/(?:pdf-tool|markitdown|xlsx-tool):[^\n]*exec: : not found",
    "tool_schema": r"Validation failed for tool",
    "permission": r"Permission denied by user|MCP write operations are blocked|permission check failed",
    "context_compaction": r"Context compaction failed|context_length_exceeded",
    "recovery_ceiling": r"recovery ceiling|bounded recovery budget|stream ended unexpectedly after bounded automatic recovery",
    "cost_checkpoint": r"Cost guard checkpoint:",
    "delivery_queued": r"Message queued for session",
}
PATTERNS = {key: re.compile(value, re.IGNORECASE) for key, value in SIGNALS.items()}
SHORT_CONTINUATION = re.compile(
    r"\s*(?:oui[ ,.!-]*)?(?:go|ok(?: go)?|fais[- ]le(?: avec précision)?|"
    + r"poursui\w*|repren\w*|continue\w*|termine\w*)[\s.!]*", re.IGNORECASE
)
KNOWN_STATUS = {"todo", "a-faire", "in-progress", "blocked", "needs-review", "done", "cancelled"}
KNOWN_OBJECTIVE = {"active", "complete_verified", "blocked_human", "blocked_policy", "continue"}


type Number = int | float


class Objective(TypedDict, total=False):
    terminalState: str | None


class Usage(TypedDict, total=False):
    costUsd: Number | None
    totalTokens: Number | None


class Header(TypedDict, total=False):
    id: Required[str]
    createdAt: Required[Number]
    workspaceRootPath: str | None
    parentSessionId: str | None
    sessionStatus: str | None
    permissionMode: str | None
    activeObjective: Objective
    tokenUsage: Usage


class Message(TypedDict, total=False):
    type: str
    content: str
    toolStatus: str
    toolResult: object
    hidden: object
    isIntermediate: object
    isError: object


class AuditSource(TypedDict):
    path: str
    header: Header
    messages: list[Message]
    sha256: str
    bytes: int


class ManifestRow(TypedDict):
    alias: str
    sourceSha256: str
    createdAtUtc: str
    sourceBytes: int
    child: bool
    parentInCohort: str | None
    parentOutsideCohort: bool
    storedStatus: str
    storedObjective: str
    allowAll: bool
    messages: int
    roles: dict[str, int]
    tools: int
    toolStatuses: dict[str, int]
    errorRecords: int
    lastFinalLine: int | None
    quotaWithoutWork: bool
    shortContinuationLines: list[int]
    signals: dict[str, list[int]]
    headerCostUsd: Number | None
    headerTotalTokens: Number | None


class AuditReport(TypedDict):
    schemaVersion: int
    summary: dict[str, object]
    sessions: list[ManifestRow]


def is_record(value: object) -> TypeGuard[dict[str, object]]:
    return isinstance(value, dict) and all(isinstance(key, str) for key in cast(dict[object, object], value))


def is_number(value: object) -> TypeGuard[Number]:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def is_header(value: object) -> TypeGuard[Header]:
    if not is_record(value) or not isinstance(value.get('id'), str) or not is_number(value.get('createdAt')):
        return False
    if any(value.get(key) is not None and not isinstance(value[key], str)
           for key in ('workspaceRootPath', 'parentSessionId', 'sessionStatus', 'permissionMode')):
        return False
    objective = value.get('activeObjective', {})
    usage = value.get('tokenUsage', {})
    return (is_record(objective) and (objective.get('terminalState') is None or isinstance(objective['terminalState'], str))
            and is_record(usage) and all(usage.get(key) is None or is_number(usage[key]) for key in ('costUsd', 'totalTokens')))


def is_message(value: object) -> TypeGuard[Message]:
    return is_record(value) and all(key not in value or isinstance(value[key], str) for key in ('type', 'content', 'toolStatus'))


def read_json(raw: str | bytes) -> object:
    return cast(object, json.loads(raw))


def require_header(value: object) -> Header:
    if not is_header(value):
        raise ValueError('Session header is invalid; selection cannot be certified')
    return value


def require_message(value: object) -> Message:
    if not is_message(value):
        raise ValueError('Session message has invalid metadata')
    return value


def require_source(value: object) -> AuditSource:
    if not is_record(value) or value.get('parseErrors'):
        raise ValueError('Snapshot contains parse errors')
    path, digest, size = value.get('path'), value.get('sha256'), value.get('bytes')
    messages = value.get('messages')
    if not isinstance(path, str) or not isinstance(digest, str) or not isinstance(size, int) or isinstance(size, bool):
        raise TypeError('Snapshot has invalid source metadata')
    if not isinstance(messages, list):
        raise TypeError('Snapshot has no message list')
    return {'path': path, 'sha256': digest, 'bytes': size, 'header': require_header(value.get('header')),
            'messages': [require_message(item) for item in cast(list[object], messages)]}


def utc(milliseconds: Number) -> str:
    return datetime.fromtimestamp(milliseconds / 1000, UTC).isoformat()


def load_profile(profile: Path, limit: int) -> tuple[list[AuditSource], int]:
    candidates: list[tuple[Number, str, Header]] = []
    for path in (profile / "workspaces").glob("*/sessions/*/session.jsonl"):
        with path.open() as stream:
            header = require_header(read_json(next(stream)))
        created = header["createdAt"]
        candidates.append((created, str(path), header))
    candidates.sort(key=lambda item: (item[0], item[1]), reverse=True)
    selected: list[AuditSource] = []
    for created, source_path, indexed_header in candidates[:limit]:
        raw = Path(source_path).read_bytes()
        records = [read_json(line) for line in raw.splitlines()]
        header = require_header(records[0])
        if header.get("createdAt") != created or header.get("id") != indexed_header.get("id"):
            raise ValueError("Session identity changed during selection; retry the audit")
        selected.append({
            "path": source_path, "header": header, "messages": [require_message(record) for record in records[1:]],
            "sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw),
        })
    return selected, len(candidates)


def load_snapshot(directory: Path, limit: int) -> tuple[list[AuditSource], int]:
    inventory = read_json((directory / "inventory.json").read_text())
    if not is_record(inventory):
        raise ValueError("Snapshot inventory is invalid")
    rows = [require_source(read_json(path.read_text())) for path in sorted(directory.glob("[0-9][0-9][0-9].json"))]
    rows.sort(key=lambda row: (row["header"]["createdAt"], row["path"]), reverse=True)
    if [row["header"]["id"] for row in rows] != inventory["ids"]:
        raise ValueError("Snapshot inventory does not match its records")
    count = inventory.get("inventoryCount")
    if not isinstance(count, int) or isinstance(count, bool):
        raise TypeError("Snapshot inventory count is invalid")
    return rows[:limit], count


def summarize(selected: list[AuditSource], inventory_count: int) -> AuditReport:
    aliases = {(row["header"].get("workspaceRootPath"), row["header"]["id"]): f"S{i:03}"
               for i, row in enumerate(selected, 1)}
    manifest: list[ManifestRow] = []
    for index, row in enumerate(selected, 1):
        header, messages = row["header"], row["messages"]
        role_counts = Counter(message.get("type", "unknown") for message in messages)
        tools = [message for message in messages if message.get("type") == "tool"]
        errors = [message for message in messages if message.get("type") == "error"
                  or message.get("toolStatus") == "error" or message.get("isError") is True]
        signal_lines: dict[str, list[int]] = {key: [] for key in PATTERNS}
        continuation_lines: list[int] = []
        visible_user_seen = False
        for line, message in enumerate(messages, 2):
            kind = message.get("type")
            if kind in {"tool", "error"}:
                text = message.get("toolResult", "") if kind == "tool" else message.get("content", "")
                if not isinstance(text, str):
                    text = json.dumps(text)
                for key, pattern in PATTERNS.items():
                    if pattern.search(text):
                        signal_lines[key].append(line)
            if kind == "user" and not message.get("hidden"):
                if visible_user_seen and SHORT_CONTINUATION.fullmatch(message.get("content", "")):
                    continuation_lines.append(line)
                visible_user_seen = True
        status = header.get("sessionStatus")
        objective = header.get("activeObjective", {}).get("terminalState")
        parent = header.get("parentSessionId")
        final_lines = [line for line, message in enumerate(messages, 2)
                       if message.get("type") == "assistant" and not message.get("isIntermediate")]
        quota_only = bool(errors) and not tools and not role_counts["assistant"] and any(
            PATTERNS["provider_quota"].search(message.get("content", "")) for message in errors
        )
        manifest.append({
            "alias": f"S{index:03}", "sourceSha256": row["sha256"],
            "createdAtUtc": utc(header["createdAt"]), "sourceBytes": row["bytes"],
            "child": bool(parent), "parentInCohort": aliases.get((header.get("workspaceRootPath"), parent)) if parent is not None else None,
            "parentOutsideCohort": bool(parent) and (header.get("workspaceRootPath"), parent) not in aliases,
            "storedStatus": status if status is not None and status in KNOWN_STATUS else ("missing" if status is None else "custom"),
            "storedObjective": objective if objective is not None and objective in KNOWN_OBJECTIVE else ("missing" if objective is None else "other"),
            "allowAll": header.get("permissionMode") == "allow-all",
            "messages": len(messages), "roles": dict(role_counts), "tools": len(tools),
            "toolStatuses": dict(Counter(message.get("toolStatus", "missing") for message in tools)),
            "errorRecords": len(errors), "lastFinalLine": final_lines[-1] if final_lines else None,
            "quotaWithoutWork": quota_only, "shortContinuationLines": continuation_lines,
            "signals": {key: lines for key, lines in signal_lines.items() if lines},
            "headerCostUsd": header.get("tokenUsage", {}).get("costUsd"),
            "headerTotalTokens": header.get("tokenUsage", {}).get("totalTokens"),
        })
    def count(field: Literal["storedStatus", "storedObjective"]) -> dict[str, int]:
        return dict(Counter(row[field] for row in manifest))
    costs = [row["headerCostUsd"] for row in manifest if row["headerCostUsd"] is not None]
    summary: dict[str, object] = {
        "inventoryCount": inventory_count, "selectedCount": len(manifest),
        "oldestCreatedAtUtc": manifest[-1]["createdAtUtc"] if manifest else None,
        "newestCreatedAtUtc": manifest[0]["createdAtUtc"] if manifest else None,
        "messages": sum(row["messages"] for row in manifest),
        "tools": sum(row["tools"] for row in manifest),
        "roles": dict(sum((Counter(row["roles"]) for row in manifest), Counter[str]())),
        "toolStatuses": dict(sum((Counter(row["toolStatuses"]) for row in manifest), Counter[str]())),
        "children": sum(row["child"] for row in manifest),
        "parentsOutsideCohort": sum(row["parentOutsideCohort"] for row in manifest),
        "emptySessions": sum(row["messages"] == 0 for row in manifest),
        "quotaWithoutWork": sum(row["quotaWithoutWork"] for row in manifest),
        "quotaWithoutWorkMarkedDone": sum(row["quotaWithoutWork"] and row["storedStatus"] == "done" for row in manifest),
        "allowAll": sum(row["allowAll"] for row in manifest),
        "storedStatuses": count("storedStatus"), "storedObjectives": count("storedObjective"),
        "shortContinuations": sum(len(row["shortContinuationLines"]) for row in manifest),
        "sessionsWithShortContinuations": sum(bool(row["shortContinuationLines"]) for row in manifest),
        "headerCostUsd": sum(costs), "headerCostMissing": len(manifest) - len(costs),
        "topFiveHeaderCostShare": sum(sorted(costs, reverse=True)[:5]) / sum(costs) if sum(costs) else None,
        "headerTotalTokens": sum(row["headerTotalTokens"] or 0 for row in manifest),
        "signals": {key: {
            "records": sum(len(row["signals"].get(key, [])) for row in manifest),
            "sessions": sum(key in row["signals"] for row in manifest),
        } for key in PATTERNS},
    }
    return {"schemaVersion": 1, "summary": summary, "sessions": manifest}


class AuditArguments(argparse.Namespace):
    profile: Path | None = None
    snapshot: Path | None = None
    limit: int = 100
    output: Path = Path()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    _ = source.add_argument("--profile", type=Path)
    _ = source.add_argument("--snapshot", type=Path)
    _ = parser.add_argument("--limit", type=int, default=100)
    _ = parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(namespace=AuditArguments())
    if args.limit < 1:
        parser.error("--limit must be positive")
    source_path = args.profile or args.snapshot
    if source_path is None:
        parser.error("A profile or snapshot is required")
    source_path = source_path.expanduser().resolve()
    output = args.output.expanduser().resolve()
    if output == source_path or source_path in output.parents:
        parser.error("Audit output must remain outside its source profile/snapshot")
    selected, inventory = (load_profile(source_path, args.limit) if args.profile
                           else load_snapshot(source_path, args.limit))
    if len(selected) != args.limit:
        parser.error(f"Requested {args.limit} sessions; only {len(selected)} available")
    result = summarize(selected, inventory)
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("x") as stream:
        _ = stream.write(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(result["summary"], ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
