"""Entry-point missions include materialization, delivery, reply, CRM and replay."""

from __future__ import annotations

import tempfile
import unittest
from collections.abc import Mapping
from contextlib import ExitStack
from pathlib import Path
from typing import override
from unittest.mock import patch

import evergreen_offline_test_guard as offline
import flow_v2_delivery as delivery
import flow_v2_materializer as materializer
import robinswood_flow_core as core
import robinswood_flow_lock as locks
import robinswood_flow_v2 as flow
from flow_contact_evidence_state import OBJECT, Row, object_row, object_rows
from flow_v2_rules import approval_scope
from pydantic import JsonValue
from test_flow_v2_delivery import NOW, FakeMailTransport
from test_flow_v2_delivery import fixture as delivery_fixture
from test_flow_v2_reply_crm import FakeCRM
from test_flow_v2_reply_router import message, save


def tearDownModule() -> None:
    offline.assert_no_external_attempts()


class MissionMail(FakeMailTransport):
    def __init__(self) -> None:
        super().__init__()
        self.inbound: list[JsonValue] = []

    @override
    def get(
        self,
        access: str,
        path: str,
        params: Mapping[str, str | list[str]] | None = None,
    ) -> dict[str, JsonValue]:
        if path == "threads/qa-thread":
            return {"messages": list(self.inbound)}
        return super().get(access, path, params)


def prepare_at_fixed_time() -> int:
    return materializer.materialize(NOW.replace(hour=8))


def deliver_at_fixed_time(*, apply: bool = False) -> int:
    return delivery.email_sequencer(apply=apply, reference=NOW)


def fixture(stack: ExitStack, root: Path, mail: MissionMail, crm: FakeCRM) -> None:
    delivery_fixture(stack, root, mail)
    _ = stack.enter_context(patch.object(core, "crmreq", crm.request))
    _ = stack.enter_context(patch.object(core, "OPS", root))
    _ = stack.enter_context(patch.object(core, "APPROVAL", root / "approval.json"))
    _ = stack.enter_context(patch.object(locks, "LOCK", root / "chain.lock"))
    _ = stack.enter_context(patch.object(materializer, "STATEQ", root / "state.json"))
    _ = stack.enter_context(
        patch.object(materializer, "DECISIONS", root / "decisions.json")
    )
    _ = stack.enter_context(
        patch.object(materializer, "item_references_duplicate", return_value=False)
    )
    _ = stack.enter_context(patch.object(flow, "materialize", prepare_at_fixed_time))
    _ = stack.enter_context(
        patch.object(flow, "email_sequencer", deliver_at_fixed_time)
    )
    seeds: list[dict[str, JsonValue]] = [
        {
            "key": "qa",
            "name": "QA Company",
            "campaign_id": "qa-campaign",
            "domain": "example.org",
            "wave": 1,
            "costHypothesisEur": 1000,
            "sponsor": "QA Person",
            "role": "CEO",
        }
    ]
    _ = stack.enter_context(patch.object(core, "accounts", return_value=seeds))
    registry = object_rows(OBJECT.validate_json(core.REG.read_text())["accounts"])
    registry[0].update(
        {"linkedin": "https://www.linkedin.com/in/qa-only", "role": "CEO"}
    )
    save(core.REG, {"accounts": registry})
    save(core.EMAILQ, {"items": []})
    save(core.LIQ, {"items": []})
    seed_row: Row = dict(seeds[0])
    approval_account = materializer.account_row(seed_row, registry[0], {}, NOW)
    scope = approval_scope(approval_account)
    if scope is None:
        raise AssertionError("QA approval scope missing")
    save(
        materializer.DECISIONS,
        {
            "items": [
                {
                    "accountKey": "qa",
                    "approvedForSequence": True,
                    "approvedAt": "2026-10-30T07:00:00Z",
                    "approvedBy": "QA",
                    "approvalScope": scope,
                    "status": "approved",
                }
            ]
        },
    )


