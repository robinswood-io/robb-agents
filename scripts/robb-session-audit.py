#!/usr/bin/env python3
"""Read-only session audit. Export allowlisted metadata, never chat text or inputs.

Use --profile ~/.craft-agent to explicitly select the real application profile.
--snapshot accepts private numbered JSON snapshots captured for an earlier audit.
Signals are triage indicators, not ground-truth outcomes or human interventions.
"""

import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re


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
PATTERNS = {key: re.compile(value, re.I) for key, value in SIGNALS.items()}
SHORT_CONTINUATION = re.compile(
    r"\s*(?:oui[ ,.!-]*)?(?:go|ok(?: go)?|fais[- ]le(?: avec précision)?|"
    r"poursui\w*|repren\w*|continue\w*|termine\w*)[\s.!]*", re.I
)
KNOWN_STATUS = {"todo", "a-faire", "in-progress", "blocked", "needs-review", "done", "cancelled"}
KNOWN_OBJECTIVE = {"active", "complete_verified", "blocked_human", "blocked_policy", "continue"}


def utc(milliseconds):
    return datetime.fromtimestamp(milliseconds / 1000, timezone.utc).isoformat()


def load_profile(profile, limit):
    candidates = []
    for path in (profile / "workspaces").glob("*/sessions/*/session.jsonl"):
        with path.open() as stream:
            header = json.loads(next(stream))
        created = header.get("createdAt")
        if not isinstance(created, (int, float)) or isinstance(created, bool):
            raise ValueError("Session without numeric createdAt; selection cannot be certified")
        candidates.append((created, str(path), header))
    candidates.sort(key=lambda item: (item[0], item[1]), reverse=True)
    selected = []
    for created, source_path, indexed_header in candidates[:limit]:
        raw = Path(source_path).read_bytes()
        records = [json.loads(line) for line in raw.splitlines()]
        header = records[0]
        if header.get("createdAt") != created or header.get("id") != indexed_header.get("id"):
            raise ValueError("Session identity changed during selection; retry the audit")
        selected.append({
            "path": source_path, "header": header, "messages": records[1:],
            "sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw),
        })
    return selected, len(candidates)


def load_snapshot(directory, limit):
    inventory = json.loads((directory / "inventory.json").read_text())
    rows = [json.loads(path.read_text()) for path in sorted(directory.glob("[0-9][0-9][0-9].json"))]
    if any(row.get("parseErrors") for row in rows):
        raise ValueError("Snapshot contains parse errors")
    rows.sort(key=lambda row: (row["header"]["createdAt"], row["path"]), reverse=True)
    if [row["header"]["id"] for row in rows] != inventory["ids"]:
        raise ValueError("Snapshot inventory does not match its records")
    return rows[:limit], inventory["inventoryCount"]


def summarize(selected, inventory_count):
    aliases = {(row["header"].get("workspaceRootPath"), row["header"]["id"]): f"S{i:03}"
               for i, row in enumerate(selected, 1)}
    manifest = []
    for index, row in enumerate(selected, 1):
        header, messages = row["header"], row["messages"]
        role_counts = Counter(message.get("type", "unknown") for message in messages)
        tools = [message for message in messages if message.get("type") == "tool"]
        errors = [message for message in messages if message.get("type") == "error"
                  or message.get("toolStatus") == "error" or message.get("isError") is True]
        signal_lines = {key: [] for key in PATTERNS}
        continuation_lines = []
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
            "child": bool(parent), "parentInCohort": aliases.get((header.get("workspaceRootPath"), parent)),
            "parentOutsideCohort": bool(parent) and (header.get("workspaceRootPath"), parent) not in aliases,
            "storedStatus": status if status in KNOWN_STATUS else ("missing" if status is None else "custom"),
            "storedObjective": objective if objective in KNOWN_OBJECTIVE else ("missing" if objective is None else "other"),
            "allowAll": header.get("permissionMode") == "allow-all",
            "messages": len(messages), "roles": dict(role_counts), "tools": len(tools),
            "toolStatuses": dict(Counter(message.get("toolStatus", "missing") for message in tools)),
            "errorRecords": len(errors), "lastFinalLine": final_lines[-1] if final_lines else None,
            "quotaWithoutWork": quota_only, "shortContinuationLines": continuation_lines,
            "signals": {key: lines for key, lines in signal_lines.items() if lines},
            "headerCostUsd": header.get("tokenUsage", {}).get("costUsd"),
            "headerTotalTokens": header.get("tokenUsage", {}).get("totalTokens"),
        })
    def count(field):
        return dict(Counter(row[field] for row in manifest))
    costs = [row["headerCostUsd"] for row in manifest if row["headerCostUsd"] is not None]
    summary = {
        "inventoryCount": inventory_count, "selectedCount": len(manifest),
        "oldestCreatedAtUtc": manifest[-1]["createdAtUtc"] if manifest else None,
        "newestCreatedAtUtc": manifest[0]["createdAtUtc"] if manifest else None,
        "messages": sum(row["messages"] for row in manifest),
        "tools": sum(row["tools"] for row in manifest),
        "roles": dict(sum((Counter(row["roles"]) for row in manifest), Counter())),
        "toolStatuses": dict(sum((Counter(row["toolStatuses"]) for row in manifest), Counter())),
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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--profile", type=Path)
    source.add_argument("--snapshot", type=Path)
    parser.add_argument("--limit", type=int, default=100)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.limit < 1:
        parser.error("--limit must be positive")
    source_path = (args.profile or args.snapshot).expanduser().resolve()
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
        stream.write(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(result["summary"], ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
