"""Historical Flow containment checks, not a generic business-completion gate."""

from __future__ import annotations

from datetime import datetime
from pathlib import Path

import robinswood_flow_core as core
from flow_contact_evidence_state import object_row
from flow_duplicate_targets import duplicate_ids
from flow_structural_checks import (
    Report,
    canonical_contacts_valid,
    check,
    child,
    clean_ids,
    dated,
    items,
    number,
    read,
    string,
)
from flow_v2_rules import TZ, dt, is_due
from outbound_content_guard import mentions_attachment


def accounts(_root: Path) -> list[Report]:
    registry = items(read(core.REG), "accounts")
    state = read(core.CRMSTATE)
    primary = core.account_key()
    return [
        check("generic_thirteen_accounts", len(registry) == 13, len(registry)),
        check(
            "only_primary_approved_now",
            [
                row.get("key")
                for row in registry
                if row.get("approvedForSequence") is True
            ]
            == [primary],
        ),
        check(
            "other_twelve_no_outbound",
            all(
                row.get("externalFirstContactAllowed") is False
                for row in registry
                if row.get("key") != primary
            ),
        ),
        check("zero_opportunities_live", state.get("opportunitiesCreated") == 0),
    ]


def task_due(_root: Path) -> list[Report]:
    report = read(core.OPS / "robinswood-flow-task-due-manager-last.json")
    tasks = items(report, "tasks")
    now = datetime.now(TZ)
    dates = [dt(row.get("readbackDue")) for row in tasks]
    future = sum(value is not None and value > now for value in dates)
    return [
        check(
            "thirteen_task_due_readbacks",
            len(tasks) == future == 13,
            {"count": len(tasks), "future": future},
        ),
        check(
            "due_manager_idempotency_shape",
            len(
                {
                    (number(row.get("taskId")), string(row.get("desiredDue")))
                    for row in tasks
                }
            )
            == 13,
        ),
    ]


def queues(_root: Path) -> list[Report]:
    email = items(read(core.EMAILQ))
    linkedin = items(read(core.LIQ))
    primary = core.account_key()
    due = [
        row
        for row in email + linkedin
        if row.get("status") == "scheduled_conditional" and is_due(object_row(row))
    ]
    empty: Report = {}
    d5 = next((row for row in email if row.get("type") == "email_d5"), empty)
    d14 = next((row for row in email if row.get("type") == "email_d14"), empty)
    incident = read(core.OPS / "robinswood-flow-yousign-d5-attachment-incident.json")
    evidence = child(incident, "gmailEvidence")
    return [
        check(
            "outbound_queues_primary_only",
            bool(email)
            and all(row.get("accountKey") == primary for row in email + linkedin),
        ),
        check("no_due_dispatch_now", not due, [row.get("action_id") for row in due]),
        check(
            "primary_d5_historical_incident_preserved",
            incident.get("status") == "contained_no_resend"
            and evidence.get("attachmentCount") == 0
            and evidence.get("bodyClaimedAttachment") is True
            and child(incident, "containment").get("resendAllowed") is False,
            incident,
        ),
        check(
            "primary_d5_queue_not_rearmed",
            string(d5.get("status")).startswith("sent")
            and d5.get("preAuditAttachAllowed") is not True
            and not mentions_attachment(string(d5.get("body"))),
            {"status": d5.get("status"), "attach": d5.get("preAuditAttachAllowed")},
        ),
        check(
            "primary_d14_no_attachment",
            d14.get("attachmentsAllowed") is False
            and not mentions_attachment(string(d14.get("body"))),
        ),
    ]


def preaudits(_root: Path) -> list[Report]:
    report = read(core.OPS / "robinswood-flow-pre-audit-finalization-last.json")
    docs = items(report, "documents")
    counts = child(report, "counts")
    return [
        check(
            "four_preaudits_passed",
            counts.get("documents") == counts.get("passed") == 4
            and counts.get("failed") == 0,
            counts,
        ),
        check(
            "all_preaudits_score_90_and_browser_green",
            len(docs) == 4
            and all(
                number(row.get("qualityScore")) >= 90
                and child(row, "browserVisualControl").get("ok") is True
                and child(row, "control").get("pageCount") == 1
                for row in docs
            ),
        ),
        check(
            "one_external_hash_bound_canary",
            counts.get("externalEligible") == counts.get("visualCanaryPassed") == 1
            and sum(
                child(row, "visualCanary").get("required") is True
                and child(row, "visualCanary").get("valid") is True
                and bool(child(row, "visualCanary").get("sourceHtmlHash"))
                and child(row, "visualCanary").get("sourceHtmlHash")
                == child(row, "visualCanary").get("canaryHash")
                for row in docs
            )
            == 1,
            counts,
        ),
        check(
            "preaudit_no_internal_jargon",
            len(docs) == 4
            and all(child(row, "control").get("forbiddenTerms") == [] for row in docs),
        ),
    ]


