#!/usr/bin/env python3
"""Prepare media-contact enrichment candidates without sending outreach."""

from __future__ import annotations

import argparse
import csv
import json
import os
from argparse import Namespace
from dataclasses import dataclass
from pathlib import Path
from typing import cast

from pydantic import ValidationError
from robinswood_media_contact_enrichment_service import (
    EMAIL_RE,
    ENV,
    EXCLUDED_DOMAINS,
    UA,
    WEBMAIL,
    as_candidate,
    as_candidates,
    as_object,
    csv_cell,
    domain_allowed,
    domain_from_url,
    eligible_for_processing,
    email_domain,
    email_finder,
    hunter,
    hunter_key,
    norm,
    norm_email,
    now,
    row_outcome,
    split_name,
    verify_email,
    wiki_enrich,
)
from robinswood_media_contact_enrichment_types import (
    JSON_VALUE_ADAPTER,
    EnrichedCandidate,
    JsonObject,
    JsonValue,
)

__all__ = [
    "EMAIL_RE",
    "ENV",
    "EXCLUDED_DOMAINS",
    "UA",
    "WEBMAIL",
    "as_candidate",
    "as_candidates",
    "as_object",
    "csv_cell",
    "domain_allowed",
    "domain_from_url",
    "eligible_for_processing",
    "email_domain",
    "email_finder",
    "hunter",
    "hunter_key",
    "norm",
    "norm_email",
    "now",
    "row_outcome",
    "split_name",
    "verify_email",
    "wiki_enrich",
]


@dataclass
class Arguments(Namespace):
    batch_size: int = 25
    max_hunter_calls: int = 8
    reset: bool = False


ROOT = Path("/srv/rbw-agents-oss")
WS = Path("/home/craft/.craft-agent/workspaces/my-workspace-2")
OPS = WS / "campaigns/ops"
BASE = OPS / "robinswood-media-contact-base-2026.json"
STATE = OPS / "robinswood-media-contact-enrichment-2026-state.json"
ENRICHED = OPS / "robinswood-media-contact-base-2026-enriched.json"
QUEUE = OPS / "robinswood-media-contact-enrichment-2026-review-queue.json"
QUEUE_CSV = OPS / "robinswood-media-contact-enrichment-2026-review-queue.csv"
REPORT = OPS / "robinswood-media-contact-enrichment-2026-last.json"
REPORT_MD = OPS / "robinswood-media-contact-enrichment-2026-last.md"
LEDGER = OPS / "robinswood-media-contact-enrichment-2026-ledger.jsonl"


def read(path: Path, default: JsonValue) -> JsonValue:
    try:
        raw: object = cast(object, json.loads(path.read_text(encoding="utf-8")))
        return JSON_VALUE_ADAPTER.validate_python(raw)
    except (OSError, UnicodeError, json.JSONDecodeError, ValidationError):
        return default


