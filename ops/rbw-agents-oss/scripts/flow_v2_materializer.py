"""Materialize explicit approvals and future queues, preserving delivery evidence."""

from __future__ import annotations

from datetime import datetime, timedelta
from pathlib import Path

import robinswood_flow_core as c
from flow_contact_evidence_state import OBJECT, Row, object_row, object_rows
from flow_v2_rules import TZ, approval_for, approval_scope, future_slot, task_due
from sellsy_technical_duplicate_guard import item_references_duplicate

STATEQ = c.OPS / "robinswood-flow-account-state-queue.json"
DECISIONS = c.OPS / "robinswood-flow-account-approval-decisions.json"
PRESERVED = {
    "sellsyCompanyId",
    "sellsyContactId",
    "sellsyTaskId",
    "contactEvidence",
    "email",
    "linkedin",
    "role",
    "civility",
    "civility_source",
    "civilitySource",
    "civility_proof_source",
    "sponsor",
    "contactVerified",
}


def cost_hypothesis(account: Row) -> int:
    value = account.get("costHypothesisEur")
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError("explicit_nonnegative_cost_hypothesis_required")
    return value


def message_templates(a: Row) -> dict[str, Row]:
    from outbound_content_guard import safe_salutation

    sal = safe_salutation(
        {
            "name": str(a.get("sponsor") or ""),
            "role": a.get("role"),
            "civility": a.get("civility"),
            "civility_source": a.get("civility_source")
            or a.get("civilitySource")
            or a.get("civility_proof_source"),
        }
    )["salutation"]
    flow = str(a.get("flow") or "flux critique")
    trigger = str(a.get("trigger") or "votre contexte actuel")
    cost = cost_hypothesis(a)
    budget = str(a.get("budget") or "mandat de transformation")
    subject = f"{a['name']} — revue de 45 minutes du flux critique"
    return {
        "email_d0": {
            "subject": subject,
            "body": f"{sal}\n\nVotre actualité — {trigger} — suggère un point de vigilance sur le flux {flow}.\n\nJe propose une revue de 45 minutes pour tester l’hypothèse, chiffrer les reprises et décider s’il existe un sujet prioritaire. Si ce flux relève d’une autre personne, une orientation me serait utile.",
        },
        "email_d5": {
            "subject": "Re: " + subject,
            "body": f"{sal}\n\nJe reviens brièvement sur l’hypothèse concernant {flow} chez {a['name']}. À la suite de votre jalon ({trigger}), deux zones concentrent généralement les frictions : les passages de relais entre équipes et le traitement manuel des exceptions.\n\nUne revue de 45 minutes suffit pour confirmer ou écarter le coût de ces reprises. Sinon, pourriez-vous m’orienter vers la personne qui pilote ce flux ?",
        },
        "email_d10": {
            "subject": "Re: " + subject,
            "body": f"{sal}\n\nPour prolonger ma note sur le flux {flow} chez {a['name']}, notre hypothèse de travail évalue l’impact annuel des reprises et délais à environ {cost:,} € (ordre de grandeur à confronter à vos données réelles dans le cadre de votre contexte : {budget}).\n\nL’objectif de la Flow Review de 45 minutes est de produire une baseline claire et une décision go/no-go en dix jours, sans chantier lourd. Ce chiffrage mérite-t-il d’être vérifié avec votre sponsor opérationnel ?".replace(
                ",", " "
            ),
        },
        "email_d14": {
            "subject": "Re: " + subject,
            "body": f"{sal}\n\nJe clôture la boucle sur le flux {flow} chez {a['name']}. S’il n’est pas prioritaire actuellement, je n’insisterai pas.\n\nS’il relève d’un autre sponsor au sein de votre équipe de direction, une orientation vers la bonne personne me serait utile ; à défaut, je n’enverrai pas d’autre relance.",
        },
    }


def keyed_rows(path: Path, field: str, key: str) -> dict[str, Row]:
    rows = object_rows(c.load(path, {}).get(field) or [])
    result: dict[str, Row] = {}
    for row in rows:
        identifier = row.get(key)
        if (
            not isinstance(identifier, str)
            or not identifier.strip()
            or identifier in result
        ):
            raise ValueError("missing_or_duplicate_row_identifier")
        result[identifier] = row
    return result


def following_slot(
    initial: datetime, days: int, hour: int = 9, minute: int = 15
) -> datetime:
    candidate = (initial + timedelta(days=days)).replace(hour=hour, minute=minute)
    while candidate.weekday() > 4:
        candidate += timedelta(days=1)
    return candidate


