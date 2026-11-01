"""Prepare reversible duplicate annotations; apply only with explicit --apply.

Recovered from the operational script. Private identifiers come from the existing
flow profile. Every safety scan and canonical readback precedes CRM changes.
"""

from __future__ import annotations

import argparse
import fcntl
import json
from dataclasses import dataclass
from typing import Literal

import robinswood_flow_core as c
from flow_contact_evidence_state import OBJECT, Row, object_row
from flow_duplicate_crm import MARK, append_marker, has_exact_id, ident, list_endpoint
from flow_duplicate_targets import DuplicateTargets, fingerprint, targets
from requests import RequestException

OUT = c.OPS / "robinswood-flow-duplicate-reconciliation-latest.json"
LOCK = c.OPS / ".robinswood-flow-sellsy-sync.lock"
SAFETY_ENDPOINTS = (
    "/invoices",
    "/estimates",
    "/opportunities",
    "/payments",
    "/contacts",
    "/tasks",
)


@dataclass(frozen=True)
class Annotation:
    kind: Literal["company", "contact"]
    key: str
    duplicate_id: int
    canonical_id: int
    original: Row
    canonical: Row

    @property
    def endpoint(self) -> str:
        collection = "companies" if self.kind == "company" else "contacts"
        return f"/{collection}/{self.duplicate_id}"

    @property
    def name_field(self) -> str:
        return "name" if self.kind == "company" else "last_name"

    @property
    def marked_prefix(self) -> str:
        return f"[TECH DUPLICATE → {self.canonical_id}]"

    def verified(self, row: Row) -> bool:
        return (
            ident(row) == self.duplicate_id
            and str(row.get(self.name_field) or "").startswith(self.marked_prefix)
            and MARK in str(row.get("note") or "")
            and f"Canonical {self.kind} ID: {self.canonical_id}"
            in str(row.get("note") or "")
        )

    def payload(self) -> Row:
        name = str(self.original.get(self.name_field) or "")
        marked = (
            name
            if name.startswith(self.marked_prefix)
            else f"{self.marked_prefix} {name}"
        )
        body = "\n".join(
            [
                "Robinswood Flow concurrency incident; preserved, never hard-deleted.",
                f"Duplicate {self.kind} ID: {self.duplicate_id}",
                f"Canonical {self.kind} ID: {self.canonical_id}",
                f"Canonical account key: {self.key}",
                "Excluded from Flow registries and queues. Do not use for new activity.",
                "Archive was not attempted: no verified documented archive path.",
            ]
        )
        return {
            self.name_field: marked,
            "note": append_marker(str(self.original.get("note") or ""), body),
        }


def load_annotations(config: DuplicateTargets) -> list[Annotation]:
    plans: list[Annotation] = []
    for key, (duplicate, canonical) in config.companies.items():
        plans.append(
            Annotation(
                "company",
                key,
                duplicate,
                canonical,
                object_row(c.crmreq(f"/companies/{duplicate}")),
                object_row(c.crmreq(f"/companies/{canonical}")),
            )
        )
    for duplicate, (key, canonical) in config.contacts.items():
        plans.append(
            Annotation(
                "contact",
                key,
                duplicate,
                canonical,
                object_row(c.crmreq(f"/contacts/{duplicate}")),
                object_row(c.crmreq(f"/contacts/{canonical}")),
            )
        )
    return plans


def local_exclusion(config: DuplicateTargets, state: Row) -> Row:
    # Compare JSON identifiers, never decimal substrings inside unrelated values.
    registry = OBJECT.validate_json(c.REG.read_text(encoding="utf-8"))
    queues: Row = {
        "email": OBJECT.validate_json(c.EMAILQ.read_text(encoding="utf-8")),
        "linkedin": OBJECT.validate_json(c.LIQ.read_text(encoding="utf-8")),
        "approval": OBJECT.validate_json(c.APPROVAL.read_text(encoding="utf-8")),
    }
    return {
        "duplicatesAbsentFromCanonicalState": not any(
            has_exact_id(OBJECT.validate_python(state, strict=True), target)
            for target in config.excluded_ids
        ),
        "duplicatesAbsentFromRegistry": not any(
            has_exact_id(registry, target) for target in config.excluded_ids
        ),
        "duplicatesAbsentFromQueues": not any(
            has_exact_id(OBJECT.validate_python(queues, strict=True), target)
            for target in config.excluded_ids
        ),
    }