def write(path: Path, data: object) -> None:
    json_data = JSON_VALUE_ADAPTER.validate_python(data)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    _ = tmp.write_text(
        json.dumps(json_data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    os.replace(tmp, path)


def append_jsonl(path: Path, row: JsonObject) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as stream:
        _ = stream.write(json.dumps(row, ensure_ascii=False) + "\n")


def main() -> int:
    parser = argparse.ArgumentParser()
    _ = parser.add_argument("--batch-size", type=int, default=25)
    _ = parser.add_argument("--max-hunter-calls", type=int, default=8)
    _ = parser.add_argument("--reset", action="store_true")
    args = parser.parse_args(namespace=Arguments())
    base = as_object(read(BASE, {}))
    contacts = as_candidates(base.get("contacts", []))
    if ENRICHED.exists() and not args.reset:
        current = as_object(read(ENRICHED, {}))
        current_contacts = as_candidates(current.get("contacts", []))
        contacts = current_contacts or contacts
    state = {} if args.reset else as_object(read(STATE, {}))
    next_value = state.get("nextIndex")
    if next_value is None or next_value == "" or next_value is False:
        start = 0
    elif isinstance(next_value, (str, int, float)):
        start = int(next_value)
    else:
        raise TypeError("saved nextIndex must be an integer-compatible JSON value")
    key = hunter_key()
    hunter_budget = max(0, args.max_hunter_calls)
    processed: list[EnrichedCandidate] = []
    events: list[JsonObject] = []
    index = start
    scanned = 0
    count = len(contacts)
    while scanned < count and len(processed) < args.batch_size:
        current_index = index % count
        row = contacts[current_index]
        scanned += 1
        index = current_index + 1
        if not eligible_for_processing(row):
            continue
        enriched, hunter_budget, event = row_outcome(row, key, hunter_budget)
        contacts[current_index] = enriched
        processed.append(enriched)
        events.append(event)
        append_jsonl(LEDGER, {**event, "timestamp": now()})
        if hunter_budget <= 0 and len(processed) >= max(5, args.batch_size // 3):
            break

    review_statuses = {
        "candidate_email_found_review_required",
        "email_verified_review_required",
        "email_not_verified_review_or_replace",
        "profile_context_enriched",
    }
    review = [
        row
        for row in contacts
        if isinstance(row.get("enrichmentStatus"), str)
        and row.get("enrichmentStatus") in review_statuses
    ]
    meta = as_object(base.get("meta", {})) | {
        "enrichedAt": now(),
        "enrichmentContract": "media-contact-enrichment-v1-prepare-only-no-outbound",
        "outboundPolicy": "No automatic send; enrichment never sets direct outbound eligibility.",
    }
    write(ENRICHED, {"meta": meta, "contacts": contacts})
    write(
        QUEUE,
        {
            "generatedAt": now(),
            "contract": "media-contact-enrichment-review-queue-v1",
            "outboundAllowed": False,
            "items": review,
        },
    )
    fields = [
        "id",
        "recordType",
        "contactName",
        "email",
        "enrichedEmail",
        "media",
        "country",
        "sourceUrl",
        "enrichmentStatus",
        "nextStep",
        "qualityScore",
        "outreachStatus",
    ]
    with QUEUE_CSV.open("w", newline="", encoding="utf-8") as stream:
        writer = csv.DictWriter(stream, fieldnames=fields)
        _ = cast(object, writer.writeheader())
        for row in review:
            csv_row = {field: csv_cell(row.get(field, "")) for field in fields}
            _ = cast(object, writer.writerow(csv_row))
    done = sum(1 for row in contacts if row.get("enrichmentStatus"))
    remaining = sum(1 for row in contacts if eligible_for_processing(row))
    hunter_calls_used = args.max_hunter_calls - hunter_budget
    report_value: object = {
        "generatedAt": now(),
        "capabilityId": "robinswood-media-contact-enrichment-2026",
        "ok": True,
        "status": "processed" if processed else "no_eligible_batch",
        "mode": "prepare-only",
        "summary": (
            f"media contact enrichment: processed={len(processed)} enrichedTotal={done} "
            f"remaining={remaining} hunterCallsUsed={hunter_calls_used}"
        ),
        "counts": {
            "baseContacts": count,
            "processedThisRun": len(processed),
            "enrichedTotal": done,
            "remainingEligible": remaining,
            "reviewQueueItems": len(review),
            "hunterCallsUsed": hunter_calls_used,
            "hunterKeyPresent": bool(key),
        },
        "state": {"nextIndex": index % count if count else 0},
        "artifacts": {
            "enrichedJson": str(ENRICHED),
            "reviewQueueJson": str(QUEUE),
            "reviewQueueCsv": str(QUEUE_CSV),
            "stateJson": str(STATE),
            "ledgerJsonl": str(LEDGER),
            "reportJson": str(REPORT),
            "reportMd": str(REPORT_MD),
        },
        "events": events[:20],
        "guardrails": [
            "prepare_only",
            "no_outbound_message",
            "enrichment_never_sets_direct_send_eligibility",
            "legacy_suppressed_bounced_rows_skipped",
        ],
    }
    report = as_object(JSON_VALUE_ADAPTER.validate_python(report_value))
    counts = as_object(report["counts"])
    artifacts = as_object(report["artifacts"])
    markdown = [
        "# Robinswood Media Contact Enrichment 2026",
        "",
        f"- Generated: {report['generatedAt']}",
        f"- Status: {report['status']}",
        f"- Summary: {report['summary']}",
        "- Outbound allowed: **false**",
        "",
        "## Counts",
    ]
    markdown.extend(f"- {name}: {value}" for name, value in counts.items())
    markdown.extend(["", "## Artifacts"])
    markdown.extend(f"- {name}: {value}" for name, value in artifacts.items())
    write(
        STATE,
        {
            "updatedAt": now(),
            "nextIndex": index % count if count else 0,
            "lastRun": counts,
        },
    )
    write(REPORT, report)
    _ = REPORT_MD.write_text("\n".join(markdown) + "\n", encoding="utf-8")
    print(
        json.dumps(
            {
                "ok": True,
                "status": report["status"],
                "summary": report["summary"],
                "reportJson": str(REPORT),
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
