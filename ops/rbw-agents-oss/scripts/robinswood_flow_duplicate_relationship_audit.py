"""Read-only relationship audit using private target mappings and complete scans."""

from __future__ import annotations

import json
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path

import robinswood_flow_core as c
from flow_contact_evidence_state import OBJECT, Row, object_row, object_rows
from flow_duplicate_crm import has_exact_id, ident, list_endpoint
from flow_duplicate_targets import fingerprint, targets
from pydantic import JsonValue, TypeAdapter

JSON: TypeAdapter[JsonValue] = TypeAdapter(JsonValue)

ROOT = Path("/srv/rbw-agents-oss")

OPS = c.OPS

OUT = OPS / "robinswood-flow-duplicate-relationship-audit-last.json"

OUT_MD = OPS / "robinswood-flow-duplicate-relationship-audit-last.md"

SCAN_ENDPOINTS = (
    "/invoices",
    "/estimates",
    "/opportunities",
    "/payments",
    "/contacts",
    "/tasks",
)

ACTIVE_LOCAL_PATHS = (
    c.CRMSTATE,
    c.REG,
    c.APPROVAL,
    c.EMAILQ,
    c.LIQ,
    OPS / "robinswood-flow-contact-evidence-escalation-queue.json",
    OPS / "robinswood-flow-human-action-queue.json",
    OPS / "robinswood-flow-task-due-manager-last.json",
)


def now_iso() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def read_json(path: Path, default: Row | None = None) -> Row:
    if not path.exists():
        return {} if default is None else default
    return dict(OBJECT.validate_json(path.read_bytes(), strict=True))


def write_json(path: Path, data: Row) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp")
    _ = tmp.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    _ = tmp.replace(path)


def marker_present(obj: object) -> bool:
    blob = json.dumps(obj, ensure_ascii=False).lower()
    return "[tech duplicate" in blob or "rbw_flow_technical_duplicate_20260715" in blob


def ids_in_local_active_files(target: int) -> list[str]:
    found: list[str] = []
    for path in ACTIVE_LOCAL_PATHS:
        if path.exists() and has_exact_id(
            JSON.validate_json(path.read_bytes(), strict=True), target
        ):
            found.append(str(path))
    return found


def linked_rows(rows: list[Row], target: int, skip_own_id: bool = False) -> list[int]:
    found: list[int] = []
    for row in rows:
        if skip_own_id and ident(row) == target:
            continue
        if has_exact_id(OBJECT.validate_python(row, strict=True), target):
            value = ident(row)
            if value is not None:
                found.append(int(value))
    return sorted(set(found))


def company_role_links(company_details: dict[int, Row], contact_id: int) -> list[Row]:
    out: list[Row] = []
    for company_id, detail in company_details.items():
        for field in ("main_contact_id", "invoicing_contact_id", "dunning_contact_id"):
            try:
                if int(str(detail.get(field) or 0)) == contact_id:
                    out.append({"companyId": company_id, "field": field})
            except (ValueError, TypeError):
                continue
    return out


def render_md(report: Row) -> str:
    counts = object_row(report.get("counts") or {})
    lines = [
        "# Robinswood Flow — audit relationnel des doublons Sellsy",
        "",
        f"- Generated: {report.get('generatedAt')}",
        f"- Status: **{report.get('status')}**",
        f"- Duplicate companies audited: **{counts.get('duplicateCompanies')}**",
        f"- Duplicate contacts audited: **{counts.get('duplicateContacts')}**",
        f"- False-positive contacts retained: **{counts.get('falsePositiveContacts')}**",
        f"- Archive candidates: **{counts.get('archive_candidate', 0)}**",
        f"- Merge candidates: **{counts.get('merge_candidate', 0)}**",
        f"- Manual review: **{counts.get('manual_review', 0)}**",
        "- Archives applied: **0**",
        "- Hard deletes applied: **0**",
        "",
        "## Decisions",
    ]
    for row in object_rows(report.get("objects") or []):
        lines.append(
            f"- `{row.get('objectType')}:{row.get('duplicateId')}` → `{row.get('classification')}` (canonical `{row.get('canonicalId')}`, links={row.get('linkCount')})"
        )
    lines += [
        "",
        "All archive candidates remain consultative. Explicit human confirmation is required before any archive.",
    ]
    return "\n".join(lines) + "\n"


def selftest() -> Row:
    private_targets = targets()
    company_duplicates = private_targets.companies
    contact_duplicates = private_targets.contacts
    false_positive_contacts = private_targets.falsePositiveContacts
    return {
        "ok": len(company_duplicates) == 13
        and len(contact_duplicates) == 10
        and (len(false_positive_contacts) == 2),
        "companyDuplicates": len(company_duplicates),
        "contactDuplicates": len(contact_duplicates),
        "falsePositiveContacts": len(false_positive_contacts),
        "mutations": 0,
    }


