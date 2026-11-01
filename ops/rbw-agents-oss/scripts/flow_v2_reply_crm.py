"""Idempotent CRM follow-up from classified replies; no sends or contact creation."""

from __future__ import annotations

import os
from datetime import datetime, timedelta

import robinswood_flow_core as c
from flow_contact_evidence_state import OBJECT, Row, object_row
from flow_duplicate_crm import has_exact_id, ident, list_endpoint
from flow_v2_rules import TZ
from sellsy_technical_duplicate_guard import is_technical_duplicate

REPLY_CRM = c.OPS / "robinswood-flow-reply-crm-state.json"
OPP_STATE = c.OPS / "robinswood-flow-qualified-opportunity-state.json"


def crm_action_plan(account: Row, received: Row, classification: str) -> Row:
    conversation = c.stable("conversation", received.get("threadId"))
    action = c.stable("flow-reply-action", account["key"], received.get("messageId"))
    return {
        "taskMarker": "rbw-flow:reply-action:" + action,
        "opportunityMarker": "rbw-flow:qualified-opportunity:"
        + str(account["key"])
        + ":"
        + conversation,
        "conversation_id": conversation,
        "createTask": classification in {"positive", "referral", "ambiguous"},
        "createOpportunity": classification in {"positive", "referral"},
        "createReferralContact": False,
        "referralApprovalRequired": classification == "referral",
    }


def environment_identifier(*names: str) -> int:
    for name in names:
        value = os.environ.get(name)
        if value is not None:
            result = ident({"id": value})
            if result is None:
                raise ValueError("invalid_crm_assignment_identifier")
            return result
    raise ValueError("missing_crm_assignment_identifier")


def complete_list(endpoint: str) -> list[Row]:
    rows, metadata = list_endpoint(endpoint)
    if metadata.get("complete") is not True:
        raise RuntimeError("incomplete_crm_lookup")
    return rows


def marker_present(row: Row, marker: str) -> bool:
    return marker in str(row.get("description") or "") or marker in str(
        row.get("note") or ""
    )


def ensure_record(
    endpoint: str, marker: str, company: int, body: Row, state: Row
) -> int:
    records = object_row(state.get("records") or {})
    attempts = object_row(state.get("attempts") or {})
    identifier = ident({"id": records.get(marker)})
    if identifier is None:
        found = [row for row in complete_list(endpoint) if marker_present(row, marker)]
        if len(found) > 1:
            raise RuntimeError("duplicate_reply_crm_marker")
        identifier = ident(found[0]) if found else None
    if identifier is None:
        if attempts.get(marker) == "started":
            raise RuntimeError("previous_crm_create_outcome_unknown")
        attempts[marker] = "started"
        state["attempts"] = attempts
        c.save(
            REPLY_CRM, state
        )  # Persist intent before transport; never blindly recreate after timeout.
        created = c.crmreq(endpoint, "POST", OBJECT.validate_python(body, strict=True))
        identifier = ident(created)
        if identifier is None:
            raise RuntimeError("crm_create_identifier_missing")
    row = object_row(c.crmreq(f"{endpoint}/{identifier}"))
    if (
        ident(row) != identifier
        or not marker_present(row, marker)
        or not has_exact_id(OBJECT.validate_python(row, strict=True), company)
    ):
        raise RuntimeError("reply_crm_readback_failed")
    if is_technical_duplicate(OBJECT.validate_python(row, strict=True)):
        raise RuntimeError("technical_duplicate_crm_readback")
    records[marker] = identifier
    attempts[marker] = "verified"
    state.update({"records": records, "attempts": attempts, "updatedAt": c.now()})
    c.save(REPLY_CRM, state)
    return identifier


def pipeline_step() -> tuple[int, int]:
    pipelines = complete_list("/opportunities/pipelines")
    selected = next(
        (row for row in pipelines if row.get("is_default") is True),
        pipelines[0] if pipelines else None,
    )
    pipeline = ident(selected)
    if pipeline is None:
        raise RuntimeError("sellsy_opportunity_pipeline_missing")
    steps = complete_list(f"/opportunities/pipelines/{pipeline}/steps")
    ranked: list[tuple[int, int]] = []
    for row in steps:
        rank = row.get("rank")
        identifier = ident(row)
        if isinstance(rank, bool) or not isinstance(rank, int) or identifier is None:
            raise RuntimeError("sellsy_opportunity_step_invalid")
        ranked.append((rank, identifier))
    if not ranked:
        raise RuntimeError("sellsy_opportunity_step_missing")
    return pipeline, min(ranked)[1]