def approvals(_root: Path) -> list[Report]:
    report = read(core.OPS / "robinswood-flow-contact-enrichment-approval-pack.json")
    entries = items(report)
    return [
        check(
            "approval_pack_twelve_fail_closed",
            len(entries) == 12
            and all(
                row.get("approvedForSequence") is False
                and row.get("externalOutboundAllowed") is False
                and row.get("opportunityAllowed") is False
                for row in entries
            ),
            {"items": len(entries), "counts": report.get("counts")},
        ),
        check(
            "paid_wall_and_poc_preserved",
            report.get("paidWallEur") == 5000 and report.get("minimumPocEur") == 30000,
        ),
    ]


def relation_matches(row: Report) -> bool:
    relation_rows = child(row, "checks").get("taskRelationsAfter")
    if not isinstance(relation_rows, list) or len(relation_rows) != 1:
        return False
    contact = row.get("contactId")
    company = row.get("companyId")
    identifier = contact if contact is not None else company
    if (
        not isinstance(identifier, int)
        or isinstance(identifier, bool)
        or identifier <= 0
    ):
        return False
    return relation_rows[0] == [
        "contact" if contact is not None else "company",
        identifier,
    ]


def crm_integrity(_root: Path) -> list[Report]:
    state = read(core.CRMSTATE)
    registry = items(read(core.REG), "accounts")
    report = read(core.OPS / "robinswood-flow-sellsy-integrity-last.json")
    second = child(report, "secondReplay")
    counts = child(second, "counts")
    records = items(second, "rows")
    contacts = [row for row in records if row.get("contactId") is not None]
    excluded = duplicate_ids()
    return [
        check(
            "canonical_contact_bindings_exact",
            canonical_contacts_valid(state.get("contacts"), registry),
            state.get("contacts"),
        ),
        check(
            "sellsy_double_replay_idempotent",
            report.get("ok") is True
            and report.get("status") == "applied_read_back_double_replay_idempotent"
            and second.get("mutations") == 0
            and child(report, "stateHashes").get("secondReplayStable") is True,
            {
                "status": report.get("status"),
                "secondMutations": second.get("mutations"),
            },
        ),
        check(
            "sellsy_company_contact_roles_canonical",
            counts.get("contactsVerified") == len(contacts) == 4
            and all(
                all(
                    child(child(row, "checks"), "companyContactRolesAfter").get(field)
                    == row.get("contactId")
                    for field in (
                        "main_contact_id",
                        "invoicing_contact_id",
                        "dunning_contact_id",
                    )
                )
                for row in contacts
            ),
        ),
        check(
            "sellsy_tasks_follow_taskupdateitem_single_relation",
            counts.get("tasksVerified") == len(records) == 13
            and counts.get("taskContactRelations") == 4
            and all(relation_matches(row) for row in records),
        ),
        check(
            "sellsy_no_delete_or_archive",
            counts.get("hardDeletes") == counts.get("archives") == 0,
        ),
        check(
            "duplicates_absent_from_state_registry_queues",
            clean_ids(state, excluded)
            and clean_ids([row for row in registry], excluded)
            and clean_ids(read(core.EMAILQ), excluded)
            and clean_ids(read(core.LIQ), excluded),
        ),
    ]


def retry_dates(_root: Path) -> list[Report]:
    queue = items(
        read(core.OPS / "robinswood-flow-contact-evidence-escalation-queue.json")
    )
    return [
        check(
            "all_retry_items_have_dates",
            all(dated(row.get("nextRetryAt")) for row in queue),
            {"items": len(queue)},
        )
    ]