def run(emit: bool = True) -> Row:
    private_targets = targets()
    company_duplicates = private_targets.companies
    contact_duplicates = private_targets.contacts
    false_positive_contacts = private_targets.falsePositiveContacts
    generated = now_iso()
    endpoint_rows: dict[str, list[Row]] = {}
    endpoint_meta: dict[str, Row] = {}
    for endpoint in SCAN_ENDPOINTS:
        endpoint_rows[endpoint], endpoint_meta[endpoint] = list_endpoint(
            endpoint, max_pages=200
        )
    all_company_ids = {value for pair in company_duplicates.values() for value in pair}
    company_details: dict[int, Row] = {}
    detail_errors: list[Row] = []
    for company_id in sorted(all_company_ids):
        try:
            company_details[company_id] = object_row(
                c.crmreq(f"/companies/{company_id}")
            )
        except (OSError, ValueError, TypeError, RuntimeError) as exc:
            detail_errors.append(
                {"objectType": "company", "id": company_id, "error": type(exc).__name__}
            )
    all_contact_ids = (
        set(contact_duplicates)
        | set(false_positive_contacts)
        | {value[1] for value in contact_duplicates.values()}
    )
    contact_details: dict[int, Row] = {}
    contact_company_relations: dict[int, list[int]] = {}
    for contact_id in sorted(all_contact_ids):
        try:
            contact_details[contact_id] = object_row(
                c.crmreq(f"/contacts/{contact_id}")
            )
            related = object_row(c.crmreq(f"/contacts/{contact_id}/companies"))
            contact_company_relations[contact_id] = sorted(
                {
                    identifier
                    for row in object_rows(related.get("data"))
                    if (identifier := ident(row)) is not None
                }
            )
        except (OSError, ValueError, TypeError, RuntimeError) as exc:
            detail_errors.append(
                {"objectType": "contact", "id": contact_id, "error": type(exc).__name__}
            )
    objects: list[Row] = []
    for account, (duplicate_id, canonical_id) in company_duplicates.items():
        links = {
            endpoint.lstrip("/"): linked_rows(endpoint_rows[endpoint], duplicate_id)
            for endpoint in SCAN_ENDPOINTS
        }
        active_refs = ids_in_local_active_files(duplicate_id)
        link_count = sum(len(values) for values in links.values()) + len(active_refs)
        detail = company_details.get(duplicate_id) or {}
        canonical = company_details.get(canonical_id) or {}
        business_docs = sum(
            len(links[key])
            for key in ("invoices", "estimates", "opportunities", "payments")
        )
        operational_links = (
            len(links["contacts"]) + len(links["tasks"]) + len(active_refs)
        )
        if (
            not canonical
            or not marker_present(detail)
            or (not all(meta.get("complete") for meta in endpoint_meta.values()))
        ) or business_docs:
            classification = "manual_review"
        elif operational_links:
            classification = "merge_candidate"
        else:
            classification = "archive_candidate"
        objects.append(
            {
                "objectType": "company",
                "accountKey": account,
                "duplicateId": duplicate_id,
                "canonicalId": canonical_id,
                "duplicateExists": bool(detail),
                "canonicalExists": bool(canonical),
                "markerPresent": marker_present(detail),
                "links": links,
                "activeLocalReferences": active_refs,
                "linkCount": link_count,
                "businessDocumentLinkCount": business_docs,
                "classification": classification,
                "archiveApplied": False,
                "hardDeleteApplied": False,
            }
        )
    for duplicate_id, (account, canonical_id) in contact_duplicates.items():
        links = {
            endpoint.lstrip("/"): linked_rows(
                endpoint_rows[endpoint],
                duplicate_id,
                skip_own_id=False,
            )
            for endpoint in SCAN_ENDPOINTS
            if endpoint != "/contacts"
        }
        company_relations = contact_company_relations.get(duplicate_id) or []
        roles = company_role_links(company_details, duplicate_id)
        active_refs = ids_in_local_active_files(duplicate_id)
        detail = contact_details.get(duplicate_id) or {}
        canonical = contact_details.get(canonical_id) or {}
        business_docs = sum(
            len(links.get(key, []))
            for key in ("invoices", "estimates", "opportunities", "payments")
        )
        operational_links = (
            len(links.get("tasks", []))
            + len(company_relations)
            + len(roles)
            + len(active_refs)
        )
        if (
            not canonical
            or not marker_present(detail)
            or (not all(meta.get("complete") for meta in endpoint_meta.values()))
        ) or business_docs:
            classification = "manual_review"
        elif operational_links:
            classification = "merge_candidate"
        else:
            classification = "archive_candidate"
        objects.append(
            {
                "objectType": "contact",
                "accountKey": account,
                "duplicateId": duplicate_id,
                "canonicalId": canonical_id,
                "duplicateExists": bool(detail),
                "canonicalExists": bool(canonical),
                "markerPresent": marker_present(detail),
                "links": links,
                "companyRelations": company_relations,
                "companyRoleLinks": roles,
                "activeLocalReferences": active_refs,
                "linkCount": business_docs + operational_links,
                "businessDocumentLinkCount": business_docs,
                "classification": classification,
                "archiveApplied": False,
                "hardDeleteApplied": False,
            }
        )
    for contact_id, account in false_positive_contacts.items():
        detail = contact_details.get(contact_id) or {}
        objects.append(
            {
                "objectType": "contact_false_positive",
                "accountKey": account,
                "duplicateId": contact_id,
                "canonicalId": None,
                "duplicateExists": bool(detail),
                "canonicalExists": None,
                "markerPresent": marker_present(detail),
                "links": {},
                "activeLocalReferences": ids_in_local_active_files(contact_id),
                "linkCount": 0,
                "classification": "keep",
                "reason": "previously verified as false positive; not an archive candidate",
                "archiveApplied": False,
                "hardDeleteApplied": False,
            }
        )
    scans_complete = all(
        meta.get("complete") is True for meta in endpoint_meta.values()
    )
    if not scans_complete or detail_errors:
        for row in objects:
            if row.get("classification") != "keep":
                row["classification"] = "manual_review"
    classes = Counter(str(row.get("classification")) for row in objects)
    expected_count = (
        len(company_duplicates) + len(contact_duplicates) + len(false_positive_contacts)
    )
    ok = scans_complete and not detail_errors and len(objects) == expected_count
    counts = {
        "objects": len(objects),
        "duplicateCompanies": len(company_duplicates),
        "duplicateContacts": len(contact_duplicates),
        "falsePositiveContacts": len(false_positive_contacts),
        **dict(classes),
        "endpointScansComplete": sum(
            1 for meta in endpoint_meta.values() if meta.get("complete")
        ),
        "endpointScans": len(endpoint_meta),
        "hardDeletes": 0,
        "archives": 0,
        "externalSends": 0,
        "crmMutations": 0,
        "errors": len(detail_errors),
    }
    report: Row = {
        "generatedAt": generated,
        "targetFingerprint": fingerprint(private_targets),
        "contractVersion": "robinswood-flow-duplicate-relationship-audit-v1-read-only",
        "capabilityId": "robinswood-flow-duplicate-relationship-audit",
        "ok": ok,
        "impactOk": ok
        and not any(row.get("businessDocumentLinkCount") for row in objects),
        "status": "audited_read_only" if ok else "audit_incomplete",
        "summary": f"duplicate_relationship_audit: objects={len(objects)} archiveCandidates={classes.get('archive_candidate', 0)} mergeCandidates={classes.get('merge_candidate', 0)} manualReview={classes.get('manual_review', 0)} errors={len(detail_errors)}",
        "counts": counts,
        "endpointScans": endpoint_meta,
        "objects": objects,
        "errors": detail_errors,
        "checks": {
            "readOnly": True,
            "allEndpointsComplete": scans_complete,
            "hardDeleteForbidden": True,
            "automaticArchiveForbidden": True,
            "explicitHumanConfirmationRequiredBeforeArchive": True,
            "historicalExpectedTenDuplicatesCorrectedByEvidence": len(
                contact_duplicates
            )
            == 10
            and scans_complete,
            "actualTrueDuplicates": len(company_duplicates) + len(contact_duplicates),
            "falsePositiveContactsPreserved": len(false_positive_contacts),
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
        "blockingReasons": [] if ok else ["duplicate_relationship_audit_incomplete"],
        "warningReasons": []
        if report_warning_count(objects) == 0
        else ["duplicate_objects_require_human_disposition_review"],
        "artifacts": {"reportJson": str(OUT), "reportMd": str(OUT_MD)},
        "externalEffects": {
            "sellsyReads": True,
            "sellsyWrites": 0,
            "gmailSends": 0,
            "archives": 0,
            "hardDeletes": 0,
        },
    }
    write_json(OUT, report)
    _ = OUT_MD.write_text(render_md(report), encoding="utf-8")
    if emit:
        print(
            json.dumps(
                {
                    "ok": ok,
                    "status": report["status"],
                    "counts": counts,
                    "reportJson": str(OUT),
                },
                ensure_ascii=False,
            )
        )
    return report


def report_warning_count(objects: list[Row]) -> int:
    return sum(
        1
        for row in objects
        if row.get("classification") in {"merge_candidate", "manual_review"}
    )


def main() -> int:
    return 0 if run().get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
