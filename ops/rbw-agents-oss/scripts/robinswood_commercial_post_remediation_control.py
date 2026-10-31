"""Read-only post-remediation evidence checks; no delivery or CRM mutation."""

from __future__ import annotations

import json

from commercial_post_readbacks import (
    ACCEPTED_SENT,
    DUPLICATE_AUDIT,
    HDF_GATE,
    HDF_MAILER,
    INCIDENT,
    INTEGRITY,
    OUT,
    OUT_MD,
    STATE,
    SYNC,
    duplicate_audit_readback,
    gmail_yousign_readback,
    hdf_sent_keys,
    now_iso,
    opportunity_readback,
    read_json,
    schedule_contract,
    write_json,
)
from flow_contact_evidence_state import Row, object_row, object_rows, strings
from flow_duplicate_crm import ident


def render_md(report: Row) -> str:
    counts = object_row(report.get("counts") or {})
    lines = [
        "# Commercial post-remediation control",
        "",
        f"- Generated: {report.get('generatedAt')}",
        f"- Status: **{report.get('status')}**",
        f"- Checks passed: **{counts.get('passed')}/{counts.get('checks')}**",
        f"- Sellsy mutations this sync: **{counts.get('sellsyMutations')}**",
        f"- Flow opportunities found: **{counts.get('flowOpportunities')}**",
        f"- Unknown Yousign sent messages: **{counts.get('unknownYousignMessages')}**",
        f"- New HDF ledger sends while capped at zero: **{counts.get('newHdfSendsWhileBlocked')}**",
        "- External sends from this control: **0**",
        "- CRM mutations from this control: **0**",
    ]
    blockers = strings(report.get("blockingReasons") or [])
    lines += ["", "## Blocking reasons"] + (
        [f"- {value}" for value in blockers] or ["- none"]
    )
    return "\n".join(lines) + "\n"


def selftest() -> Row:
    return {
        "ok": ACCEPTED_SENT
        == {
            "sent",
            "sent_verified",
            "sent_needs_manual_verification",
            "already_sent_after_verified_lookup",
        },
        "noMutationFunctions": True,
        "newScheduleCreated": False,
        "externalSends": 0,
    }