def preflight(
    config: DuplicateTargets, plans: list[Annotation], state: Row
) -> tuple[list[str], list[Row]]:
    errors: list[str] = []
    companies = object_row(state.get("companies") or {})
    contacts = object_row(state.get("contacts") or {})
    tasks = object_row(state.get("tasks") or {})
    if set(companies) != set(config.companies) or any(
        ident({"id": companies.get(key)}) != pair[1]
        for key, pair in config.companies.items()
    ):
        errors.append("canonical_company_mismatch")
    if any(
        ident({"id": contacts.get(key)}) != canonical
        for key, canonical in config.contacts.values()
    ):
        errors.append("canonical_contact_mismatch")
    if len(tasks) != len(config.companies):
        errors.append("canonical_task_count_mismatch")
    if any(
        ident(plan.original) != plan.duplicate_id
        or ident(plan.canonical) != plan.canonical_id
        for plan in plans
    ):
        errors.append("object_readback_identifier_mismatch")
    if any(not str(plan.original.get(plan.name_field) or "").strip() for plan in plans):
        errors.append("duplicate_name_missing")
    task_readbacks: list[Row] = []
    for key, value in tasks.items():
        task_id = ident({"id": value})
        if task_id is None:
            errors.append("canonical_task_identifier_invalid")
            continue
        task = c.crmreq(f"/tasks/{task_id}")
        task_readbacks.append(
            {
                "marker": key,
                "taskId": task_id,
                "taskReadbackId": ident(task),
                "due_date": task.get("due_date"),
            }
        )
        if ident(task) != task_id or not task.get("due_date"):
            errors.append("canonical_task_readback_invalid")
    return errors, task_readbacks


def apply_annotation(plan: Annotation, apply: bool) -> Row:
    action: Row = {
        "key": plan.key,
        "kind": plan.kind,
        "duplicateId": plan.duplicate_id,
        "canonicalId": plan.canonical_id,
        "archiveAttempted": False,
        "hardDeleteAttempted": False,
        "mutations": 0,
        "verified": False,
    }
    if plan.verified(plan.original):
        action.update({"action": "already_annotated", "verified": True})
        return action
    if not apply:
        action["action"] = "annotation_planned"
        action["payload"] = plan.payload()
        return action
    try:
        # Count attempted changes even when transport or verification fails.
        action["mutations"] = 1
        _ = c.crmreq(
            plan.endpoint, "PUT", OBJECT.validate_python(plan.payload(), strict=True)
        )
        verified = c.crmreq(plan.endpoint)
        action.update(
            {
                "action": "renamed_and_annotated",
                "verified": plan.verified(object_row(verified)),
            }
        )
        if not action["verified"]:
            action["error"] = "marker_or_identifier_missing_after_update"
    except (RequestException, OSError, ValueError, RuntimeError) as exc:
        action.update({"action": "annotation_error", "error": type(exc).__name__})
    return action