def account_row(
    seed: Row,
    previous: Row,
    decision: Row,
    reference: datetime | None = None,
) -> Row:
    identity: Row = {
        **seed,
        **{key: value for key, value in previous.items() if key in PRESERVED},
    }
    approved, meta = approval_for(identity, previous, decision, reference)
    verified = (
        previous.get("contactVerified") is True
        and bool(previous.get("email"))
        and bool(previous.get("linkedin"))
    )
    state = (
        "sequence_approved"
        if approved and verified
        else "approved_waiting_contact"
        if approved
        else "contact_verified_prepare_only"
        if verified
        else "research_enrichment_queued"
    )
    row: Row = {
        **seed,
        **{key: value for key, value in previous.items() if key in PRESERVED},
        "lead_id": previous.get("lead_id")
        or c.stable(
            "lead",
            seed["campaign_id"],
            seed["key"],
            previous.get("email") or seed["domain"],
        ),
        "state": state,
        "researchVerified": True,
        "contactVerified": verified,
        "approvedForSequence": approved,
        **meta,
        "externalFirstContactAllowed": approved,
        "opportunityAllowed": False,
        "markers": [
            f"rbw-flow:account:{seed['key']}",
            f"rbw-flow:campaign:{seed['campaign_id']}",
        ],
        "costHypothesisNotFact": True,
    }
    return row


def seed_actions(
    account: Row, email: dict[str, Row], linkedin: dict[str, Row], reference: datetime
) -> None:
    key = str(account["key"])
    initial = future_slot(reference)
    templates = message_templates(account)
    scope = account.get("approvalScope")
    if not isinstance(scope, str):
        raise TypeError("approved_sequence_scope_missing")
    for kind, days in [
        ("email_d0", 0),
        ("email_d5", 5),
        ("email_d10", 10),
        ("email_d14", 18),
    ]:
        action_id = f"flow:{key}:email:{kind.removeprefix('email_')}"
        if action_id in email:
            existing = email[action_id]
            if existing.get("status") in {
                "scheduled_conditional",
                "held_approval_contact_or_duplicate_gate",
            }:
                existing.update(
                    {
                        "recipientEmail": account.get("email"),
                        "approvalScope": scope,
                        **templates[kind],
                    }
                )
                if existing.get("status") == "held_approval_contact_or_duplicate_gate":
                    existing["status"] = "scheduled_conditional"
            continue  # Preserve dueAt and all sent, paused or uncertain evidence.
        email[action_id] = {
            "action_id": action_id,
            "accountKey": key,
            "type": kind,
            "status": "scheduled_conditional",
            "dueAt": following_slot(initial, days).isoformat(),
            "recipientEmail": account.get("email"),
            "attachmentsAllowed": False,
            "approvalScope": scope,
            **templates[kind],
        }
    action_id = f"flow:{key}:linkedin:d2"
    linkedin_fields: Row = {
        "request_id": c.stable(
            "linkedin-request", account["campaign_id"], key, account.get("linkedin")
        ),
        "approvalScope": scope,
        "linkedinProfileUrl": account.get("linkedin"),
        "sellsyCompanyId": account.get("sellsyCompanyId"),
        "sellsyContactId": account.get("sellsyContactId"),
        "allowNote": False,
        "note": "",
        "connectionOnly": True,
        "contactName": account.get("sponsor"),
        "companyName": account.get("name"),
        "employeeCountVerified": account.get("employees"),
        "officerRoleQualified": account.get("contactVerified") is True
        and bool(account.get("role")),
        "officerRoleEvidence": {
            "role": account.get("role"),
            "company": account.get("name"),
            "source": account.get("linkedin"),
        },
    }
    if action_id in linkedin:
        existing = linkedin[action_id]
        if existing.get("status") in {
            "scheduled_conditional",
            "held_approval_contact_or_duplicate_gate",
        }:
            existing.update(linkedin_fields)
            if existing.get("status") == "held_approval_contact_or_duplicate_gate":
                existing["status"] = "scheduled_conditional"
    else:
        linkedin[action_id] = {
            "action_id": action_id,
            "accountKey": key,
            "type": "linkedin_connection",
            "status": "scheduled_conditional",
            "dueAt": following_slot(initial, 2, 9, 40).isoformat(),
            **linkedin_fields,
        }


