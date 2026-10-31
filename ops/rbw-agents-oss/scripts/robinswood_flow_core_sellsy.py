from __future__ import annotations

import fcntl
import re
import sys
import time
from urllib.parse import quote

from pydantic import JsonValue
from sellsy_technical_duplicate_guard import filter_canonical

if __package__:
    from .robinswood_flow_core_support import (
        CRMSTATE,
        JSON_ADAPTER,
        LIQ,
        OPS,
        REG,
        ROOT,
        JsonObject,
        account_key,
        id_value,
        load,
        localnow,
        now,
        object_value,
        optional_object,
        private_text,
        profile,
        report,
        required_text,
        rows_value,
        save,
        text_value,
        validated_object,
        values,
    )
else:
    from robinswood_flow_core_support import (
        CRMSTATE,
        JSON_ADAPTER,
        LIQ,
        OPS,
        REG,
        ROOT,
        JsonObject,
        account_key,
        id_value,
        load,
        localnow,
        now,
        object_value,
        optional_object,
        private_text,
        profile,
        report,
        required_text,
        rows_value,
        save,
        text_value,
        validated_object,
        values,
    )


def crmreq(
    endpoint: str, method: str = "GET", body: JsonObject | None = None
) -> JsonObject:
    _ = profile()
    sys.path.insert(0, str(ROOT / "scripts"))
    from rubypayeur_recouvrement_queue import sellsy_request

    last: Exception | None = None
    for attempt in range(7):
        try:
            if attempt:
                _ = time.sleep(min(40, 3 * attempt * attempt))
            response: object = sellsy_request(endpoint, method=method, body=body)
            return validated_object(response, "sellsy_response_invalid")
        except (OSError, RuntimeError, TypeError, ValueError) as error:
            last = error
            if "429" not in str(error) and "quota per minute" not in str(error).lower():
                raise
    if last is None:
        raise RuntimeError("sellsy_request_failed_without_error")
    raise last


def deepid(value: JsonValue) -> str | int | None:
    if isinstance(value, dict):
        obj = object_value(value, "nested_json_object_invalid")
        candidate = id_value(obj.get("id"))
        if candidate is not None:
            return candidate
        for child in obj.values():
            result = deepid(child)
            if result is not None:
                return result
    elif isinstance(value, list):
        for child in value:
            result = deepid(child)
            if result is not None:
                return result
    return None


def norm(x: object) -> str:
    return re.sub(r"[^a-z0-9]", "", str(x or "").lower())


def listall(ep: str, maxp: int = 20) -> list[JsonObject]:
    _ = profile()
    out: list[JsonObject] = []
    offset: str | None = None
    seen: set[str] = set()
    total: int | None = None
    pages = 0
    hard_pages = max(maxp or 20, 200)
    separator = "&" if "?" in ep else "?"
    while pages < hard_pages:
        suffix = f"&offset={quote(offset, safe='')}" if offset else ""
        page = crmreq(f"{ep}{separator}limit=100{suffix}")
        items = rows_value(page.get("items"), "sellsy_page_items_invalid")
        pagination = optional_object(
            page.get("pagination"), "sellsy_pagination_invalid"
        )
        pages += 1
        total_value = pagination.get("total")
        if total_value is not None:
            if (
                isinstance(total_value, bool)
                or not isinstance(total_value, int)
                or total_value < 0
            ):
                raise RuntimeError("sellsy_pagination_total_invalid")
            if total is not None and total_value != total:
                raise RuntimeError("sellsy_pagination_total_changed")
            total = total_value
        out.extend(items)
        if total is not None and len(out) > total:
            raise RuntimeError("sellsy_pagination_total_exceeded")
        if not items or len(items) < 100 or (total is not None and len(out) >= total):
            break
        next_offset = pagination.get("offset")
        cursor = str(next_offset or "")
        if not cursor or cursor in seen:
            raise RuntimeError(
                f"sellsy_cursor_pagination_incomplete:{ep}:rows={len(out)}:total={total}:page={pages}"
            )
        seen.add(cursor)
        offset = cursor
    else:
        raise RuntimeError(
            f"sellsy_cursor_pagination_hard_limit:{ep}:rows={len(out)}:total={total}:pages={pages}"
        )
    if total is not None and len(out) < total:
        raise RuntimeError(
            f"sellsy_cursor_pagination_short_read:{ep}:rows={len(out)}:total={total}"
        )
    return out


