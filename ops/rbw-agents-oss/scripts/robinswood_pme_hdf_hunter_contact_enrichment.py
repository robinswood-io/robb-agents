#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import re
import time
from datetime import UTC, datetime
from pathlib import Path

import contact_provider
import requests
from pydantic import JsonValue, TypeAdapter

type Row = dict[str, object]
OBJECT: TypeAdapter[dict[str, JsonValue]] = TypeAdapter(dict[str, JsonValue])
ROWS: TypeAdapter[list[dict[str, JsonValue]]] = TypeAdapter(list[dict[str, JsonValue]])

ROOT = Path("/srv/rbw-agents-oss")
WS = Path("/home/craft/.craft-agent/workspaces/my-workspace-2")
OPS = WS / "campaigns" / "ops"
INPUT = OPS / "robinswood-pme-hdf-verified-context-v1-2026-06-17.json"
OUT = OPS / "robinswood-pme-hdf-hunter-contact-enrichment-last.json"
OUT_MD = OPS / "robinswood-pme-hdf-hunter-contact-enrichment-last.md"
LEDGER = OPS / "robinswood-pme-hdf-hunter-contact-enrichment-ledger.jsonl"
ENV = ROOT / "compose" / ".env"
UA = "Robinswood-OSS-HDF-Hunter/1.0 prepare-only no-send"


def object_row(value: object) -> Row:
    return dict(OBJECT.validate_python(value, strict=True))


def object_rows(value: object) -> list[Row]:
    return [dict(row) for row in ROWS.validate_python(value, strict=True)]


def now_iso() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def read_json(path: Path, default: Row) -> Row:
    try:
        return dict(OBJECT.validate_json(path.read_bytes(), strict=True))
    except FileNotFoundError:
        return default.copy()