def materialize(reference: datetime | None = None) -> int:
    now = reference or datetime.now(TZ)
    old = keyed_rows(c.REG, "accounts", "key")
    decisions = keyed_rows(DECISIONS, "items", "accountKey")
    accounts = [
        account_row(
            object_row(seed),
            old.get(str(seed["key"]), {}),
            decisions.get(str(seed["key"]), {}),
        )
        for seed in c.accounts()
    ]
    email = keyed_rows(c.EMAILQ, "items", "action_id")
    linkedin = keyed_rows(c.LIQ, "items", "action_id")
    eligible: set[str] = set()
    states: list[Row] = []
    for account in accounts:
        clean = not item_references_duplicate(
            OBJECT.validate_python(account, strict=True)
        )
        active = (
            account["approvedForSequence"] is True
            and account["contactVerified"] is True
            and clean
        )
        if active:
            eligible.add(str(account["key"]))
            seed_actions(account, email, linkedin, now)
        states.append(
            {
                "accountKey": account["key"],
                "wave": account.get("wave"),
                "state": account["state"],
                "researchVerified": account["researchVerified"],
                "contactVerified": account["contactVerified"],
                "approvedForSequence": account["approvedForSequence"],
                "activationEligible": account["contactVerified"] is True and clean,
                "externalOutboundAllowed": active,
                "opportunityAllowed": False,
                "nextResearchDue": task_due(account, now).isoformat(),
            }
        )
    for item in [*email.values(), *linkedin.values()]:
        if (
            item.get("status") == "scheduled_conditional"
            and item.get("accountKey") not in eligible
        ):
            item["status"] = "held_approval_contact_or_duplicate_gate"
    approved = sum(account["approvedForSequence"] is True for account in accounts)
    verified = sum(account["contactVerified"] is True for account in accounts)
    c.save(
        c.REG,
        {
            "generatedAt": c.now(),
            "schemaVersion": "robinswood-flow-account-registry-v2",
            "lane": "robinswood-flow",
            "isolatedFromHdf": True,
            "counts": {
                "accounts": len(accounts),
                "wave1": sum(a.get("wave") == 1 for a in accounts),
                "wave2": sum(a.get("wave") == 2 for a in accounts),
                "approved": approved,
                "contactVerified": verified,
                "opportunitiesAllowed": 0,
            },
            "accounts": accounts,
        },
    )
    c.save(
        c.APPROVAL,
        {
            "generatedAt": c.now(),
            "schemaVersion": "robinswood-flow-approval-queue-v2",
            "items": [
                {
                    "accountKey": a["key"],
                    "accountName": a["name"],
                    "contactVerified": a["contactVerified"],
                    "approvedForSequence": a["approvedForSequence"],
                    "approvalScope": a.get("approvalScope"),
                    "requiredApprovalScope": approval_scope(a),
                    "status": "approved_active"
                    if a["approvedForSequence"] and a["contactVerified"]
                    else "approved_blocked_missing_contact"
                    if a["approvedForSequence"]
                    else "prepare_only_needs_explicit_approval",
                }
                for a in accounts
            ],
        },
    )
    c.save(
        c.EMAILQ,
        {
            "generatedAt": c.now(),
            "schemaVersion": "robinswood-flow-email-action-queue-v2",
            "lane": "robinswood-flow",
            "items": list(email.values()),
        },
    )
    c.save(
        c.LIQ,
        {
            "generatedAt": c.now(),
            "schemaVersion": "robinswood-flow-linkedin-action-queue-v2",
            "lane": "robinswood-flow",
            "items": list(linkedin.values()),
        },
    )
    if not c.REPLY.exists():
        c.save(
            c.REPLY,
            {
                "generatedAt": c.now(),
                "schemaVersion": "robinswood-flow-reply-state-v2",
                "accounts": {},
            },
        )
    c.save(
        STATEQ,
        {
            "generatedAt": c.now(),
            "schemaVersion": "robinswood-flow-account-state-queue-v2",
            "items": states,
        },
    )
    if not DECISIONS.exists():
        c.save(
            DECISIONS,
            {
                "schemaVersion": "robinswood-flow-account-approval-decisions-v1",
                "instructions": "Only explicit human-approved decisions activate a sequence.",
                "items": [],
            },
        )
    return c.report(
        "materializer",
        {
            "counts": {
                "accounts": len(accounts),
                "approved": approved,
                "contactVerified": verified,
                "emailActions": len(email),
                "linkedinActions": len(linkedin),
                "externalSends": 0,
            },
            "nextDue": min(
                (
                    str(item["dueAt"])
                    for item in [*email.values(), *linkedin.values()]
                    if item.get("status") == "scheduled_conditional"
                ),
                default=None,
            ),
            "parameterized": True,
            "approvalDecisions": str(DECISIONS),
        },
        True,
        "parameterized_state_materialized",
    )