def reconcile(*, apply: bool = False) -> Row:
    config = (
        targets()
    )  # Missing private profile fails before any read/write side effect.
    for path in (c.CRMSTATE, c.REG, c.EMAILQ, c.LIQ, c.APPROVAL):
        if not path.is_file():
            raise ValueError("required_active_data_missing")
    state = object_row(OBJECT.validate_json(c.CRMSTATE.read_text(encoding="utf-8")))
    plans = load_annotations(config)
    errors, task_readbacks = preflight(config, plans, state)
    scans: Row = {}
    opportunity_links: list[int] = []
    all_company_ids = {
        identifier for pair in config.companies.values() for identifier in pair
    }
    for endpoint in SAFETY_ENDPOINTS:
        rows, meta = list_endpoint(endpoint)
        scans[endpoint] = meta
        if meta.get("complete") is not True:
            errors.append(f"incomplete_safety_scan:{endpoint}")
        if endpoint == "/opportunities":
            opportunity_links = [
                identifier
                for row in rows
                if any(
                    has_exact_id(OBJECT.validate_python(row, strict=True), target)
                    for target in all_company_ids
                )
                if (identifier := ident(row)) is not None
            ]
    if opportunity_links:
        errors.append("live_flow_opportunity_links")
    exclusion = local_exclusion(config, state)
    if not all(value is True for value in exclusion.values()):
        errors.append("duplicate_still_in_active_local_data")
    actions: list[Row] = []
    if not errors:
        for plan in plans:
            action = apply_annotation(plan, apply)
            actions.append(action)
            if action.get("error"):
                errors.append(f"{plan.kind}_annotation_failed:{plan.duplicate_id}")
                break  # Do not continue mutating after a failed readback.
    companies = [action for action in actions if action.get("kind") == "company"]
    contacts = [action for action in actions if action.get("kind") == "contact"]
    verified = len(actions) == len(plans) and all(
        action.get("verified") is True for action in actions
    )
    ok = not errors and (verified if apply else True)
    status = (
        "reconciled_annotated_no_hard_delete"
        if apply and ok
        else "prepared_no_mutations"
        if ok
        else "reconciliation_incomplete"
    )
    canonical_readbacks: list[Row] = [
        {
            "key": plan.key,
            "companyId": plan.canonical_id,
            "companyReadbackId": ident(plan.canonical),
        }
        for plan in plans
        if plan.kind == "company"
    ]
    canonical_contacts: list[Row] = [
        {
            "contactId": plan.canonical_id,
            "contactReadbackId": ident(plan.canonical),
            "email": plan.canonical.get("email"),
        }
        for plan in plans
        if plan.kind == "contact"
    ]
    return {
        "generatedAt": c.now(),
        "contractVersion": "robinswood-flow-duplicate-reconciliation-v1",
        "capabilityId": "robinswood-flow-duplicate-reconciliation",
        "targetFingerprint": fingerprint(config),
        "ok": ok,
        "status": status,
        "applied": apply,
        "preflightErrors": errors,
        "counts": {
            "duplicateCompanies": len(config.companies),
            "duplicateContacts": len(config.contacts),
            "duplicateCompaniesVerifiedAnnotated": sum(
                action.get("verified") is True for action in companies
            ),
            "duplicateContactsVerifiedAnnotated": sum(
                action.get("verified") is True for action in contacts
            ),
            "canonicalCompanyReadbacks": len(canonical_readbacks),
            "canonicalContactReadbacks": len(canonical_contacts),
            "canonicalTaskReadbacks": len(task_readbacks),
            "tasksWithDueDate": sum(
                bool(task.get("due_date")) for task in task_readbacks
            ),
            "flowLinkedOpportunities": len(opportunity_links),
            "crmMutations": sum(action.get("mutations") == 1 for action in actions),
            "hardDeletes": 0,
            "archives": 0,
            "externalSends": 0,
            "errors": len(errors),
        },
        "safetyEndpoints": scans,
        "companyActions": companies,
        "contactActions": contacts,
        "contactAction": contacts[0] if len(contacts) == 1 else {},
        "canonicalReadbacks": canonical_readbacks,
        "canonicalContacts": canonical_contacts,
        "canonicalContact": canonical_contacts[0]
        if len(canonical_contacts) == 1
        else {},
        "taskReadbacks": task_readbacks,
        "liveFlowOpportunityIds": sorted(set(opportunity_links)),
        "localExclusion": exclusion,
        "errors": errors,
        "hardDeletePolicy": "forbidden",
        "archiveDecision": "not attempted: no verified documented archive path",
        "externalSends": 0,
        "artifacts": {
            "reportJson": str(OUT),
            "canonicalState": str(c.CRMSTATE),
            "registry": str(c.REG),
        },
    }


def main(*, apply: bool = False) -> int:
    _ = targets()  # Refuse absent configuration before even creating the lock/report.
    LOCK.parent.mkdir(parents=True, exist_ok=True)
    with LOCK.open("a+") as handle:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print(
                json.dumps(
                    {
                        "ok": False,
                        "status": "blocked_concurrent_sync_lock",
                        "externalSends": 0,
                    }
                )
            )
            return 2
        try:
            report = reconcile(apply=apply)
            OUT.parent.mkdir(parents=True, exist_ok=True)
            _ = OUT.write_text(
                json.dumps(report, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
            print(
                json.dumps(
                    {
                        "ok": report["ok"],
                        "status": report["status"],
                        "counts": report["counts"],
                        "report": str(OUT),
                    }
                )
            )
            return 0 if report["ok"] else 1
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


class Arguments(argparse.Namespace):
    apply: bool = False


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    _ = parser.add_argument(
        "--apply",
        action="store_true",
        help="Apply reversible annotations after all safety checks",
    )
    arguments = parser.parse_args(namespace=Arguments())
    raise SystemExit(main(apply=arguments.apply is True))