def sync_unlocked() -> int:
    _ = profile()
    registry = load(REG, {})
    account_rows = rows_value(registry.get("accounts"), "account_rows_invalid")
    if len(account_rows) != 13:
        return report(
            "sellsy-sync",
            {
                "counts": {"accounts": len(account_rows)},
                "blockingReasons": ["registry_not_materialized"],
            },
            False,
            "blocked",
        )
    state_default = validated_object(
        {
            "schemaVersion": "robinswood-flow-sellsy-sync-state-v1",
            "companies": {},
            "contacts": {},
            "tasks": {},
        },
        "crm_state_default_invalid",
    )
    state = load(CRMSTATE, state_default)
    companies_state = optional_object(
        state.get("companies"), "crm_company_state_invalid"
    )
    contacts_state = optional_object(state.get("contacts"), "crm_contact_state_invalid")
    tasks_state = optional_object(state.get("tasks"), "crm_task_state_invalid")
    need_companies = any(
        not companies_state.get(
            required_text(account.get("key"), "account_key_invalid")
        )
        for account in account_rows
    )
    need_contacts = any(
        bool(
            account.get("contactVerified")
            and account.get("email")
            and not contacts_state.get(
                required_text(account.get("key"), "account_key_invalid")
            )
        )
        for account in account_rows
    )
    companies: list[JsonObject] = []
    contacts: list[JsonObject] = []
    if need_companies:
        filtered: object = filter_canonical(listall("/companies", 100))
        companies = rows_value(
            JSON_ADAPTER.validate_python(filtered), "sellsy_company_rows_invalid"
        )
    if need_contacts:
        filtered_contacts: object = filter_canonical(listall("/contacts", 100))
        contacts = rows_value(
            JSON_ADAPTER.validate_python(filtered_contacts),
            "sellsy_contact_rows_invalid",
        )
    companies_by_name: dict[str, str | int] = {}
    for company in companies:
        company_id = deepid(company)
        if company_id is not None:
            companies_by_name[norm(company.get("name") or company.get("full_name"))] = (
                company_id
            )
    contacts_by_email: dict[str, str | int] = {}
    for contact in contacts:
        contact_id = deepid(contact)
        email = text_value(contact.get("email")).lower()
        if email and contact_id is not None:
            contacts_by_email[email] = contact_id
    created: dict[str, int] = {"companies": 0, "contacts": 0, "tasks": 0}
    errors: list[str] = []
    readbacks: list[JsonObject] = []
    for account in account_rows:
        key = required_text(account.get("key"), "account_key_invalid")
        company_id = id_value(companies_state.get(key))
        if company_id is None:
            names = [
                account.get("legalName"),
                account.get("name"),
                *values(account.get("aliases"), "account_aliases_invalid"),
            ]
            for candidate in names:
                normalized = norm(candidate)
                if normalized and normalized in companies_by_name:
                    company_id = companies_by_name[normalized]
                    break
        if company_id is None:
            note = "\n".join(
                [
                    f"Robinswood Flow research record — marker rbw-flow:account:{key}",
                    f"Campaign: {text_value(account.get('campaign_id'))}",
                    f"Website: {text_value(account.get('domain'))}",
                    "Research record only; no opportunity created.",
                ]
            )
            company_payload = validated_object(
                {
                    "name": text_value(account.get("legalName"))
                    or required_text(account.get("name"), "account_name_missing"),
                    "type": "prospect",
                    "note": note[:1800],
                    "website": private_text("text_058"),
                    "custom_fields": {private_text("text_060"): key},
                },
                "sellsy_company_payload_invalid",
            )
            try:
                company_id = deepid(crmreq("/companies", "POST", company_payload))
                created["companies"] += 1
            except (OSError, RuntimeError, TypeError, ValueError):
                try:
                    _ = company_payload.pop("website", None)
                    company_id = deepid(crmreq("/companies", "POST", company_payload))
                    created["companies"] += 1
                except (OSError, RuntimeError, TypeError, ValueError) as error:
                    errors.append(f"company:{key}:{error}")
                    continue
        if company_id is None:
            errors.append(f"company:{key}:missing_id")
            continue
        companies_state[key] = company_id
        account["sellsyCompanyId"] = company_id
        contact_id = id_value(contacts_state.get(key))
        email = text_value(account.get("email"))
        if account.get("contactVerified") and email:
            contact_id = contact_id or contacts_by_email.get(email.lower())
            if contact_id is None:
                sponsor = required_text(account.get("sponsor"), "sponsor_name_missing")
                name_parts = sponsor.split()
                contact_payload = validated_object(
                    {
                        "first_name": name_parts[0],
                        "last_name": " ".join(name_parts[1:]) or "Prospect",
                        "email": email,
                        "company_id": int(company_id),
                    },
                    "sellsy_contact_payload_invalid",
                )
                try:
                    contact_id = deepid(crmreq("/contacts", "POST", contact_payload))
                    created["contacts"] += 1
                except (OSError, RuntimeError, TypeError, ValueError):
                    try:
                        _ = contact_payload.pop("company_id", None)
                        contact_id = deepid(
                            crmreq("/contacts", "POST", contact_payload)
                        )
                        created["contacts"] += 1
                    except (OSError, RuntimeError, TypeError, ValueError) as error:
                        errors.append(f"contact:{key}:{error}")
            if contact_id is not None:
                contacts_state[key] = contact_id
                account["sellsyContactId"] = contact_id
                try:
                    _ = crmreq(
                        f"/companies/{company_id}/contacts/{contact_id}",
                        "POST",
                        validated_object({"roles": []}, "sellsy_link_payload_invalid"),
                    )
                except (OSError, RuntimeError, TypeError, ValueError) as error:
                    errors.append(f"contact_company_link:{key}:{error}")
        marker = f"rbw-flow:task:research:{key}"
        task_id = id_value(tasks_state.get(marker))
        if task_id is None:
            description = f"Flow research/contact record. Marker: {marker}\nState: {text_value(account.get('state'))}\nScore: {text_value(account.get('score'))}\nSponsor: {text_value(account.get('sponsor'))}\nNo opportunity; no sequence authorization."
            task_payload = validated_object(
                {
                    "title": f"[Flow] Research record — {required_text(account.get('name'), 'account_name_missing')}",
                    "status": "todo",
                    "is_private": False,
                    "due_date": localnow().date().isoformat(),
                    "description": description[:1800],
                    "company_id": int(company_id),
                    "custom_fields": {private_text("text_060"): key},
                },
                "sellsy_task_payload_invalid",
            )
            try:
                task_id = deepid(crmreq("/tasks", "POST", task_payload))
                if task_id is not None:
                    tasks_state[marker] = task_id
                    created["tasks"] += 1
            except (OSError, RuntimeError, TypeError, ValueError) as error:
                errors.append(f"task:{key}:{error}")
        account["sellsyTaskId"] = task_id
        try:
            readback: JsonObject = {"company": crmreq(f"/companies/{company_id}")}
            if contact_id is not None:
                readback["contact"] = crmreq(f"/contacts/{contact_id}")
            if task_id is not None:
                readback["task"] = crmreq(f"/tasks/{task_id}")
            readbacks.append(
                {
                    "key": key,
                    "companyId": company_id,
                    "contactId": contact_id,
                    "taskId": task_id,
                    "companyReadbackId": deepid(readback["company"]),
                }
            )
        except (OSError, RuntimeError, TypeError, ValueError) as error:
            errors.append(f"readback:{key}:{error}")
    registry["accounts"] = JSON_ADAPTER.validate_python(account_rows)
    registry["generatedAt"] = now()
    save(REG, registry)
    state["companies"] = companies_state
    state["contacts"] = contacts_state
    state["tasks"] = tasks_state
    state["updatedAt"] = now()
    state["readbacks"] = JSON_ADAPTER.validate_python(readbacks)
    state["opportunitiesCreated"] = 0
    save(CRMSTATE, state)
    approved = next(
        (account for account in account_rows if account.get("key") == account_key()),
        None,
    )
    if approved is None:
        raise RuntimeError("approved_account_missing")
    linkedin_queue = load(LIQ, {})
    linkedin_items = rows_value(
        linkedin_queue.get("items"), "linkedin_queue_items_invalid"
    )
    if not linkedin_items:
        raise RuntimeError("linkedin_queue_empty")
    linkedin_items[0]["sellsyCompanyId"] = approved.get("sellsyCompanyId")
    linkedin_items[0]["sellsyContactId"] = approved.get("sellsyContactId")
    linkedin_queue["items"] = JSON_ADAPTER.validate_python(linkedin_items)
    save(LIQ, linkedin_queue)
    return report(
        "sellsy-sync",
        {
            "counts": {
                "companiesMaterialized": len(companies_state),
                "contactsMaterialized": len(contacts_state),
                "tasksMaterialized": len(tasks_state),
                "opportunitiesCreated": 0,
                **created,
            },
            "errors": errors,
            "readbacks": readbacks,
            "dataWritesEnabled": True,
            "duplicatesFiltered": len(companies) + len(contacts),
        },
    )


def sellsy_sync() -> int:
    _ = profile()
    lock_path = OPS / private_text("text_012")
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    fh = lock_path.open("a+")
    try:
        try:
            fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return report(
                "sellsy-sync",
                {
                    "counts": {"skippedConcurrent": 1, "opportunitiesCreated": 0},
                    "lockPath": str(lock_path),
                },
                True,
                "skipped_concurrent_lock",
            )
        return sync_unlocked()
    finally:
        try:
            fcntl.flock(fh.fileno(), fcntl.LOCK_UN)
        except (OSError, RuntimeError, TypeError, ValueError):
            pass
        fh.close()


__all__ = ["sellsy_sync", "sync_unlocked"]
