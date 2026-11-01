"""Validated enrichment rules and bounded provider adapters for media contacts."""

from __future__ import annotations

import os
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import cast
from urllib.parse import urlparse

import requests
from pydantic import ValidationError
from robinswood_media_contact_enrichment_types import (
    JSON_VALUE_ADAPTER,
    EmailVerificationResult,
    EnrichedCandidate,
    ExternalLink,
    HttpParams,
    JsonObject,
    JsonValue,
    ProfileEnrichment,
    WikiEnrichment,
)

ENV = Path("/srv/rbw-agents-oss/compose/.env")
UA = "Robinswood-OSS-Media-Contact-Enrichment/1.0 prepare-only no-outbound"
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
EXCLUDED_DOMAINS = {
    "babelio.com",
    "bnf.fr",
    "data.bnf.fr",
    "facebook.com",
    "google.com",
    "imdb.com",
    "instagram.com",
    "linkedin.com",
    "twitter.com",
    "wikipedia.org",
    "worldcat.org",
    "viaf.org",
    "x.com",
    "youtube.com",
    "wikimedia.org",
}
WEBMAIL = {
    "free.fr",
    "gmail.com",
    "hotmail.com",
    "icloud.com",
    "orange.fr",
    "outlook.com",
    "proton.me",
    "protonmail.com",
    "wanadoo.fr",
    "yahoo.com",
}

__all__ = [
    "EMAIL_RE",
    "ENV",
    "EXCLUDED_DOMAINS",
    "UA",
    "WEBMAIL",
    "as_candidate",
    "as_candidates",
    "as_object",
    "csv_cell",
    "domain_allowed",
    "domain_from_url",
    "eligible_for_processing",
    "email_domain",
    "email_finder",
    "hunter",
    "hunter_key",
    "norm",
    "norm_email",
    "now",
    "row_outcome",
    "split_name",
    "verify_email",
    "wiki_enrich",
]


def now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def norm(value: object) -> str:
    return str(value or "").strip()


def norm_email(value: object) -> str:
    return norm(value).lower()


def as_object(value: JsonValue) -> JsonObject:
    return value if isinstance(value, dict) else {}


def domain_from_url(url: str) -> str:
    try:
        domain = urlparse(url).netloc.lower().split(":")[0]
        return domain.removeprefix("www.")
    except ValueError:
        return ""


def email_domain(email: str) -> str:
    return norm_email(email).split("@")[-1] if "@" in norm_email(email) else ""


def domain_allowed(domain: str | None) -> bool:
    normalized = (domain or "").lower()
    if not normalized or normalized in WEBMAIL:
        return False
    return not any(
        normalized == blocked or normalized.endswith("." + blocked)
        for blocked in EXCLUDED_DOMAINS
    )


def split_name(name: str | None) -> tuple[str | None, str | None]:
    normalized = re.sub(r"\s+", " ", re.sub(r"\([^)]*\)", " ", name or "")).strip()
    parts = [
        part for part in normalized.split(" ") if part and not part.startswith("Q")
    ]
    return (parts[0], parts[-1]) if len(parts) >= 2 else (None, None)