class CommandMissionTests(unittest.TestCase):
    def test_complete_prepare_send_reply_crm_replay_and_dashboard(self) -> None:
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            root = Path(temp)
            mail, crm = MissionMail(), FakeCRM()
            fixture(stack, root, mail, crm)
            self.assertEqual(flow.main("materializer"), 0)
            self.assertEqual(
                len(
                    object_rows(OBJECT.validate_json(core.EMAILQ.read_text())["items"])
                ),
                4,
            )
            self.assertEqual(flow.main("email_sequencer"), 0)
            self.assertEqual(mail.posts, 0)
            self.assertEqual(flow.main("email_sequencer", apply=True), 0)
            self.assertEqual(mail.posts, 1)
            self.assertEqual(len(core.LEDGER.read_text().splitlines()), 1)
            mail.inbound = [message("qa-positive", "Avec plaisir, disponible")]
            self.assertEqual(flow.main("reply_router", apply=True), 0)
            self.assertEqual(crm.posts, ["/tasks", "/opportunities"])
            self.assertEqual(flow.main("reply_router", apply=True), 0)
            self.assertEqual(flow.main("email_sequencer", apply=True), 0)
            self.assertEqual(mail.posts, 1)
            self.assertEqual(len(crm.posts), 2)
            email = object_rows(OBJECT.validate_json(core.EMAILQ.read_text())["items"])
            self.assertEqual(sum(row["status"] == "sent_verified" for row in email), 1)
            self.assertEqual(
                sum(row["status"] == "cancelled_by_signal" for row in email), 3
            )
            self.assertEqual(flow.main("dashboard"), 0)
            dashboard = OBJECT.validate_json(
                (root / "robinswood-flow-dashboard-last.json").read_text()
            )
            counts = object_row(dashboard["counts"])
            self.assertEqual(counts["pendingConditionalTouches"], 0)
            self.assertEqual(counts["unresolvedDeliveries"], 0)
            self.assertEqual(counts["opportunitiesCreated"], 1)
            self.assertEqual(counts["events"], 2)
            self.assertTrue((root / "robinswood-flow-dashboard-last.md").is_file())

    def test_unknown_delivery_prevents_a_clean_dashboard_conclusion(self) -> None:
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            root = Path(temp)
            mail, crm = MissionMail(), FakeCRM()
            fixture(stack, root, mail, crm)
            _ = flow.main("materializer")
            mail.timeout = True
            self.assertEqual(flow.main("email_sequencer", apply=True), 1)
            self.assertEqual(flow.main("dashboard"), 1)
            result = OBJECT.validate_json(
                (root / "robinswood-flow-dashboard-last.json").read_text()
            )
            self.assertEqual(result["status"], "delivery_review_required")
            self.assertEqual(object_row(result["counts"])["unresolvedDeliveries"], 1)
            self.assertEqual(mail.posts, 1)

    def test_sync_prepare_executes_no_operational_stages(self) -> None:
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            fixture(stack, Path(temp), MissionMail(), FakeCRM())
            for name in [
                "evidence_discovery_main",
                "enrichment_main",
                "sync_unlocked",
                "task_due_manager",
            ]:
                _ = stack.enter_context(
                    patch.object(
                        flow, name, side_effect=AssertionError("stage must not run")
                    )
                )
            self.assertEqual(flow.main("sellsy_sync"), 0)

    def test_sync_stops_on_upstream_failure_without_running_downstream(self) -> None:
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            fixture(stack, Path(temp), MissionMail(), FakeCRM())
            _ = stack.enter_context(
                patch.object(flow, "evidence_discovery_main", return_value=1)
            )
            _ = stack.enter_context(
                patch.object(
                    flow,
                    "enrichment_main",
                    side_effect=AssertionError("gate must not run"),
                )
            )
            _ = stack.enter_context(
                patch.object(
                    flow,
                    "sync_unlocked",
                    side_effect=AssertionError("CRM must not run"),
                )
            )
            self.assertEqual(flow.main("sellsy_sync", apply=True), 1)

    def test_sync_requires_base_success_and_verified_idempotent_due_replay(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            root = Path(temp)
            fixture(stack, root, MissionMail(), FakeCRM())
            _ = stack.enter_context(
                patch.object(flow, "evidence_discovery_main", return_value=0)
            )
            _ = stack.enter_context(
                patch.object(flow, "enrichment_main", return_value=0)
            )
            _ = stack.enter_context(patch.object(flow, "sync_unlocked", return_value=0))
            save(root / "robinswood-flow-sellsy-sync-last.json", {"ok": True})
            results: list[Row] = [
                {"ok": True, "counts": {"updated": 1}},
                {"ok": True, "counts": {"updated": 1}},
            ]
            _ = stack.enter_context(
                patch.object(flow, "task_due_manager", side_effect=results)
            )
            self.assertEqual(flow.main("sellsy_sync", apply=True), 1)
            result = OBJECT.validate_json(
                (root / "robinswood-flow-sellsy-sync-last.json").read_text()
            )
            self.assertEqual(result["status"], "partial")

    def test_unknown_mode_refuses_without_effect(self) -> None:
        with self.assertRaisesRegex(ValueError, "unknown_flow_command"):
            _ = flow.main("unknown")
