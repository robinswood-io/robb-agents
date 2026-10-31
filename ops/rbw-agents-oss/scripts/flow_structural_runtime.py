"""Deployed source and pure-behavior checks; no outbound operations."""

from __future__ import annotations

import ast
import py_compile
from datetime import datetime
from pathlib import Path

import contact_salutation
import robinswood_commercial_post_remediation_control as postcheck
import robinswood_flow_contact_evidence_discovery as discovery
import robinswood_flow_core as core
import robinswood_flow_duplicate_relationship_audit as audit
import robinswood_pme_hdf_recovery_cohort as recovery
import robinswood_pme_hdf_reply_unsubscribe_loop as reply
from flow_contact_evidence_state import OBJECT, Row, object_row
from flow_duplicate_targets import targets
from flow_structural_checks import Report, check, child, items, read, string
from flow_v2_reply_crm import crm_action_for_signal
from flow_v2_rules import TZ, classify, extract_return_date
from outbound_content_guard import is_delivery_challenge
from outbound_content_guard import selftest as outbound_selftest
from sellsy_technical_duplicate_guard import (
    is_technical_duplicate,
    item_references_duplicate,
)

DEPLOYED_SCRIPTS = (
    "outbound_content_guard.py",
    "contact_salutation.py",
    "robinswood_flow_v2.py",
    "robinswood_flow_contact_enrichment.py",
    "robinswood_flow_contact_evidence_discovery.py",
    "robinswood_flow_public_qualification_merge.py",
    "robinswood_flow_pre_audit.py",
    "robinswood_flow_pre_audit_finalize.py",
    "robinswood_flow_pre_audit_finalize_v4.py",
    "robinswood_flow_email_sequencer_preaudit.py",
    "robinswood_flow_sellsy_integrity.py",
    "robinswood_flow_sellsy_sync.py",
    "commercial_attribution_ledger.py",
    "robinswood_pme_hdf_pre_send_gate.py",
    "robinswood_pme_hdf_audited_mailer.py",
    "robinswood_pme_hdf_reply_unsubscribe_loop.py",
    "robinswood_pme_hdf_performance_optimizer.py",
    "robinswood_pme_hdf_recovery_cohort.py",
    "robinswood_commercial_post_remediation_control.py",
    "robinswood_flow_duplicate_relationship_audit.py",
    "source_lane_learning_governor.py",
    "report_envelope_standardizer.py",
    "system_of_record_reconciler.py",
    "oss_autonomy_quality_guard_tests.py",
    "robinswood_flow_structural_tests.py",
)


def compilation(root: Path) -> list[Report]:
    checks: list[Report] = []
    for name in DEPLOYED_SCRIPTS:
        try:
            _ = py_compile.compile(str(root / "scripts" / name), doraise=True)
            checks.append(check("compile:" + name, True))
        except (OSError, py_compile.PyCompileError) as exc:
            checks.append(check("compile:" + name, False, type(exc).__name__))
    return checks


def recovery_scans_guarded(source: str) -> bool:
    tree = ast.parse(source)
    expected = {"need_companies": "/companies", "need_contacts": "/contacts"}
    guarded: set[str] = set()
    for node in ast.walk(tree):
        if not isinstance(node, ast.If) or not isinstance(node.test, ast.Name):
            continue
        endpoint = expected.get(node.test.id)
        if endpoint is None:
            continue
        for statement in node.body:
            for call in ast.walk(statement):
                if (
                    isinstance(call, ast.Call)
                    and isinstance(call.func, ast.Name)
                    and call.func.id == "listall"
                    and call.args
                    and isinstance(call.args[0], ast.Constant)
                    and ast.unparse(call.args[0]) == repr(endpoint)
                ):
                    guarded.add(node.test.id)
    return guarded == set(expected)


