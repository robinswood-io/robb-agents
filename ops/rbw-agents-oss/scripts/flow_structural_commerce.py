"""Audit historical commercial containment against explicit private configuration."""

from __future__ import annotations

from pathlib import Path

import robinswood_flow_core as core
from flow_duplicate_targets import targets
from flow_structural_checks import (
    Report,
    check,
    child,
    items,
    number,
    obj,
    read,
    string,
)
from robinswood_pme_hdf_recovery_cohort import CONFIG_PATH, RecoveryConfig

LANES = {"robinswood-flow", "pme-hdf", "abm-outreach", "prescriber-network"}


def post_remediation(_root: Path) -> list[Report]:
    post = read(core.OPS / "robinswood-commercial-post-remediation-control-last.json")
    counts = child(post, "counts")
    return [
        check(
            "commercial_postcheck_live_green",
            post.get("ok") is True
            and post.get("status") == "passed_no_drift"
            and all(
                counts.get(key) == 0
                for key in (
                    "sellsyMutations",
                    "flowOpportunities",
                    "unknownYousignMessages",
                    "newHdfSendsWhileBlocked",
                )
            ),
            counts,
        )
    ]


def recovery(_root: Path) -> list[Report]:
    config = RecoveryConfig.load(CONFIG_PATH)
    report = read(core.OPS / "robinswood-pme-hdf-recovery-cohort-last.json")
    counts = child(report, "counts")
    history = child(report, "historicalMetricsFrozen")
    simulation = read(core.OPS / "robinswood-pme-hdf-recovery-simulated-plan.json")
    return [
        check(
            "hdf_recovery_cohort_non_consumable",
            report.get("ok") is True
            and counts.get("readyForOutbound") == 0
            and counts.get("approvedForSend") == 0
            and history.get("sentCumulative") == config.expected_sent_cumulative
            and history.get("laneHardBounces") == config.expected_lane_hard_bounces
            and child(report, "checks").get("historicalMetricsPreserved") is True
            and simulation.get("mailerConsumable") is False
            and simulation.get("externalSendAllowed") is False
            and simulation.get("approvedItemsCount") == 0,
            {
                "counts": counts,
                "historical": history,
                "simulated": simulation.get("status"),
            },
        )
    ]


def lane_diagnostic(_root: Path) -> list[Report]:
    report = read(core.OPS / "robinswood-commercial-lane-recovery-diagnostic-last.json")
    lanes = items(report, "lanes")
    return [
        check(
            "four_lane_recovery_diagnostic",
            report.get("ok") is True
            and len(lanes) == 4
            and {string(row.get("laneId")) for row in lanes} == LANES
            and all(
                row.get("decision")
                in ("hold", "rework", "retire", "eligible_for_human_review")
                and row.get("externalSendAllowed") is False
                for row in lanes
            ),
            {
                "status": report.get("status"),
                "lanes": [
                    {"id": row.get("laneId"), "decision": row.get("decision")}
                    for row in lanes
                ],
            },
        )
    ]


def duplicate_audit(_root: Path) -> list[Report]:
    value = targets()
    report = read(core.OPS / "robinswood-flow-duplicate-relationship-audit-last.json")
    counts = child(report, "counts")
    return [
        check(
            "duplicate_relationship_audit_read_only",
            report.get("ok") is True
            and counts.get("objects")
            == len(value.companies)
            + len(value.contacts)
            + len(value.falsePositiveContacts)
            and counts.get("duplicateCompanies") == len(value.companies)
            and counts.get("duplicateContacts") == len(value.contacts)
            and counts.get("falsePositiveContacts") == len(value.falsePositiveContacts)
            and counts.get("endpointScansComplete") == counts.get("endpointScans") == 6
            and all(
                counts.get(key) == 0
                for key in ("hardDeletes", "archives", "crmMutations")
            ),
            counts,
        )
    ]


