#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

from flow_contact_evidence_provider import Quota, capacity, discover, public_company
from flow_contact_evidence_state import (
    OBJECT,
    Row,
    due,
    failclass,
    iso,
    norm,
    now,
    object_row,
    object_rows,
    retry_at,
    retry_due_for_reuse,
    role_ok,
    source_urls,
    split_name,
    valid_url,
)
from robinswood_flow_lock import chain_lock
from robinswood_pme_hdf_hunter_contact_enrichment import (
    load_key,
)

__all__ = [
    "capacity",
    "discover",
    "due",
    "failclass",
    "iso",
    "norm",
    "now",
    "public_company",
    "retry_at",
    "retry_due_for_reuse",
    "role_ok",
    "source_urls",
    "split_name",
    "valid_url",
]


class Args(argparse.Namespace):
    force: bool = False
    selftest: bool = False
    max_accounts: int = 12


ROOT = Path("/srv/rbw-agents-oss")

OPS = Path("/home/craft/.craft-agent/workspaces/my-workspace-2/campaigns/ops")

REG = OPS / "robinswood-flow-account-registry.json"

INBOX = OPS / "robinswood-flow-contact-evidence-inbox.json"

OUT = OPS / "robinswood-flow-contact-evidence-discovery-last.json"

STATE = OPS / "robinswood-flow-contact-evidence-discovery-state.json"

LEDGER = OPS / "robinswood-flow-contact-evidence-discovery-attempts.jsonl"

ESC = OPS / "robinswood-flow-contact-evidence-escalation-queue.json"

QP = ROOT / "config/oss-hunter-quota-policy.json"


def load(path: Path, default: Row) -> Row:
    try:
        return dict(OBJECT.validate_json(path.read_bytes(), strict=True))
    except FileNotFoundError:
        return default.copy()


def save(path: Path, data: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name("." + path.name + ".tmp")
    _ = temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
    os.replace(temporary, path)


def log(data: object) -> None:
    LEDGER.parent.mkdir(parents=True, exist_ok=True)
    with LEDGER.open("a") as stream:
        _ = stream.write(json.dumps(data, ensure_ascii=False) + "\n")


def quota() -> Quota:
    policy = load(QP, {})
    campaign = object_row(
        object_row(policy.get("campaigns") or {}).get("robinswood-flow") or {}
    )
    result: Quota = {
        "minHeadroom": int(str(policy.get("minRequestsHeadroom", 60))),
        "searches": min(
            12,
            int(str(campaign.get("searchBudgetPerRun", 12))),
            int(str(policy.get("globalSearchBudgetPerRun", 32))),
        ),
        "verifications": min(
            12,
            int(str(campaign.get("verificationBudgetPerRun", 12))),
            int(str(policy.get("globalVerificationBudgetPerRun", 24))),
        ),
        "policyPath": str(QP),
    }
    if min(result["minHeadroom"], result["searches"], result["verifications"]) < 0:
        raise ValueError("invalid_negative_contact_budget")
    return result


def attempt(state: Row, account: Row, result: Row, persist: bool = True) -> Row:
    accounts = object_row(state.get("accounts") or {})
    key = str(account["key"])
    old = object_row(accounts.get(key) or {})
    failure = None if result.get("passed") else failclass(result)
    failures = (
        int(str(old.get("sameClassFailures") or 0)) + 1
        if failure and failure == old.get("failureClass")
        else 1
        if failure
        else 0
    )
    timestamp = iso(retry_at(failure, failures)) if failure else None
    record: Row = {
        "accountKey": key,
        "attemptedAt": iso(),
        "status": result["status"],
        "passed": bool(result.get("passed")),
        "failureClass": failure,
        "sameClassFailures": failures,
        "nextRetryAt": timestamp,
        "gaps": result.get("gaps") or [],
        "sourceUrls": result.get("sourceUrls") or [],
        "confidence": result.get("confidence"),
        "externalOutbound": False,
    }
    accounts[key] = record
    state["accounts"] = accounts
    if persist:
        log(record)
    return record


def gate() -> Row:
    process = subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts/robinswood_flow_contact_enrichment.py"),
            "--validate-only",
        ],
        capture_output=True,
        text=True,
        timeout=180,
        check=False,
    )
    report = load(OPS / "robinswood-flow-contact-enrichment-last.json", {})
    return {
        "invoked": True,
        "returnCode": process.returncode,
        "ok": process.returncode == 0 and report.get("ok") is True,
        "status": report.get("status"),
        "counts": report.get("counts"),
    }


