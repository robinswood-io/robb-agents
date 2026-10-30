#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os

import requests
import robinswood_flow_core as c
from flow_contact_enrichment_rules import (
    approval_item,
    budget_control,
    contact_same,
    domain,
    norm,
    source_url,
    valid_url,
    validate,
)
from flow_contact_evidence_state import OBJECT, VALUES, Row, object_row, object_rows
from robinswood_flow_lock import chain_lock
from sellsy_technical_duplicate_guard import filter_canonical, is_technical_duplicate

__all__ = [
    "approval_item",
    "budget_control",
    "contact_same",
    "domain",
    "norm",
    "source_url",
    "valid_url",
    "validate",
]
EVIDENCE = c.OPS / "robinswood-flow-contact-evidence-inbox.json"
REPORT = c.OPS / "robinswood-flow-contact-enrichment-last.json"
PACK = c.OPS / "robinswood-flow-contact-enrichment-approval-pack.json"


class Args(argparse.Namespace):
    apply: bool = False
    validate_only: bool = False


def all_contacts() -> list[Row]:
    return object_rows(
        filter_canonical(
            VALUES.validate_python(c.listall("/contacts", maxp=100), strict=True)
        )
    )


def contact_id(value: Row) -> int:
    identifier = int(str(c.deepid(OBJECT.validate_python(value, strict=True)) or 0))
    if identifier <= 0:
        raise ValueError("contact_identifier_missing")
    return identifier