def report_policy(root: Path) -> list[Report]:
    policy = read(root / "config/system-of-record-policy.json")
    overrides = child(child(policy, "classification"), "explicitOverrides")
    ids = {
        "source-lane-learning-governor",
        "robinswood-pme-hdf-performance-optimizer",
        "robinswood-pme-hdf-pre-send-gate",
        "robinswood-flow-guard-tests",
        "robinswood-commercial-post-remediation-control",
        "robinswood-commercial-lane-diagnostic",
        "robinswood-pme-hdf-recovery-cohort",
        "robinswood-flow-duplicate-relationship-audit",
    }
    classifications: Report = {
        key: obj(overrides.get(key)).get("classification") for key in sorted(ids)
    }
    return [
        check(
            "technical_read_only_reports_need_no_business_payload",
            all(value == "none" for value in classifications.values()),
            classifications,
        )
    ]


def hdf_containment(_root: Path) -> list[Report]:
    config = RecoveryConfig.load(CONFIG_PATH)
    report = read(core.OPS / "robinswood-pme-hdf-performance-optimizer-last.json")
    metrics = child(report, "metrics")
    sent = config.expected_sent_cumulative
    bounces = config.expected_lane_hard_bounces
    expected_rate = bounces / sent if sent else 0.0
    gate = read(core.OPS / "robinswood-pme-hdf-pre-send-gate-last.json")
    return [
        check(
            "hdf_lane_denominator_matches_private_baseline",
            metrics.get("sentCumulative") == sent
            and metrics.get("laneHardBounces") == bounces
            and abs(number(metrics.get("hardBounceRate")) - expected_rate) < 0.0001,
            metrics,
        ),
        check(
            "hdf_cross_campaign_bounces_excluded",
            number(metrics.get("excludedCrossCampaignBounces")) >= 1,
            metrics,
        ),
        check(
            "hdf_scaling_fail_closed",
            metrics.get("scalingAllowed") is False
            and metrics.get("recommendedMaxFirstSendsPerRun") == 0
            and metrics.get("pauseRecommended") is True,
            metrics,
        ),
        check(
            "hdf_gate_blocks_at_5_percent",
            gate.get("externalSendAllowed") is False
            and string(gate.get("status")).startswith("blocked"),
            {
                "status": gate.get("status"),
                "blockingReasons": gate.get("blockingReasons"),
            },
        ),
    ]


def attribution(_root: Path) -> list[Report]:
    report = read(core.OPS / "commercial-attribution-summary.json")
    dashboard = read(core.OPS / "robinswood-commerce-dashboard.json")
    return [
        check(
            "commercial_attribution_ledger_green",
            report.get("ok") is True
            and child(report, "counts").get("missingRequiredAttribution") == 0,
            report.get("counts"),
        ),
        check(
            "commercial_horizons_7_30_90",
            set(child(report, "horizons")) == {"7", "30", "90"},
        ),
        check(
            "dashboard_ledger_only",
            dashboard.get("sourceOfTruth")
            == str(core.OPS / "commercial-attribution-ledger.jsonl")
            and child(dashboard, "dataQuality").get("legacyCountersExcluded") is True,
        ),
    ]


def learning(_root: Path) -> list[Report]:
    report = read(core.OPS / "source-lane-learning-governor-last.json")
    decisions = [
        row for row in items(report, "decisions") if string(row.get("laneId")) in LANES
    ]
    return [
        check(
            "learning_uses_bounded_contract",
            report.get("contractVersion")
            == "lane-learning-v2-commercial-ledger-bounded"
            and "no automatic outbound volume increase"
            in string(child(report, "method").get("safety")),
        ),
        check(
            "learning_never_auto_promotes_outbound",
            {string(row.get("laneId")) for row in decisions} == LANES
            and all(
                row.get("recommendedAction") != "promote_next_cycle"
                for row in decisions
            ),
            [row for row in decisions],
        ),
    ]