def hunter_key() -> str | None:
    key = os.getenv("HUNTER_API_KEY")
    if key:
        return key
    if ENV.exists():
        for line in ENV.read_text(encoding="utf-8", errors="ignore").splitlines():
            if line.startswith("HUNTER_API_KEY="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    return None


def hunter(path: str, params: HttpParams, timeout: int = 7) -> JsonObject:
    try:
        response = requests.get(
            "https://api.hunter.io/v2/" + path,
            params=params,
            headers={"User-Agent": UA},
            timeout=timeout,
        )
        try:
            body: JsonValue = JSON_VALUE_ADAPTER.validate_python(
                cast(object, response.json())
            )
        except (ValueError, TypeError, ValidationError):
            body = {"raw": response.text[:500]}
        return {
            "ok": response.status_code < 400,
            "statusCode": response.status_code,
            "body": body,
        }
    except requests.RequestException as error:
        return {
            "ok": False,
            "statusCode": None,
            "body": {"error": type(error).__name__, "message": str(error)[:300]},
        }


def verify_email(key: str, email: str) -> JsonObject:
    return hunter("email-verifier", {"email": email, "api_key": key}, timeout=7)


def email_finder(key: str, domain: str, first: str, last: str) -> JsonObject:
    return hunter(
        "email-finder",
        {"domain": domain, "first_name": first, "last_name": last, "api_key": key},
        timeout=8,
    )


def wiki_enrich(title: str) -> WikiEnrichment:
    try:
        response = requests.get(
            "https://fr.wikipedia.org/w/api.php",
            params={
                "action": "query",
                "format": "json",
                "prop": "extracts|extlinks",
                "explaintext": "1",
                "exintro": "1",
                "ellimit": "20",
                "titles": title,
            },
            headers={"User-Agent": UA},
            timeout=8,
        )
        response.raise_for_status()
        payload: JsonValue = JSON_VALUE_ADAPTER.validate_python(
            cast(object, response.json())
        )
        query = as_object(as_object(payload).get("query", {}))
        pages = as_object(query.get("pages", {}))
        page_value: JsonValue = next(iter(pages.values()), None)
        page = as_object(page_value)
        extract_value = page.get("extract", "")
        extract = norm(extract_value)[:1200]
        raw_links = page.get("extlinks", [])
        links: list[ExternalLink] = []
        if isinstance(raw_links, list):
            for value in raw_links:
                link = as_object(value)
                url_value = link.get("*") or link.get("url") or ""
                if not isinstance(url_value, str):
                    continue
                domain = domain_from_url(url_value)
                if domain and domain_allowed(domain):
                    links.append({"url": url_value, "domain": domain})
        seen: set[str] = set()
        unique_links: list[ExternalLink] = []
        for link in links:
            if link["domain"] not in seen:
                seen.add(link["domain"])
                unique_links.append(link)
        return {"ok": True, "extract": extract, "externalLinks": unique_links[:8]}
    except (requests.RequestException, ValueError, TypeError, ValidationError) as error:
        return {
            "ok": False,
            "error": str(error)[:300],
            "extract": "",
            "externalLinks": [],
        }


def eligible_for_processing(row: EnrichedCandidate) -> bool:
    outreach_status = row.get("outreachStatus")
    if isinstance(outreach_status, str) and outreach_status in {
        "not_eligible_legacy_pr_hold",
        "not_eligible_suppressed",
        "not_eligible_bounced",
        "not_eligible_weak_generic",
    }:
        return False
    if row.get("recordType") == "email_contact" and row.get("email"):
        verification = row.get("emailVerification", {})
        checked = verification.get("checkedAt")
        if checked:
            if not isinstance(checked, str):
                return False
            try:
                elapsed = (
                    datetime.now(UTC) - datetime.fromisoformat(checked)
                ).total_seconds()
                return elapsed >= 7 * 86400
            except ValueError:
                return False
        return True
    enrichment_status = row.get("enrichmentStatus")
    return not (
        isinstance(enrichment_status, str)
        and enrichment_status
        in {
            "verified_email_found_review_required",
            "email_verified_review_required",
            "profile_context_enriched",
            "no_public_email_found_yet",
        }
    )


def row_outcome(
    row: EnrichedCandidate, key: str | None, hunter_left: int
) -> tuple[EnrichedCandidate, int, JsonObject]:
    timestamp = now()
    work: EnrichedCandidate = {}
    for key_name, value in row.items():
        work[key_name] = value
    event: JsonObject = {
        "id": row.get("id"),
        "recordType": row.get("recordType"),
        "contactName": row.get("contactName"),
        "startedAt": timestamp,
        "hunterCalls": 0,
        "status": "processed",
    }
    work["enrichedAt"] = timestamp
    work["outreachEligible"] = False
    record_type = row.get("recordType")
    email_value = row.get("email")
    if record_type == "email_contact" and isinstance(email_value, str) and email_value:
        if key and hunter_left > 0:
            verification = verify_email(key, email_value)
            event["hunterCalls"] = 1
            hunter_left -= 1
            response_body = as_object(verification.get("body", {}))
            data = as_object(response_body.get("data", {}))
            result_value = data.get("result", data.get("status", ""))
            result = norm(result_value).lower()
            score = data.get("score")
            status_code = verification.get("statusCode")
            smtp_check = data.get("smtp_check")
            accept_all = data.get("accept_all")
            blocked = data.get("block")
            mx_records = data.get("mx_records")
            verification_record: EmailVerificationResult = {
                "provider": "hunter",
                "result": result,
                "statusCode": status_code if isinstance(status_code, int) else None,
                "checkedAt": timestamp,
                "smtpCheck": smtp_check,
                "acceptAll": accept_all,
                "block": blocked,
                "mxRecords": mx_records,
            }
            if isinstance(score, (int, float, str)) and not isinstance(score, bool):
                verification_record["score"] = score
            work["emailVerification"] = verification_record
            if (
                result in {"deliverable", "valid"}
                and type(score) is int
                and score >= 95
                and smtp_check is True
                and accept_all is False
                and blocked is False
            ):
                work["enrichmentStatus"] = "email_verified_review_required"
                work["nextStep"] = "manual_media_fit_review_before_any_outreach"
            else:
                work["enrichmentStatus"] = "email_not_verified_review_or_replace"
                work["nextStep"] = "manual_review_or_find_replacement_email"
        else:
            work["enrichmentStatus"] = (
                "email_present_not_verified_budget_or_key_missing"
            )
            work["nextStep"] = "verify_email_before_any_outreach"
        event["enrichmentStatus"] = work["enrichmentStatus"]
        return work, hunter_left, event

    title_value = row.get("contactName", "")
    title = title_value if isinstance(title_value, str) else ""
    wiki = wiki_enrich(title)
    work["profileEnrichment"] = ProfileEnrichment(
        {
            "provider": "fr.wikipedia.org",
            "ok": wiki["ok"],
            "extract": wiki["extract"],
            "externalLinks": wiki["externalLinks"],
            "checkedAt": timestamp,
        }
    )
    first, last = split_name(title)
    found: JsonObject | None = None
    hunter_calls = 0
    if key and first and last and hunter_left > 0:
        for link in wiki["externalLinks"]:
            domain = link["domain"]
            if not domain_allowed(domain):
                continue
            response = email_finder(key, domain, first, last)
            hunter_calls += 1
            hunter_left -= 1
            body = as_object(response.get("body", {}))
            data = as_object(body.get("data", {}))
            email = norm_email(data.get("email", ""))
            score = data.get("score", data.get("confidence"))
            numeric_score: int | float | None = None
            if score is not None:
                try:
                    numeric_score = int(cast(int | float | str, score) or 0)
                except (TypeError, ValueError, OverflowError):
                    numeric_score = -1
            if (
                EMAIL_RE.fullmatch(email)
                and email_domain(email) == domain
                and (numeric_score is None or numeric_score >= 55)
            ):
                found = {
                    "email": email,
                    "domain": domain,
                    "provider": "hunter_email_finder",
                    "score": score,
                    "sourceUrl": link["url"],
                    "statusCode": response.get("statusCode"),
                }
                break
            if hunter_left <= 0:
                break
    if found is not None:
        email = found.get("email")
        if isinstance(email, str):
            work["enrichedEmail"] = email
            work["emailStatus"] = "public_candidate_to_verify"
            work["enrichmentStatus"] = "candidate_email_found_review_required"
            work["nextStep"] = (
                "verify_email_and_manual_media_fit_review_before_any_outreach"
            )
            work["enrichmentEvidence"] = found
    elif wiki["externalLinks"]:
        work["enrichmentStatus"] = "profile_context_enriched"
        work["nextStep"] = "review_external_links_or_run_later_hunter_budget"
    else:
        work["enrichmentStatus"] = "no_public_email_found_yet"
        work["nextStep"] = "manual_source_research_or_later_enrichment"
    event["hunterCalls"] = hunter_calls
    event["enrichmentStatus"] = work.get("enrichmentStatus", "processed")
    return work, hunter_left, event


def as_candidate(value: JsonValue) -> EnrichedCandidate:
    if not isinstance(value, dict):
        raise TypeError("media_contact_record_must_be_object")
    candidate: EnrichedCandidate = {}
    for key, item in value.items():
        candidate[key] = item
    return candidate


def as_candidates(value: JsonValue) -> list[EnrichedCandidate]:
    if not isinstance(value, list):
        return []
    return [as_candidate(item) for item in value]


def csv_cell(value: JsonValue) -> str:
    return "" if value is None else value if isinstance(value, str) else str(value)
