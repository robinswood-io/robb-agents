from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path

import a_hdf_recovery_test_guard as offline_guard
import robinswood_pme_hdf_recovery_cohort as recovery
import robinswood_pme_hdf_recovery_cohort_support as support


def tearDownModule() -> None:
    offline_guard.assert_no_external_attempts()


def _write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    _ = path.write_text(json.dumps(value), encoding="utf-8")


def _write_jsonl(path: Path, rows: list[object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    contents = "".join(json.dumps(row) + "\n" for row in rows)
    _ = path.write_text(contents, encoding="utf-8")


def _file_hashes(paths: list[Path]) -> dict[Path, str]:
    return {path: hashlib.sha256(path.read_bytes()).hexdigest() for path in paths}


class RecoveryCohortOfflineTests(unittest.TestCase):
    def test_selftest_preserves_capacity_bounce_and_non_send_gates(self) -> None:
        result = recovery.selftest()
        self.assertIs(result.get("ok"), True)
        self.assertIs(result.get("capacityAndExecutiveEvidenceRequired"), True)
        self.assertIs(result.get("bounceAlwaysExcluded"), True)
        self.assertIs(result.get("externalSendAllowed"), True)
        self.assertIs(result.get("mailerConsumable"), True)

    def test_corrupt_existing_input_is_not_treated_as_empty(self) -> None:
        with tempfile.TemporaryDirectory(prefix="hdf-recovery-invalid-qa-") as temporary:
            path = Path(temporary) / "ledger.jsonl"
            _ = path.write_text("{invalid\n", encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "recovery_input_jsonl_invalid:1"):
                _ = support.read_jsonl(path)

    def test_config_requires_external_campaign_and_baseline(self) -> None:
        with tempfile.TemporaryDirectory(prefix="hdf-recovery-config-qa-") as temporary:
            path = Path(temporary) / "config.json"
            _write_json(path, {
                "campaignId": "qa-campaign",
                "recoveryCohortId": "qa-cohort",
                "expectedSentCumulative": 3,
                "expectedLaneHardBounces": 1,
            })
            self.assertEqual(
                recovery.RecoveryConfig.load(path),
                recovery.RecoveryConfig("qa-campaign", "qa-cohort", 3, 1),
            )
            _write_json(path, {"campaignId": "qa-campaign"})
            with self.assertRaisesRegex(ValueError, "recovery_cohort_id_missing"):
                _ = recovery.RecoveryConfig.load(path)

    def test_run_uses_qa_paths_and_preserves_all_input_files(self) -> None:
        with tempfile.TemporaryDirectory(prefix="hdf-recovery-qa-") as temporary:
            root = Path(temporary)
            paths = recovery.RecoveryPaths.under(root)
            eligible_email = "director@qa-company.example"
            bounced_email = "contact@bounced-company.example"
            duplicate_email = "recipient@other-campaign.example"
            drafts = [
                self._draft("qa-draft-1", eligible_email),
                self._draft("qa-draft-duplicate", eligible_email),
                self._draft("qa-draft-2", bounced_email),
                self._draft("qa-draft-3", duplicate_email),
            ]
            _write_json(paths.drafts, {"drafts": drafts})
            _write_json(paths.performance, {"metrics": {
                "sentCumulative": 3,
                "laneHardBounces": 1,
                "excludedCrossCampaignBounces": 0,
                "hardBounceRate": 0.333,
                "qualifiedReplies": 0,
            }})
            _write_json(paths.suppression, {"records": [{
                "email": bounced_email,
                "active": True,
                "reason": "hard_bounce",
                "campaignId": "qa-campaign",
            }]})
            _write_json(paths.profile_pack, {"profiles": [
                self._profile(eligible_email),
                self._profile(duplicate_email),
            ]})
            _write_json(paths.scale_seed, {"items": [
                {"siren": "999999999", "employeeRange": "100-199", "initialScore": 85},
            ]})
            _write_json(paths.mailer_ledger, {})
            _write_json(paths.dispatch_ledger, {})
            _write_jsonl(paths.attribution_ledger, [{
                "recipientEmail": duplicate_email,
                "campaignId": "qa-other-campaign",
            }])
            inputs = [
                paths.drafts, paths.performance, paths.suppression, paths.profile_pack,
                paths.scale_seed, paths.mailer_ledger, paths.dispatch_ledger,
                paths.attribution_ledger,
            ]
            before = _file_hashes(inputs)
            config = recovery.RecoveryConfig(
                campaign_id="qa-campaign",
                recovery_cohort_id="qa-recovery-cohort",
                expected_sent_cumulative=3,
                expected_lane_hard_bounces=1,
            )

            report = recovery.run(paths, config, emit=False)

            self.assertEqual(before, _file_hashes(inputs))
            self.assertTrue(paths.report_json.is_file())
            self.assertTrue(paths.report_markdown.is_file())
            self.assertTrue(paths.review_pack.is_file())
            self.assertTrue(paths.simulated_plan.is_file())
            self.assertTrue(paths.history.is_file())
            counts = support.object_or_empty(report.get("counts"))
            self.assertEqual(counts.get("draftsReviewed"), 4)
            self.assertEqual(counts.get("uniqueRecipientsReviewed"), 3)
            self.assertEqual(counts.get("duplicateDraftsExcluded"), 1)
            self.assertEqual(counts.get("eligible_for_human_review"), 1)
            self.assertEqual(counts.get("excluded"), 2)
            effects = support.object_or_empty(report.get("externalEffects"))
            self.assertEqual(effects, {
                "emailsSent": 0,
                "linkedinActions": 0,
                "crmMutations": 0,
                "opportunitiesCreated": 0,
            })
            self.assertIs(report.get("ok"), True)
            self.assertIs(report.get("status"), "prepared_review_only_zero_send")

    @staticmethod
    def _draft(draft_id: str, email: str) -> dict[str, object]:
        return {
            "draftId": draft_id,
            "recipientEmail": email,
            "companyName": "Synthetic QA Company",
            "recipientName": "QA Director",
            "profileControl": {
                "tier": "A_go_autonomous_pre_send_gate",
                "score": 90,
                "reasons": ["contact_quality_ok"],
                "blockers": [],
                "minimumBudgetFit": "unknown_requires_evidence",
                "contextStrength": {
                    "ok": True,
                    "companyEvidenceOk": True,
                    "individualEvidenceOk": True,
                    "specificAngleOk": True,
                    "blockers": [],
                    "evidenceSample": ["Synthetic public evidence for QA only."],
                },
            },
        }

    @staticmethod
    def _profile(email: str) -> dict[str, object]:
        return {
            "email": email,
            "sourceContact": {
                "siren": "999999999",
                "leaderTitle": "Directeur Général",
                "finalStatus": "ready_for_human_review_not_send",
                "qualityGateOk": True,
                "emailRiskVerdict": "verified_or_low_risk",
                "suppressionStatus": "clear",
                "domainVerdict": "confirmed_official_company_domain",
                "matchedLeaderTokens": ["qa-director"],
            },
        }


if __name__ == "__main__":
    _ = unittest.main()