def run(emit: bool = True) -> Row:
    generated = now_iso()
    sync = read_json(SYNC, {}) or {}
    integrity = read_json(INTEGRITY, {}) or {}
    gate = read_json(HDF_GATE, {}) or {}
    mailer = read_json(HDF_MAILER, {}) or {}
    incident = read_json(INCIDENT, {}) or {}
    state = read_json(STATE, {}) or {}
    sync_counts = object_row(sync.get("counts") or {})
    mutation_fields = (
        "companiesCreatedThisRun",
        "contactsCreatedThisRun",
        "tasksCreatedThisRun",
        "opportunitiesCreated",
        "integrityMutationsFirstReplay",
        "integrityMutationsSecondReplay",
        "hardDeletes",
        "archives",
    )
    mutation_counts = [int(str(sync_counts.get(key) or 0)) for key in mutation_fields]
    mutation_counts_valid = all(key in sync_counts for key in mutation_fields) and all(
        count >= 0 for count in mutation_counts
    )
    sellsy_mutations = sum(mutation_counts)
    sync_readbacks_ok = (
        all(
            ident({"id": row.get("companyId")}) is not None
            and row.get("companyId") == row.get("companyReadbackId")
            and (
                not row.get("contactId")
                or (
                    ident({"id": row.get("contactId")}) is not None
                    and row.get("contactId") == row.get("contactReadbackId")
                )
            )
            and ident({"id": row.get("taskId")}) is not None
            and (row.get("taskId") == row.get("taskReadbackId"))
            for row in object_rows(sync.get("crmObjects") or [])
        )
        and len(object_rows(sync.get("crmObjects") or [])) == 13
    )
    sync_check = {
        "ok": sync.get("ok") is True
        and mutation_counts_valid
        and sellsy_mutations == 0
        and sync_readbacks_ok,
        "mutationCountsValid": mutation_counts_valid,
        "mutations": sellsy_mutations,
        "readbacks": len(object_rows(sync.get("crmObjects") or [])),
        "readbacksOk": sync_readbacks_ok,
        "status": sync.get("status"),
        "integrityStatus": integrity.get("status"),
    }
    hdf_keys = hdf_sent_keys()
    previous_keys = set(strings(state.get("hdfSentKeys") or []))
    baseline_initialization = "hdfSentKeys" not in state
    new_hdf_keys = (
        sorted(hdf_keys - previous_keys) if not baseline_initialization else []
    )
    hdf_blocked = (
        gate.get("externalSendAllowed") is False
        and int(
            str(
                object_row(gate.get("counts") or {}).get("effectiveMaxFirstSendsPerRun")
                or 0
            )
        )
        == 0
    )
    hdf_check = {
        "ok": not baseline_initialization
        and hdf_blocked
        and (not (new_hdf_keys and hdf_blocked))
        and (not object_rows(mailer.get("sentOrFound") or []))
        and (not object_rows(mailer.get("planned") or [])),
        "gateStatus": gate.get("status"),
        "effectiveMaxFirstSendsPerRun": object_row(gate.get("counts") or {}).get(
            "effectiveMaxFirstSendsPerRun"
        ),
        "externalSendAllowed": gate.get("externalSendAllowed"),
        "mailerMode": mailer.get("mode"),
        "mailerSentOrFound": object_rows(mailer.get("sentOrFound") or []),
        "mailerPlanned": object_rows(mailer.get("planned") or []),
        "currentSentLedgerKeys": len(hdf_keys),
        "previousSentLedgerKeys": len(previous_keys),
        "newSentLedgerKeys": new_hdf_keys,
        "baselineInitialization": baseline_initialization,
    }
    incident_check = {
        "ok": incident.get("status") == "contained_no_resend"
        and object_row(incident.get("containment") or {}).get("resendAllowed") is False
        and (
            int(
                str(
                    object_row(incident.get("gmailEvidence") or {}).get(
                        "attachmentCount"
                    )
                    or 0
                )
            )
            == 0
        ),
        "messageId": object_row(incident.get("gmailEvidence") or {}).get("messageId"),
        "status": incident.get("status"),
        "resendAllowed": object_row(incident.get("containment") or {}).get(
            "resendAllowed"
        ),
    }
    checks: dict[str, Row] = {
        "sellsySyncZeroMutation": sync_check,
        "hdfZeroCapNoNewSend": hdf_check,
        "yousignIncidentContained": incident_check,
        "singleMutationOwner": schedule_contract(),
    }
    try:
        checks["sellsyOpportunityFullRead"] = opportunity_readback()
    except (OSError, ValueError, TypeError, RuntimeError) as exc:
        checks["sellsyOpportunityFullRead"] = {
            "ok": False,
            "error": f"{type(exc).__name__}: {exc}"[:1000],
        }
    try:
        checks["gmailYousignExactReadback"] = gmail_yousign_readback()
    except (OSError, ValueError, TypeError, RuntimeError) as exc:
        checks["gmailYousignExactReadback"] = {
            "ok": False,
            "error": f"{type(exc).__name__}: {exc}"[:1000],
        }
    try:
        checks["duplicateRelationshipAudit"] = duplicate_audit_readback()
    except (OSError, ValueError, TypeError, RuntimeError) as exc:
        checks["duplicateRelationshipAudit"] = {
            "ok": False,
            "error": f"{type(exc).__name__}: {exc}"[:1000],
        }
    blockers = [name for name, result in checks.items() if result.get("ok") is not True]
    passed = sum(1 for result in checks.values() if result.get("ok") is True)
    flow_matches = object_rows(
        object_row(checks.get("sellsyOpportunityFullRead") or {}).get("flowMatches")
        or []
    )
    unknown_messages = strings(
        object_row(checks.get("gmailYousignExactReadback") or {}).get(
            "unknownMessageIds"
        )
        or []
    )
    counts = {
        "checks": len(checks),
        "passed": passed,
        "failed": len(checks) - passed,
        "sellsyMutations": sellsy_mutations,
        "flowOpportunities": len(flow_matches),
        "unknownYousignMessages": len(unknown_messages),
        "newHdfSendsWhileBlocked": len(new_hdf_keys) if hdf_blocked else 0,
        "externalSends": 0,
        "crmMutationsFromControl": 0,
        "opportunitiesCreatedFromControl": 0,
        "archives": 0,
        "hardDeletes": 0,
    }
    ok = not blockers
    report: Row = {
        "generatedAt": generated,
        "contractVersion": "robinswood-commercial-post-remediation-control-v1-live-readback",
        "capabilityId": "robinswood-commercial-post-remediation-control",
        "ok": ok,
        "status": "passed_no_drift" if ok else "blocked_drift_detected",
        "summary": f"commercial_postcheck: passed={passed}/{len(checks)} sellsyMutations={sellsy_mutations} flowOpportunities={len(flow_matches)} unknownYousign={len(unknown_messages)} newHdfWhileBlocked={counts['newHdfSendsWhileBlocked']}",
        "counts": counts,
        "checks": checks,
        "blockingReasons": blockers,
        "warningReasons": [],
        "alertPolicy": {
            "failClosedOnDrift": True,
            "externalCorrectiveActionAutomatic": False,
            "newScheduleCreated": False,
            "integratedOwner": "robinswood-flow-sellsy-sync",
        },
        "systemsOfRecord": {
            "classification": "none",
            "work": {"required": False, "objectIds": [], "verifiedByReadback": False},
            "sellsy": {
                "required": False,
                "tenant": "robinswood",
                "objectIds": [],
                "verifiedByReadback": False,
            },
            "pendingSyncItems": [],
        },
        "artifacts": {
            "reportJson": str(OUT),
            "reportMd": str(OUT_MD),
            "stateJson": str(STATE),
            "syncReport": str(SYNC),
            "duplicateAudit": str(DUPLICATE_AUDIT),
        },
        "externalEffects": {
            "gmailReads": True,
            "sellsyReads": True,
            "emailsSent": 0,
            "crmMutations": 0,
            "opportunitiesCreated": 0,
        },
    }
    write_json(OUT, report)
    _ = OUT_MD.write_text(render_md(report), encoding="utf-8")
    if not (new_hdf_keys and hdf_blocked):
        write_json(
            STATE,
            {
                "updatedAt": generated,
                "contractVersion": "robinswood-commercial-post-remediation-control-state-v1",
                "hdfSentKeys": sorted(
                    hdf_keys if baseline_initialization or ok else previous_keys
                ),
                "lastPassed": ok,
                "lastReport": str(OUT),
            },
        )
    if emit:
        print(
            json.dumps(
                {
                    "ok": ok,
                    "status": report["status"],
                    "counts": counts,
                    "blockingReasons": blockers,
                    "reportJson": str(OUT),
                },
                ensure_ascii=False,
            )
        )
    return report


def main() -> int:
    return 0 if run().get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