def deployment(root: Path) -> list[Report]:
    scripts = root / "scripts"
    core_source = "\n".join(
        (scripts / name).read_text()
        for name in (
            "robinswood_flow_core.py",
            "robinswood_flow_core_support.py",
            "robinswood_flow_core_sellsy.py",
        )
    )
    sync = (scripts / "robinswood_flow_sellsy_sync.py").read_text()
    sequence = "".join(
        (scripts / "robinswood_flow_email_sequencer_preaudit.py").read_text().split()
    )
    return [
        check(
            "sellsy_cursor_pagination_fail_closed",
            "page={p}" not in core_source
            and "offset={quote" in core_source
            and "sellsy_cursor_pagination_incomplete" in core_source
            and "sellsy_cursor_pagination_short_read" in core_source,
        ),
        check(
            "sellsy_full_scans_recovery_only",
            recovery_scans_guarded(core_source),
        ),
        check(
            "commercial_postcheck_integrated_single_owner",
            "run_post_remediation_control" in sync
            and "robinswood-commercial-post-remediation-control-last.json" in sync
            and "newScheduleCreated" not in sync,
        ),
        check(
            "runtime_semantic_guard_before_send",
            "attachment_meta(row,body)" in sequence
            and "outbound_content_reasons" in sequence
            and "ifreasons:" in sequence
            and "sent_needs_manual_verification" in sequence,
        ),
        check(
            "gmail_post_send_readback_required",
            "post=existing_exact" in sequence
            and "actualAttachmentCount" in sequence
            and "end_user_result_verified" in sequence,
        ),
    ]


def pure_checks(_root: Path) -> list[Report]:
    hdf = OBJECT.validate_python(recovery.selftest(), strict=True)
    post = OBJECT.validate_python(postcheck.selftest(), strict=True)
    duplicates = OBJECT.validate_python(audit.selftest(), strict=True)
    guard = OBJECT.validate_python(outbound_selftest(), strict=True)
    salutation = OBJECT.validate_python(contact_salutation.selftest(), strict=True)
    challenge: Report = {
        "fromEmail": "qa@invitations.mailinblack.com",
        "subject": "Un clic pour délivrer votre email !",
        "bodyText": "Je suis protégé par Protect de Mailinblack",
    }
    body = string(challenge["bodyText"])
    result = reply.classify(challenge, body)
    fixtures = {
        "positive": "Disponible pour un rendez-vous",
        "referral": "Je vais vous mettre en relation avec notre directrice opérations",
        "out_of_office": "Réponse automatique : absent du bureau, de retour le 21 juillet 2026",
        "hard_bounce": "mailer-daemon permanent error status: 5.1.1",
        "opt_out": "Merci de me désabonner",
        "refusal": "Non merci, pas intéressé",
        "ambiguous": "Merci pour votre message",
    }
    got: Report = {
        key: classify(text, text if key == "hard_bounce" else "")
        for key, text in fixtures.items()
    }
    discovery_test = OBJECT.validate_python(discovery.selftest(), strict=True)
    return [
        check(
            "recovery_and_postcheck_selftests",
            hdf.get("ok") is True
            and post.get("ok") is True
            and duplicates.get("ok") is True,
            {"hdf": hdf, "postcheck": post, "duplicates": duplicates},
        ),
        check(
            "outbound_content_guard_matrix",
            guard.get("ok") and guard.get("attachmentMatrix"),
            guard,
        ),
        check("salutation_neutral_and_explicit_only", salutation.get("ok"), salutation),
        check(
            "mailinblack_delivery_challenge_fixture",
            is_delivery_challenge(
                string(challenge["fromEmail"]), string(challenge["subject"]), body
            )
            and result == "delivery_challenge",
            result,
        ),
        check(
            "reply_classification_fixtures",
            all(got[key] == key for key in fixtures),
            got,
        ),
        check(
            "ooo_ambiguous_requires_human",
            not extract_return_date(
                "Réponse automatique, absent quelques jours",
                datetime(2026, 7, 20, 12, 8, tzinfo=TZ),
            ).get("reliable"),
        ),
        check(
            "source_discovery_fail_closed_selftest",
            discovery_test.get("ok")
            and discovery_test.get("accountScoped")
            and discovery_test.get("twoFailureBackoff")
            and discovery_test.get("dueRetryBypassesDailyCache")
            and not discovery_test.get("outbound")
            and not discovery_test.get("crmMutation"),
            discovery_test,
        ),
    ]