def crm_action_for_signal(
    account: Row, received: Row, classification: str, dry_run: bool = False
) -> Row:
    if not received.get("threadId") or not received.get("messageId"):
        raise ValueError("reply_message_identity_missing")
    plan = crm_action_plan(account, received, classification)
    if dry_run:
        return {
            **plan,
            "dryRun": True,
            "taskCreates": int(plan["createTask"] is True),
            "opportunityCreates": int(plan["createOpportunity"] is True),
        }
    company = ident({"id": account.get("sellsyCompanyId")})
    contact = ident({"id": account.get("sellsyContactId")})
    if (
        company is None
        or is_technical_duplicate({"id": company})
        or (contact is not None and is_technical_duplicate({"id": contact}))
    ):
        raise RuntimeError("missing_or_duplicate_canonical_crm_relation")
    state = object_row(c.load(REPLY_CRM, {}))
    # Migrate the original cache without discarding its idempotency evidence.
    previous_tasks = object_row(state.get("tasks") or {})
    previous_opportunities = object_row(
        c.load(OPP_STATE, {}).get("opportunities") or {}
    )
    state["records"] = {
        **previous_tasks,
        **previous_opportunities,
        **object_row(state.get("records") or {}),
    }
    result: Row = {**plan, "taskId": None, "opportunityId": None}
    staff = environment_identifier("SELLSY_DEFAULT_STAFF_ID")
    company_relation: Row = {"type": "company", "id": company}
    now = datetime.now(TZ)
    if plan["createTask"]:
        marker = str(plan["taskMarker"])
        body: Row = {
            "title": f"[Flow reply] {classification} — {account['name']}",
            "status": "todo",
            "is_private": False,
            "due_date": (now + timedelta(minutes=30))
            .replace(second=0, microsecond=0)
            .isoformat(),
            "label_id": environment_identifier(
                "SELLSY_PROSPECT_TASK_LABEL_ID", "SELLSY_TASK_DEFAULT_LABEL_ID"
            ),
            "assigned_staff_ids": [staff],
            "priority": 1 if classification in {"positive", "referral"} else 0,
            "description": f"Inbound Flow reply classification: {classification}\nMessage: {received['messageId']}\nLead: {account.get('lead_id')}\nConversation: {plan['conversation_id']}\nIdempotency marker: {marker}\nHuman commercial judgment required.",
            "related": [company_relation],
        }
        result["taskId"] = ensure_record("/tasks", marker, company, body, state)
        tasks = object_row(state.get("tasks") or {})
        tasks[marker] = result["taskId"]
        state["tasks"] = tasks
        c.save(REPLY_CRM, state)
    if plan["createOpportunity"]:
        marker = str(plan["opportunityMarker"])
        pipeline, step = pipeline_step()
        body = {
            "name": f"Flow qualified conversation — {account['name']}",
            "pipeline": pipeline,
            "step": step,
            "status": "open",
            "amount": "0",
            "probability": 10,
            "due_date": (now + timedelta(days=14)).date().isoformat(),
            "note": f"Qualified Flow inbound signal ({classification}).\nLead: {account.get('lead_id')}\nConversation: {plan['conversation_id']}\nMessage: {received['messageId']}\nIdempotency marker: {marker}\nAmount remains 0 pending human budget qualification.",
            "assigned_staff_ids": [staff],
            "contact_ids": [contact] if contact is not None else [],
            "related": [company_relation],
        }
        result["opportunityId"] = ensure_record(
            "/opportunities", marker, company, body, state
        )
        previous_opportunities[marker] = result["opportunityId"]
        c.save(
            OPP_STATE, {"updatedAt": c.now(), "opportunities": previous_opportunities}
        )
        crm = object_row(c.load(c.CRMSTATE, {}))
        identifiers = {
            ident({"id": value}) for value in previous_opportunities.values()
        }
        if None in identifiers:
            raise RuntimeError("invalid_opportunity_cache_identifier")
        crm["opportunitiesCreated"] = len(identifiers)
        c.save(c.CRMSTATE, crm)
    return result