def selftest() -> Row:
    st: Row = {"accounts": {}}
    a: Row = {"key": "x"}
    r: Row = {
        "status": "needs_evidence",
        "passed": False,
        "gaps": ["professional_profile_url"],
        "sourceUrls": [],
        "confidence": 0.2,
    }
    x = attempt(st, a, r, False)
    y = attempt(st, a, r, False)
    q = quota()
    return {
        "ok": x["sameClassFailures"] == 1
        and y["sameClassFailures"] == 2
        and bool(y["nextRetryAt"])
        and (q["searches"] <= 12)
        and (q["verifications"] <= 12)
        and (
            retry_due_for_reuse(
                {
                    "accounts": {
                        "z": {"passed": False, "nextRetryAt": "2000-01-01T00:00:00Z"}
                    }
                },
                "z",
            )
            is True
        ),
        "accountScoped": True,
        "twoFailureBackoff": True,
        "outbound": False,
        "crmMutation": False,
        "dueRetryBypassesDailyCache": True,
    }


def _main_unlocked(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    _ = ap.add_argument("--force", action="store_true")
    _ = ap.add_argument("--selftest", action="store_true")
    _ = ap.add_argument("--max-accounts", type=int, default=12)
    args = ap.parse_args(argv, namespace=Args())
    if args.max_accounts < 0:
        ap.error("--max-accounts must be nonnegative")
    if args.selftest:
        r = selftest()
        print(json.dumps(r))
        return 0 if r["ok"] else 1
    state = load(
        STATE,
        {
            "schemaVersion": "robinswood-flow-contact-evidence-discovery-state-v2",
            "accounts": {},
        },
    )
    today = now().date().isoformat()
    accounts = [
        a
        for a in object_rows(load(REG, {}).get("accounts") or [])
        if a.get("key") != "yousign-youtrust"
    ][: args.max_accounts]
    due_retry_keys = [
        str(a["key"]) for a in accounts if retry_due_for_reuse(state, str(a["key"]))
    ]
    if (
        not args.force
        and state.get("lastCompletedDate") == today
        and OUT.exists()
        and (not due_retry_keys)
    ):
        r = load(OUT, {})
        r["reusedFreshDailyEvidence"] = True
        r["reusedAt"] = iso()
        r["dueRetryKeys"] = []
        r["evidenceGate"] = gate()
        r["ok"] = (
            object_row(r["evidenceGate"]).get("ok") is True
            and object_row(r.get("hunterCapacity") or {}).get("allowed") is True
        )
        r["status"] = (
            "fresh_daily_evidence_reused" if r["ok"] else "evidence_gate_failed"
        )
        save(OUT, r)
        print(
            json.dumps(
                {
                    "ok": r.get("ok"),
                    "status": "fresh_daily_evidence_reused",
                    "counts": r.get("counts"),
                    "externalOutbound": False,
                }
            )
        )
        return 0 if r["ok"] else 1
    q = quota()
    key = load_key()
    cap: Row = (
        capacity(key, q)
        if key
        else {"ok": False, "allowed": False, "reason": "hunter_key_missing"}
    )
    rows: list[Row] = []
    verified: list[Row] = []
    escalations: list[Row] = []
    searches = verifications = 0
    for a in accounts:
        if not due(state, str(a["key"])):
            x = object_row(object_row(state["accounts"])[str(a["key"])])
            rows.append(
                {
                    "accountKey": str(a["key"]),
                    "accountName": a["name"],
                    "status": "scheduled_retry_backoff",
                    "passed": False,
                    **{
                        k: x.get(k)
                        for k in (
                            "failureClass",
                            "sameClassFailures",
                            "nextRetryAt",
                            "gaps",
                            "sourceUrls",
                        )
                    },
                    "externalOutbound": False,
                }
            )
            continue
        if searches >= q["searches"] or verifications >= q["verifications"]:
            r = {
                "accountKey": str(a["key"]),
                "accountName": a["name"],
                "status": "scheduled_retry_quota_cap",
                "passed": False,
                "gaps": ["flow_hunter_run_budget_exhausted"],
                "sourceUrls": [],
                "confidence": 0,
                "externalOutbound": False,
            }
        else:
            r = discover(a, key, cap)
            searches += 1
            verifications += int(bool(r.get("professionalEmail")))
        x = attempt(state, a, r)
        r["attemptState"] = x
        rows.append(r)
        if r.get("passed"):
            verified.append(object_row(r["evidence"]))
        else:
            escalations.append(
                {
                    "id": "flow-evidence:" + str(a["key"]),
                    "accountKey": str(a["key"]),
                    "type": "automatic_source_retry",
                    "status": "scheduled_retry_backoff"
                    if int(str(x["sameClassFailures"])) >= 2
                    else "automatic_retry_scheduled",
                    "reason": x["failureClass"],
                    "sameClassFailures": x["sameClassFailures"],
                    "nextRetryAt": x["nextRetryAt"],
                    "gaps": x["gaps"],
                    "humanOnlyInputRequired": False,
                }
            )
        time.sleep(0.2)
    inbox = load(INBOX, {"items": []})
    manual = [
        x
        for x in object_rows(inbox.get("items") or [])
        if not str(x.get("source") or "").startswith(
            "robinswood_flow_contact_evidence_discovery_"
        )
    ]
    by = {str(x["accountKey"]): x for x in manual + verified if x.get("accountKey")}
    save(
        INBOX,
        {
            "generatedAt": iso(),
            "schemaVersion": "robinswood-flow-contact-evidence-inbox-v2",
            "producer": "robinswood-flow-contact-evidence-discovery",
            "items": list(by.values()),
        },
    )
    counts = {
        "accounts": len(accounts),
        "sourceAttempts": searches,
        "evidencePassed": len(verified),
        "needsEvidence": len(accounts) - len(verified),
        "hunterSearches": searches,
        "hunterVerifications": verifications,
        "externalSends": 0,
        "crmMutations": 0,
        "opportunitiesCreated": 0,
    }
    validation = gate()
    dependency_ready = bool(key) and cap.get("allowed") is True
    result_status = (
        "processed_account_scoped_prepare_only"
        if validation.get("ok") is True
        else "evidence_gate_failed"
    )
    report: Row = {
        "generatedAt": iso(),
        "contractVersion": "robinswood-flow-contact-evidence-discovery-v2",
        "capabilityId": "robinswood-flow-contact-evidence-discovery",
        "ok": dependency_ready and validation.get("ok") is True,
        "status": result_status if dependency_ready else "dependency_blocked",
        "counts": counts,
        "quotaPolicy": q,
        "hunterCapacity": cap,
        "dueRetryKeysAtStart": due_retry_keys,
        "accounts": rows,
        "evidenceGate": validation,
        "guardrails": [
            "exact-person only",
            "no domain-search substitution",
            "no guessed email",
            "no generic inbox",
            "no LinkedIn scraping",
            "two same-class failures then backoff",
            "no CRM mutation",
            "no outbound",
            "due retries bypass same-day fresh cache",
        ],
        "artifacts": {
            "report": str(OUT),
            "inbox": str(INBOX),
            "state": str(STATE),
            "attemptLedger": str(LEDGER),
            "escalationQueue": str(ESC),
        },
    }
    save(OUT, report)
    save(
        ESC,
        {
            "generatedAt": iso(),
            "schemaVersion": "robinswood-flow-contact-evidence-escalation-v2",
            "items": escalations,
        },
    )
    state["lastCompletedDate"] = today
    state["lastRunAt"] = iso()
    save(STATE, state)
    print(
        json.dumps(
            {
                "ok": report["ok"],
                "status": report["status"],
                "counts": counts,
                "evidenceGate": report["evidenceGate"],
                "externalOutbound": False,
            }
        )
    )
    return 0 if report["ok"] else 1


def main(argv: list[str] | None = None) -> int:
    with chain_lock() as acquired:
        if not acquired:
            print(
                json.dumps(
                    {
                        "ok": True,
                        "status": "skipped_concurrent_lock",
                        "externalOutbound": False,
                    }
                )
            )
            return 0
        return _main_unlocked(argv)


if __name__ == "__main__":
    raise SystemExit(main())
