"""Contact gate and CRM reconciliation run on QA files and an in-memory fake CRM."""

from __future__ import annotations

import io
import os
import tempfile
import unittest
from collections.abc import Generator
from contextlib import ExitStack, contextmanager, nullcontext, redirect_stdout
from pathlib import Path
from unittest.mock import patch

import evergreen_offline_test_guard as offline
import flow_contact_enrichment_rules as rules
import flow_duplicate_targets as duplicate_targets
import robinswood_flow_contact_enrichment as enrichment
import robinswood_flow_core as core
from flow_contact_evidence_state import Row, object_row, object_rows
from robinswood_flow_contact_evidence_discovery import load, save


def tearDownModule() -> None:
    offline.assert_no_external_attempts()


def account(key: str = "qa", company: int = 101, contact: int | None = None) -> Row:
    return {
        "key": key,
        "name": "QA Company",
        "domain": "example.org",
        "sponsor": "Alex Example",
        "role": "CEO",
        "sources": ["https://example.org"],
        "employees": 100,
        "trigger": "growth",
        "flow": "integration",
        "sellsyCompanyId": company,
        "sellsyContactId": contact,
        "approvedForSequence": False,
    }


def evidence(key: str = "qa") -> Row:
    return {
        "accountKey": key,
        "personName": "Alex Example",
        "professionalEmail": key + "@example.org",
        "emailEvidenceUrl": "https://example.org/team",
        "emailVerification": {"status": "valid", "confidence": 0.95},
        "profileUrl": "https://example.org/alex",
        "verifiedRole": "CEO",
        "roleEvidenceUrl": "https://example.org/team",
        "companyEvidenceUrl": "https://example.org",
    }


def identifier(value: object) -> int:
    return int(str(object_row(value).get("id") or 0))


class FakeCRM:
    def __init__(self) -> None:
        self.contacts: dict[int, Row] = {}
        self.calls: list[tuple[str, str]] = []
        self.next_id: int = 1000
        self.fail_link: bool = False
        self.fail_lookup: bool = False
        self.bad_readback: bool = False

    def listall(self, endpoint: str, maxp: int = 20) -> list[Row]:
        _ = maxp
        if endpoint != "/contacts":
            raise AssertionError("unexpected CRM collection")
        return [row.copy() for row in self.contacts.values()]

    def request(self, endpoint: str, method: str = "GET", body: object = None) -> Row:
        self.calls.append((endpoint, method))
        if endpoint == "/contacts" and method == "POST":
            value = object_row(body)
            value["id"] = self.next_id
            self.contacts[self.next_id] = value
            self.next_id += 1
            return {"id": value["id"]}
        if endpoint.startswith("/companies/"):
            if self.fail_link:
                raise OSError("QA uncertain association")
            return {"ok": True}
        contact = int(endpoint.rsplit("/", 1)[-1])
        if method == "PUT":
            self.contacts[contact].update(object_row(body))
            return {"id": contact}
        if method != "GET":
            raise AssertionError("unexpected CRM mutation")
        if self.fail_lookup:
            raise OSError("QA uncertain lookup")
        row = self.contacts[contact].copy()
        if self.bad_readback and row.get("note"):
            row["email"] = "wrong@example.org"
        return row


@contextmanager
def prepare_only() -> Generator[None]:
    with patch.dict(os.environ, {"RBW_FLOW_CONTACT_ENRICHMENT_APPLY": "0"}):
        yield


def fixture(
    stack: ExitStack, root: Path, crm: FakeCRM, accounts: list[Row], items: list[Row]
) -> None:
    _ = stack.enter_context(redirect_stdout(io.StringIO()))
    _ = stack.enter_context(prepare_only())
    # Exercise the real duplicate guard with a synthetic private configuration.
    _ = stack.enter_context(
        patch.object(
            duplicate_targets,
            "technical_duplicates",
            return_value={
                "companies": {"qa": [9001, 101]},
                "contacts": {},
                "falsePositiveContacts": {},
            },
        )
    )
    _ = stack.enter_context(
        patch.object(enrichment, "chain_lock", return_value=nullcontext(True))
    )
    for name in ["EVIDENCE", "REPORT", "PACK"]:
        _ = stack.enter_context(
            patch.object(enrichment, name, root / (name.lower() + ".json"))
        )
    _ = stack.enter_context(patch.object(core, "REG", root / "registry.json"))
    _ = stack.enter_context(patch.object(core, "load", side_effect=load))
    _ = stack.enter_context(patch.object(core, "save", side_effect=save))
    _ = stack.enter_context(
        patch.object(core, "account_key", return_value="protected-qa")
    )
    _ = stack.enter_context(
        patch.object(core, "now", return_value="2026-10-30T12:00:00Z")
    )
    _ = stack.enter_context(patch.object(core, "listall", side_effect=crm.listall))
    _ = stack.enter_context(patch.object(core, "crmreq", side_effect=crm.request))
    _ = stack.enter_context(patch.object(core, "deepid", side_effect=identifier))
    save(core.REG, {"accounts": accounts})
    save(enrichment.EVIDENCE, {"items": items})