def _main_unlocked(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    _ = parser.add_argument("--apply", action="store_true")
    _ = parser.add_argument("--validate-only", action="store_true")
    args = parser.parse_args(argv, namespace=Args())
    apply = not args.validate_only and (
        args.apply or os.getenv("RBW_FLOW_CONTACT_ENRICHMENT_APPLY", "0") == "1"
    )
    reg = object_row(c.load(c.REG, {}))
    inbox = object_row(
        c.load(
            EVIDENCE,
            {"schemaVersion": "robinswood-flow-contact-evidence-inbox-v1", "items": []},
        )
    )
    by = {
        str(row.get("accountKey")): row for row in object_rows(inbox.get("items") or [])
    }
    existing = (
        {str(row.get("email") or "").lower(): row for row in all_contacts()}
        if apply and by
        else {}
    )
    accounts = object_rows(reg.get("accounts") or [])
    protected_key = c.account_key()
    results: list[Row] = []
    errors: list[Row] = []
    created = updated = 0
    for account in accounts:
        if account.get("key") == protected_key:
            continue
        evidence = by.get(str(account.get("key"))) or {}
        passed, gaps = validate(account, evidence)
        row: Row = {
            "accountKey": account.get("key"),
            "accountName": account.get("name"),
            "wave": account.get("wave"),
            "expectedPerson": account.get("sponsor"),
            "expectedRole": account.get("role"),
            "companyVerified": bool(account.get("sources")),
            "professionalEmail": evidence.get("professionalEmail"),
            "profileUrl": evidence.get("profileUrl"),
            "evidencePassed": passed,
            "status": "verified_ready_for_crm_and_approval"
            if passed
            else "needs_evidence",
            "gaps": gaps,
            "sellsyCompanyId": account.get("sellsyCompanyId"),
            "sellsyContactId": account.get("sellsyContactId"),
            "crmMutation": False,
            "opportunityCreated": False,
            "externalOutbound": False,
        }
        if passed and apply:
            try:
                email = str(evidence["professionalEmail"]).lower()
                found = existing.get(email)
                if found and is_technical_duplicate(
                    OBJECT.validate_python(found, strict=True)
                ):
                    raise RuntimeError("technical_duplicate_contact_blocked")
                selected_id: int | None = None
                candidate = int(str(account.get("sellsyContactId") or 0))
                candidate_readback: Row | None = None
                if candidate and not is_technical_duplicate({"id": candidate}):
                    candidate_readback = object_row(c.crmreq(f"/contacts/{candidate}"))
                    if str(candidate_readback.get("email") or "").lower() == email:
                        selected_id = candidate
                selected_id = selected_id or (contact_id(found) if found else None)
                parts = str(evidence["personName"]).split()
                marker = "rbw-flow:contact:" + str(account["key"])
                note = (
                    "Robinswood Flow verified professional contact. marker "
                    + marker
                    + "\nProfile: "
                    + str(evidence["profileUrl"])
                    + "\nEmail evidence: "
                    + str(evidence["emailEvidenceUrl"])
                    + "\nRole evidence: "
                    + str(evidence["roleEvidenceUrl"])
                    + "\nNo outbound; activation approval remains required."
                )[:1800]
                contact_payload: Row = {
                    "first_name": parts[0],
                    "last_name": " ".join(parts[1:]) or "Prospect",
                    "email": email,
                    "position": str(evidence["verifiedRole"])[:190],
                    "note": note,
                }
                was_created = selected_id is None
                if was_created:
                    contact_payload["company_id"] = int(str(account["sellsyCompanyId"]))
                    selected_id = contact_id(
                        object_row(
                            c.crmreq(
                                "/contacts",
                                "POST",
                                OBJECT.validate_python(contact_payload),
                            )
                        )
                    )
                    created += 1
                    row["crmMutation"] = True
                else:
                    before = candidate_readback or object_row(
                        c.crmreq(f"/contacts/{selected_id}")
                    )
                    if not contact_same(
                        before,
                        email,
                        str(evidence["verifiedRole"]),
                        marker,
                        str(evidence["profileUrl"]),
                    ):
                        _ = c.crmreq(
                            f"/contacts/{selected_id}",
                            "PUT",
                            OBJECT.validate_python(contact_payload),
                        )
                        updated += 1
                        row["crmMutation"] = True
                if row["crmMutation"] and not was_created:
                    _ = c.crmreq(
                        f"/companies/{int(str(account['sellsyCompanyId']))}/contacts/{selected_id}",
                        "POST",
                        {"roles": []},
                    )
                readback = object_row(c.crmreq(f"/contacts/{selected_id}"))
                if contact_id(readback) != selected_id or not contact_same(
                    readback,
                    email,
                    str(evidence["verifiedRole"]),
                    marker,
                    str(evidence["profileUrl"]),
                ):
                    raise RuntimeError("contact_readback_failed")
                account.update(
                    {
                        "email": email,
                        "linkedin": evidence["profileUrl"],
                        "role": evidence["verifiedRole"],
                        "contactVerified": True,
                        "contactEvidence": evidence,
                        "sellsyContactId": selected_id,
                        "state": "contact_verified_prepare_only",
                    }
                )
                row.update(
                    {
                        "sellsyContactId": selected_id,
                        "crmReadback": {"contactId": selected_id, "email": email},
                    }
                )
                existing[email] = readback
            except (
                OSError,
                ValueError,
                TypeError,
                KeyError,
                RuntimeError,
                requests.RequestException,
            ) as error:
                reason = (
                    str(error)
                    if str(error)
                    in {
                        "technical_duplicate_contact_blocked",
                        "contact_identifier_missing",
                        "contact_readback_failed",
                    }
                    else type(error).__name__
                )
                errors.append({"accountKey": account.get("key"), "error": reason})
                row["status"] = "crm_apply_failed"
                row["gaps"] = ["crm_apply_failed"]
        results.append(row)
    verified_contact_ids = sorted(
        {
            str(object_row(row.get("crmReadback") or {}).get("contactId"))
            for row in results
            if object_row(row.get("crmReadback") or {}).get("contactId") is not None
        }
    )
    reg["accounts"] = accounts
    reg["generatedAt"] = c.now()
    if apply:
        c.save(c.REG, reg)
    payload: Row = {
        "generatedAt": c.now(),
        "contractVersion": "robinswood-flow-contact-enrichment-v4-sor-readback",
        "capabilityId": "robinswood-flow-contact-enrichment",
        "ok": not errors,
        "status": "validation_only_evidence_gate"
        if args.validate_only
        else "prepare_only_evidence_gated"
        if not apply
        else "evidence_gated_crm_sync",
        "apply": apply,
        "validateOnly": args.validate_only,
        "counts": {
            "accounts": len(results),
            "evidencePassed": sum(bool(x["evidencePassed"]) for x in results),
            "needsEvidence": sum(not x["evidencePassed"] for x in results),
            "contactsCreated": created,
            "contactsUpdated": updated,
            "opportunitiesCreated": 0,
            "externalSends": 0,
            "errors": len(errors),
        },
        "accounts": results,
        "errors": errors,
        "guardrails": [
            "no guessed email",
            "email domain and deliverability evidence required",
            "profile role and company evidence required",
            "technical duplicates excluded",
            "no opportunity",
            "no outbound",
            "activation remains approval-gated",
            "existing canonical contacts are no-op idempotent",
        ],
        "checks": {
            "sellsyApiReadback": not errors and bool(verified_contact_ids),
            "sellsyObjectType": "contact",
            "sellsyObjectCount": len(verified_contact_ids),
            "noOpportunity": True,
            "noExternalSend": True,
        },
        "systemsOfRecord": {
            "classification": "sellsy",
            "work": {"required": False, "objectIds": [], "verifiedByReadback": False},
            "sellsy": {
                "required": True,
                "tenant": "robinswood",
                "objectIds": verified_contact_ids,
                "verifiedByReadback": not errors and bool(verified_contact_ids),
                "verifiedAt": c.now(),
            },
            "pendingSyncItems": [],
        },
        "artifacts": {
            "report": str(REPORT),
            "approvalPack": str(PACK),
            "evidenceInbox": str(EVIDENCE),
        },
    }
    c.save(REPORT, payload)
    rb = {str(x.get("key")): x for x in accounts}
    pack_items = [
        approval_item(
            rb.get(str(x["accountKey"])) or {}, x, by.get(str(x["accountKey"])) or {}
        )
        for x in results
    ]
    c.save(
        PACK,
        {
            "generatedAt": c.now(),
            "schemaVersion": "robinswood-flow-account-approval-pack-v2",
            "approvalRequired": True,
            "automaticApprovalForbidden": True,
            "paidWallEur": 5000,
            "minimumPocEur": 30000,
            "counts": {
                "items": len(pack_items),
                "eligibleForHumanReview": sum(
                    bool(x["eligibleForHumanReview"]) for x in pack_items
                ),
                "approved": 0,
                "externalOutboundAllowed": 0,
            },
            "items": pack_items,
        },
    )
    print(
        json.dumps(
            {
                "ok": payload["ok"],
                "status": payload["status"],
                "counts": payload["counts"],
                "checks": payload["checks"],
                "systemsOfRecord": payload["systemsOfRecord"],
                "artifacts": payload["artifacts"],
            },
            ensure_ascii=False,
        )
    )
    return 0 if payload["ok"] else 1


def main(argv: list[str] | None = None) -> int:
    with chain_lock() as acquired:
        if not acquired:
            print(
                json.dumps(
                    {
                        "ok": True,
                        "status": "skipped_concurrent_lock",
                        "externalOutbound": False,
                        "crmMutation": False,
                    }
                )
            )
            return 0
        return _main_unlocked(argv)


if __name__ == "__main__":
    raise SystemExit(main())
