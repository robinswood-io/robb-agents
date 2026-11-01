"""Flow v2 command entry points, using explicit preparation/application modes."""

from __future__ import annotations

import argparse
from collections.abc import Callable

import robinswood_flow_core as c
from flow_contact_evidence_state import Row, object_row, object_rows
from flow_v2_delivery import email_sequencer, stopped
from flow_v2_linkedin import linkedin_queue
from flow_v2_materializer import DECISIONS, STATEQ, materialize, message_templates
from flow_v2_reply_crm import (
    OPP_STATE,
    REPLY_CRM,
    crm_action_for_signal,
    crm_action_plan,
)
from flow_v2_reply_router import (
    change_future,
    detect_referral_identity,
    human_item,
    reply_router,
)
from flow_v2_rules import (
    TZ,
    approval_for,
    classify,
    dt,
    extract_return_date,
    future_slot,
    is_due,
    next_business,
    task_due,
)
from flow_v2_task_due import DUE_REPORT, task_due_manager
from robinswood_flow_contact_enrichment import main as enrichment_main
from robinswood_flow_contact_evidence_discovery import main as evidence_discovery_main
from robinswood_flow_core_sellsy import sync_unlocked
from robinswood_flow_lock import chain_lock

__all__ = [
    "DECISIONS",
    "DUE_REPORT",
    "OPP_STATE",
    "REPLY_CRM",
    "STATEQ",
    "TZ",
    "approval_for",
    "attribution",
    "change_future",
    "classify",
    "crm_action_for_signal",
    "crm_action_plan",
    "dashboard",
    "detect_referral_identity",
    "dt",
    "email_sequencer",
    "extract_return_date",
    "future_slot",
    "guard_tests",
    "human_item",
    "is_due",
    "linkedin_queue",
    "main",
    "materialize",
    "message_templates",
    "next_business",
    "reply_router",
    "sellsy_sync",
    "stopped",
    "task_due",
    "task_due_manager",
]


def sellsy_sync(*, apply: bool = False) -> int:
    if not apply:
        return c.report(
            "sellsy-sync",
            {
                "stages": [
                    "evidence_discovery",
                    "contact_gate",
                    "crm_sync",
                    "task_due_readback",
                ],
                "externalSends": 0,
                "crmMutations": 0,
            },
            True,
            "prepared_no_mutations",
        )
    _ = (
        c.accounts()
    )  # Validate the private deployment profile before entering operational stages.
    with chain_lock() as acquired:
        if not acquired:
            return c.report(
                "sellsy-sync",
                {"blockingReasons": ["concurrent_chain_lock"], "externalSends": 0},
                False,
                "blocked_concurrent_lock",
            )
        if evidence_discovery_main([]) != 0:
            return c.report(
                "sellsy-sync",
                {
                    "blockingReasons": ["contact_evidence_discovery_failed"],
                    "externalSends": 0,
                },
                False,
                "blocked_fail_closed",
            )
        if enrichment_main(["--apply"]) != 0:
            return c.report(
                "sellsy-sync",
                {"blockingReasons": ["contact_enrichment_failed"], "externalSends": 0},
                False,
                "blocked_fail_closed",
            )
        base_rc = sync_unlocked()
        if base_rc != 0:
            return base_rc
        first = task_due_manager(True)
        replay = task_due_manager(True)
        path = c.OPS / "robinswood-flow-sellsy-sync-last.json"
        report = object_row(c.load(path, {}))
        ok = (
            report.get("ok") is True
            and first.get("ok") is True
            and replay.get("ok") is True
            and object_row(replay.get("counts") or {}).get("updated") == 0
        )
        report.update(
            {
                "contractVersion": "robinswood-flow-sellsy-sync-v2",
                "duplicateExclusion": "active",
                "unifiedChainLock": "discovery_to_gate_to_crm_sync",
                "taskDueManager": first,
                "taskDueIdempotencyReadback": replay,
                "ok": ok,
                "status": "applied_read_back_future_due_idempotent"
                if ok
                else "partial",
            }
        )
        c.save(path, report)
        return 0 if ok else 1


def attribution() -> int:
    return c.attribution()


def dashboard() -> int:
    registry = object_rows(c.load(c.REG, {}).get("accounts") or [])
    email = object_rows(c.load(c.EMAILQ, {}).get("items") or [])
    linkedin = object_rows(c.load(c.LIQ, {}).get("items") or [])
    crm = object_row(c.load(c.CRMSTATE, {}))
    enrichment = object_row(
        c.load(c.OPS / "robinswood-flow-contact-enrichment-last.json", {})
    )
    upcoming = sorted(
        (
            item
            for item in email + linkedin
            if item.get("status") == "scheduled_conditional"
        ),
        key=lambda item: str(item.get("dueAt") or ""),
    )
    unresolved = [
        item
        for item in email + linkedin
        if item.get("status")
        in {
            "held_delivery_uncertain",
            "sent_pending_verification",
            "sent_verification_failed",
        }
    ]
    payload: Row = {
        "counts": {
            "accounts": len(registry),
            "approved": sum(row.get("approvedForSequence") is True for row in registry),
            "crmCompanies": len(object_row(crm.get("companies") or {})),
            "crmContacts": len(object_row(crm.get("contacts") or {})),
            "crmTasks": len(object_row(crm.get("tasks") or {})),
            "opportunitiesCreated": crm.get("opportunitiesCreated", 0),
            "enrichmentEvidencePassed": object_row(enrichment.get("counts") or {}).get(
                "evidencePassed", 0
            ),
            "pendingConditionalTouches": len(upcoming),
            "unresolvedDeliveries": len(unresolved),
            "events": len(c.rows(c.EVENTS)),
        },
        "nextAction": upcoming[0] if upcoming else None,
        "unresolvedActions": [item.get("action_id") for item in unresolved],
        "parameterizedAccounts": True,
        "evidenceSemantics": [
            "attempted",
            "technical_observed",
            "user_result_verified",
            "business_conversion",
        ],
    }
    return c.report(
        "dashboard",
        payload,
        not unresolved,
        "delivery_review_required" if unresolved else "processed",
    )


def guard_tests() -> int:
    from robinswood_flow_structural_tests import run_tests

    return run_tests()


def main(mode: str, *, apply: bool = False) -> int:
    handlers: dict[str, Callable[[], int]] = {
        "materializer": materialize,
        "sellsy_sync": lambda: sellsy_sync(apply=apply),
        "reply_router": lambda: reply_router(apply=apply),
        "email_sequencer": lambda: email_sequencer(apply=apply),
        "linkedin_queue": lambda: linkedin_queue(apply=apply),
        "attribution": attribution,
        "dashboard": dashboard,
        "guard_tests": guard_tests,
    }
    if mode not in handlers:
        raise ValueError("unknown_flow_command")
    return handlers[mode]()


class Arguments(argparse.Namespace):
    mode: str = "dashboard"
    apply: bool = False


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    _ = parser.add_argument(
        "mode",
        choices=[
            "materializer",
            "sellsy_sync",
            "reply_router",
            "email_sequencer",
            "linkedin_queue",
            "attribution",
            "dashboard",
            "guard_tests",
        ],
    )
    _ = parser.add_argument(
        "--apply", action="store_true", help="Execute external actions after validation"
    )
    arguments = parser.parse_args(namespace=Arguments())
    raise SystemExit(main(arguments.mode, apply=arguments.apply))