def write_json(path: Path, data: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    _ = temporary.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    os.replace(temporary, path)


def load_key() -> str | None:
    if contact_provider.configured():
        return contact_provider.MARKER
    key = os.getenv("HUNTER_API_KEY")
    if key:
        return key
    if ENV.exists():
        for line in ENV.read_text(encoding="utf-8").splitlines():
            if line.startswith("HUNTER_API_KEY="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    return None


def hunter_get(
    path: str,
    params: dict[str, str | int | None],
    timeout: int = 14,
    campaign: str | None = None,
) -> Row:
    if contact_provider.configured():
        return dict(
            contact_provider.legacy(
                path, dict(params), campaign or "robinswood-pme-hdf"
            )
        )
    response = requests.get(
        "https://api.hunter.io/v2/" + path,
        params=params,
        headers={"User-Agent": UA},
        timeout=timeout,
    )
    try:
        payload: Row = dict(OBJECT.validate_json(response.content))
    except ValueError:
        payload = {"raw": response.text[:500]}
    return {
        "statusCode": response.status_code,
        "ok": response.status_code < 400,
        "body": payload,
    }


def email_finder(
    key: str,
    domain: str,
    first: str,
    last: str,
    company: str,
    campaign: str | None = None,
) -> Row:
    return hunter_get(
        "email-finder",
        {
            "domain": domain,
            "first_name": first,
            "last_name": last,
            "company": company,
            "api_key": key,
        },
        campaign=campaign,
    )


def verify_email(key: str, email: str, campaign: str | None = None) -> Row:
    return hunter_get(
        "email-verifier", {"email": email, "api_key": key}, campaign=campaign
    )


def domain_search(key: str, domain: str) -> Row:
    return hunter_get(
        "domain-search", {"domain": domain, "limit": 5, "api_key": key}, timeout=16
    )


def response_data(response: Row | None) -> Row:
    return object_row(object_row((response or {}).get("body") or {}).get("data") or {})


def parse_leader(raw: str) -> tuple[str | None, str | None, str]:
    name = (raw or "").split("—")[0].strip()
    name = re.sub("\\([^)]*\\)", "", name).strip()
    parts = [p for p in re.split("\\s+", name.title()) if p]
    if len(parts) < 2:
        return (None, None, name)
    return (parts[0], parts[-1], name)


def verdict(finder: Row, verify: Row | None) -> str:
    email = response_data(finder).get("email")
    fdata = response_data(finder)
    vdata = response_data(verify)
    if not email:
        return "no_email_found"
    result = str(vdata.get("result") or "").lower()
    score = int(str(vdata.get("score") or fdata.get("score") or 0))
    if result in {"deliverable", "valid"} or score >= 85:
        return "verified_candidate_needs_quality_gate"
    if vdata.get("accept_all") is True and score >= 65:
        return "accept_all_candidate_needs_quality_gate"
    return "email_found_but_not_verified_enough"


def render_md(report: Row) -> str:
    lines = [
        "# Robinswood PME HDF — Hunter contact enrichment",
        "",
        f"- Generated: {report['generatedAt']}",
        f"- Status: `{report['status']}`",
        "- External sends allowed: **false**",
        f"- Summary: {report['summary']}",
        "",
        "## Results",
    ]
    for r in object_rows(report.get("results") or []):
        lines += [
            "",
            f"### {r.get('accountName')}",
            f"- Domain: {r.get('domain')}",
            f"- Leader: {r.get('leaderName')} — {r.get('leaderRole')}",
            f"- Hunter verdict: `{r.get('hunterVerdict')}`",
            f"- Email candidate: {r.get('email') or 'none'}",
            f"- LinkedIn/provider signal: {r.get('linkedinSignal') or 'none'}",
            f"- Status: `{r.get('status')}`",
        ]
    lines += [
        "",
        "## Blocking gates before any outbound",
        "- contact_quality_gate ok",
        "- suppression list checked at contact level",
        "- human approval of exact file and sequence",
        "- opt-out copy approved",
    ]
    return "\n".join(lines) + "\n"


def main() -> int:
    key = load_key()
    generated = now_iso()
    payload = read_json(INPUT, {})
    results: list[Row] = []
    errors: list[Row] = []
    used = 0
    if not key:
        report: Row = {
            "generatedAt": generated,
            "ok": True,
            "status": "dependency_degraded",
            "summary": "Hunter key missing/unavailable; no contact enrichment performed",
            "externalSendAllowed": False,
            "counts": {
                "accountsReviewed": 0,
                "verifiedCandidates": 0,
                "readyForOutbound": 0,
            },
            "blockingReasons": ["hunter_key_missing"],
            "results": [],
            "errors": [],
            "artifacts": {"json": str(OUT), "md": str(OUT_MD)},
        }
        write_json(OUT, report)
        _ = OUT_MD.write_text(render_md(report), encoding="utf-8")
        print(json.dumps(report, ensure_ascii=False))
        return 0
    for acc in object_rows(payload.get("accounts") or [])[:4]:
        domain = str(acc.get("verifiedDomain") or "")
        first, last, leader = parse_leader(
            str(acc.get("officialLeaderFromRegistry") or "")
        )
        row: Row = {
            "siren": acc.get("siren"),
            "accountName": acc.get("accountName"),
            "domain": domain,
            "leaderName": leader,
            "leaderRole": (str(acc.get("officialLeaderFromRegistry") or ""))
            .split("—", 1)[1]
            .strip()
            if "—" in (str(acc.get("officialLeaderFromRegistry") or ""))
            else None,
            "sourceUrls": acc.get("sourceUrls") or [],
            "externalSendAllowed": False,
        }
        try:
            if not (domain and first and last):
                row.update(
                    {
                        "status": "insufficient_identity_or_domain",
                        "hunterVerdict": "not_run",
                    }
                )
                results.append(row)
                continue
            finder = email_finder(
                key, domain, first, last, str(acc.get("accountName") or "")
            )
            used += 1
            fdata = response_data(finder)
            email = str(fdata.get("email") or "")
            verify = None
            if email:
                verify = verify_email(key, email)
                used += 1
            ds = None
            if not email:
                ds = domain_search(key, domain)
                used += 1
            v = verdict(finder, verify)
            linkedin = (
                fdata.get("linkedin")
                or fdata.get("linkedin_url")
                or fdata.get("linkedinUrl")
            )
            if not linkedin and ds and ds.get("ok"):
                emails = object_rows(response_data(ds).get("emails") or [])
                for e in emails:
                    val = " ".join(
                        str(e.get(k) or "")
                        for k in [
                            "first_name",
                            "last_name",
                            "position",
                            "linkedin",
                            "linkedin_url",
                        ]
                    )
                    if last and last.lower() in val.lower():
                        linkedin = (
                            e.get("linkedin")
                            or e.get("linkedin_url")
                            or e.get("linkedinUrl")
                        )
                        break
            row.update(
                {
                    "email": email,
                    "hunterFinder": {
                        "ok": finder.get("ok"),
                        "statusCode": finder.get("statusCode"),
                        "score": fdata.get("score"),
                        "position": fdata.get("position"),
                        "sourcesCount": len(
                            TypeAdapter(list[JsonValue]).validate_python(
                                fdata.get("sources") or []
                            )
                        ),
                    },
                    "hunterVerification": response_data(verify) if verify else None,
                    "linkedinSignal": linkedin,
                    "hunterVerdict": v,
                    "status": "contact_candidate_found_prepare_only"
                    if email
                    else "no_nominative_email_found_prepare_only",
                    "sendPolicy": "prepare_only_no_send; contact_quality_gate_and_human_approval_required",
                }
            )
            results.append(row)
            time.sleep(0.4)
        except (OSError, ValueError, TypeError, requests.RequestException) as e:
            row.update(
                {
                    "status": "hunter_error",
                    "error": type(e).__name__,
                    "hunterVerdict": "error",
                }
            )
            results.append(row)
            errors.append(row)
    verified = sum(
        1
        for r in results
        if str(r.get("hunterVerdict"))
        in {
            "verified_candidate_needs_quality_gate",
            "accept_all_candidate_needs_quality_gate",
        }
    )
    report = {
        "generatedAt": generated,
        "capabilityId": "robinswood-pme-hdf-hunter-contact-enrichment",
        "contractVersion": "robinswood-pme-hdf-hunter-v1",
        "campaignId": "robinswood-pme-hdf-dirigeants-2026-06",
        "ok": True,
        "status": "processed_prepare_only",
        "summary": f"hunter_contact_enrichment: reviewed={len(results)} verifiedCandidates={verified} readyForOutbound=0 requestsApprox={used}",
        "externalSendAllowed": False,
        "humanApprovalRequiredBeforeOutbound": True,
        "sendPolicy": "prepare_only; no send queue; no outbound; contact_quality_gate and human approval required",
        "counts": {
            "accountsReviewed": len(results),
            "verifiedCandidates": verified,
            "readyForOutbound": 0,
            "hunterRequestsApprox": used,
            "errors": len(errors),
        },
        "results": results,
        "errors": errors,
        "artifacts": {
            "json": str(OUT),
            "md": str(OUT_MD),
            "ledger": str(LEDGER),
            "input": str(INPUT),
        },
    }
    write_json(OUT, report)
    _ = OUT_MD.write_text(render_md(report), encoding="utf-8")
    LEDGER.parent.mkdir(parents=True, exist_ok=True)
    with LEDGER.open("a", encoding="utf-8") as f:
        _ = f.write(
            json.dumps(
                {
                    "generatedAt": generated,
                    "counts": report["counts"],
                    "status": report["status"],
                },
                ensure_ascii=False,
            )
            + "\n"
        )
    print(
        json.dumps(
            {
                "ok": True,
                "status": report["status"],
                "summary": report["summary"],
                "counts": report["counts"],
                "artifacts": report["artifacts"],
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