class ContactGateTests(unittest.TestCase):
    def test_evidence_matrix_enforces_identity_domain_and_sources(self) -> None:
        self.assertEqual(rules.validate(account(), evidence()), (True, []))
        for field, value, gap in [
            ("professionalEmail", "qa@wrong.example", "email_domain_mismatch"),
            ("personName", "Someone Else", "person_identity_match"),
            (
                "emailEvidenceUrl",
                "https://google.com/search?q=qa",
                "email_evidence_url",
            ),
            ("verifiedRole", "", "verified_role"),
            ("profileUrl", "http://example.org", "professional_profile_url"),
        ]:
            with self.subTest(field=field):
                item = evidence()
                item[field] = value
                self.assertIn(gap, rules.validate(account(), item)[1])

    def test_nonfinite_or_out_of_range_confidence_is_rejected(self) -> None:
        for value in [float("nan"), float("inf"), 500, 0.89]:
            with self.subTest(value=value):
                item = evidence()
                item["emailVerification"] = {"status": "valid", "confidence": value}
                self.assertFalse(rules.validate(account(), item)[0])

    def test_budget_signals_never_become_approval(self) -> None:
        candidate = account()
        candidate["budget"] = "€30m funding"
        result = rules.approval_item(candidate, {"evidencePassed": True}, evidence())
        self.assertIs(result["eligibleForHumanReview"], True)
        self.assertIs(result["eligibleForAutomaticApproval"], False)
        self.assertIs(result["approvedForSequence"], False)
        self.assertIs(
            object_row(result["budgetControl"])["allocatedBudgetEvidence"], False
        )
        self.assertIs(result["externalOutboundAllowed"], False)

    def test_default_preparation_and_validate_only_never_call_crm(self) -> None:
        for args, environment in [([], "0"), (["--validate-only", "--apply"], "1")]:
            with (
                self.subTest(args=args),
                tempfile.TemporaryDirectory() as temp,
                ExitStack() as stack,
            ):
                crm = FakeCRM()
                fixture(stack, Path(temp), crm, [account()], [evidence()])
                original = core.REG.read_bytes()
                with patch.dict(
                    os.environ, {"RBW_FLOW_CONTACT_ENRICHMENT_APPLY": environment}
                ):
                    self.assertEqual(enrichment.main(args), 0)
                self.assertEqual(crm.calls, [])
                self.assertEqual(core.REG.read_bytes(), original)
                self.assertIs(load(enrichment.REPORT, {})["apply"], False)
                self.assertIs(
                    load(enrichment.PACK, {})["automaticApprovalForbidden"], True
                )

    def test_create_then_update_links_correct_company_and_resumes_without_writes(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            crm = FakeCRM()
            crm.contacts[902] = {
                "id": 902,
                "email": "qa2@example.org",
                "position": "Old",
                "note": "old",
            }
            fixture(
                stack,
                Path(temp),
                crm,
                [account("qa1"), account("qa2", 102, 902)],
                [evidence("qa1"), evidence("qa2")],
            )
            self.assertEqual(enrichment.main(["--apply"]), 0)
            counts = object_row(load(enrichment.REPORT, {})["counts"])
            self.assertEqual(counts["contactsCreated"], 1)
            self.assertEqual(counts["contactsUpdated"], 1)
            self.assertIn(("/companies/102/contacts/902", "POST"), crm.calls)
            rows = object_rows(load(core.REG, {})["accounts"])
            self.assertTrue(
                all(
                    row["contactVerified"] is True
                    and row["approvedForSequence"] is False
                    for row in rows
                )
            )
            crm.calls.clear()
            self.assertEqual(enrichment.main(["--apply"]), 0)
            self.assertTrue(all(method == "GET" for _, method in crm.calls))

    def test_failed_relationship_is_reported_incomplete(self) -> None:
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            crm = FakeCRM()
            crm.contacts[902] = {
                "id": 902,
                "email": "qa@example.org",
                "position": "Old",
                "note": "old",
            }
            crm.fail_link = True
            fixture(stack, Path(temp), crm, [account(contact=902)], [evidence()])
            self.assertEqual(enrichment.main(["--apply"]), 1)
            report = load(enrichment.REPORT, {})
            self.assertIs(report["ok"], False)
            self.assertEqual(object_row(report["counts"])["errors"], 1)
            self.assertNotIn(
                "contactVerified", object_rows(load(core.REG, {})["accounts"])[0]
            )

    def test_uncertain_lookup_does_not_create_a_duplicate(self) -> None:
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            crm = FakeCRM()
            crm.contacts[902] = {"id": 902, "email": "qa@example.org"}
            crm.fail_lookup = True
            fixture(stack, Path(temp), crm, [account(contact=902)], [evidence()])
            self.assertEqual(enrichment.main(["--apply"]), 1)
            self.assertTrue(all(method == "GET" for _, method in crm.calls))

    def test_readback_requires_actual_email_not_a_note_occurrence(self) -> None:
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            crm = FakeCRM()
            crm.bad_readback = True
            fixture(stack, Path(temp), crm, [account()], [evidence()])
            self.assertEqual(enrichment.main(["--apply"]), 1)
            report = load(enrichment.REPORT, {})
            self.assertEqual(
                object_rows(report["errors"])[0]["error"], "contact_readback_failed"
            )