def reply_safety(root: Path) -> list[Report]:
    source = "\n".join(p.read_text() for p in (root / "scripts").glob("*hdf*reply*.py"))
    compact = "".join(source.lower().split())
    return [
        check(
            "mailinblack_no_suppression_no_auto_reply_no_delete",
            (
                '"automaticchallengeresponseallowed":false' in compact
                or "'automaticchallengeresponseallowed':false" in compact
            )
            and "gmail_send" not in compact
            and "requests.delete(" not in compact
            and 'method="delete"' not in compact,
        )
    ]


def crm_plans(_root: Path) -> list[Report]:
    accounts = items(read(core.REG), "accounts")
    primary = next(row for row in accounts if row.get("key") == core.account_key())
    record: Row = {
        "messageId": "fixture-positive-1",
        "threadId": core.source_thread_id(),
    }
    first = OBJECT.validate_python(
        crm_action_for_signal(object_row(primary), record, "positive", dry_run=True)
    )
    second = OBJECT.validate_python(
        crm_action_for_signal(object_row(primary), record, "positive", dry_run=True)
    )
    ambiguous = OBJECT.validate_python(
        crm_action_for_signal(
            object_row(primary),
            {"messageId": "fixture-ambiguous", "threadId": core.source_thread_id()},
            "ambiguous",
            dry_run=True,
        )
    )
    value = targets()
    canonical = {pair[1] for pair in value.companies.values()} | {
        pair[1] for pair in value.contacts.values()
    }
    return [
        check(
            "positive_one_task_one_opportunity_fixture",
            first.get("taskCreates") == 1 and first.get("opportunityCreates") == 1,
            first,
        ),
        check(
            "positive_idempotency_markers",
            bool(first.get("taskMarker"))
            and bool(first.get("opportunityMarker"))
            and first.get("taskMarker") == second.get("taskMarker")
            and first.get("opportunityMarker") == second.get("opportunityMarker"),
        ),
        check(
            "ambiguous_no_opportunity",
            ambiguous.get("opportunityCreates") == 0,
            ambiguous,
        ),
        check(
            "known_duplicate_ids_blocked",
            bool(value.excluded_ids)
            and all(
                is_technical_duplicate({"id": identifier})
                for identifier in value.excluded_ids
            ),
        ),
        check(
            "duplicate_marker_blocked",
            item_references_duplicate(
                {"company": {"name": "[TECH DUPLICATE → 42] Example"}}
            ),
        ),
        check(
            "canonical_ids_not_blocked",
            bool(canonical)
            and all(
                not item_references_duplicate({"sellsyCompanyId": identifier})
                for identifier in canonical
            ),
        ),
    ]


def schedules(root: Path) -> list[Report]:
    schedule = read(root / "config/temporal/ready-schedules.json")
    flow = [
        row
        for row in items(schedule, "schedules")
        if string(row.get("schedule_id")).startswith("sched.robinswood-flow-")
    ]
    empty: Report = {}
    owner = next(
        (
            row
            for row in flow
            if row.get("schedule_id") == "sched.robinswood-flow-sellsy-sync"
        ),
        empty,
    )
    return [
        check(
            "single_recurring_sellsy_mutation_owner",
            len(flow) == 8
            and not any(
                row.get("schedule_id") == "sched.robinswood-flow-contact-enrichment"
                for row in flow
            )
            and child(owner, "payload").get("legacy_id")
            == "robinswood-flow-sellsy-sync",
            {"count": len(flow), "owner": owner.get("payload")},
        )
    ]
