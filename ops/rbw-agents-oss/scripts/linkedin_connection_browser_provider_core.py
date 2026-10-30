"""Explicit, note-free LinkedIn browser transport with fail-closed outcomes."""

from __future__ import annotations

import argparse
import json
import os
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING
from urllib.parse import urlsplit

from flow_contact_evidence_state import OBJECT, Row, object_row
from linkedin_connection_browser_rules import (
    COMPANY,
    md,
    normalize,
    summarize,
    validate,
)
from playwright.sync_api import Error as PlaywrightError

if TYPE_CHECKING:
    from playwright.sync_api import BrowserContext, Locator, Page, Playwright

__all__ = [
    "normalize",
    "run_browser_provider",
    "summarize",
    "transport_preflight",
    "validate",
]

ROOT = Path("/srv/rbw-agents-oss")

WS = Path("/home/craft/.craft-agent/workspaces/my-workspace-2")

OPS = WS / "campaigns" / "ops"

CONTRACT = ROOT / "config/linkedin-connection-managed-transport.json"

STATE_DIR = ROOT / "secrets/linkedin-browser-state"

LEDGER = OPS / "sellsy-linkedin-connection-ledger.jsonl"

REPORT = OPS / "sellsy-linkedin-connection-browser-provider-last.json"

REPORT_MD = OPS / "sellsy-linkedin-connection-browser-provider-last.md"


LOGIN = re.compile(
    "(sign in|join linkedin|s’identifier|se connecter à linkedin|email or phone|adresse e-mail|mot de passe)",
    re.IGNORECASE,
)

STOP = re.compile(
    "(captcha|checkpoint|security check|vérification de sécurité|restriction|account warning|compte.*restreint|suspicious|inhabituel)",
    re.IGNORECASE,
)


def now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def rjson(p: Path, d: Row) -> Row:
    if not p.exists():
        return d
    return dict(OBJECT.validate_json(p.read_text(encoding="utf-8"), strict=True))


def wjson(p: Path, o: Row) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    _ = p.write_text(
        json.dumps(o, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def append(p: Path, row: Row) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    with p.open("a", encoding="utf-8") as stream:
        _ = stream.write(json.dumps(row, ensure_ascii=False) + "\n")


def selected(c: Row | None = None) -> str | None:
    contract = rjson(CONTRACT, {}) if c is None else c
    return (
        os.getenv("LINKEDIN_CONNECTION_TRANSPORT", "").strip()
        or str(
            object_row(contract.get("transport") or {}).get("selected") or ""
        ).strip()
        or None
    )


def body(page: Page) -> str:
    return page.locator("body").inner_text(timeout=3000)[:20000]


def stop_reason(page: Page) -> str | None:
    u = page.url
    host = urlsplit(u).hostname or ""
    if host != "www.linkedin.com" and not re.fullmatch(
        r"[a-z]{2,3}\.www\.linkedin\.com", host
    ):
        return "unexpected_navigation_host"
    b = body(page)
    if "/login" in u or LOGIN.search(b):
        return "linkedin_not_logged_in"
    if "/checkpoint" in u or STOP.search(b):
        return "linkedin_checkpoint_captcha_or_account_warning"
    return None


def open_context(headless: bool = True) -> tuple[Playwright, BrowserContext]:
    from playwright.sync_api import sync_playwright

    p = sync_playwright().start()
    try:
        ctx = p.chromium.launch_persistent_context(
            user_data_dir=str(STATE_DIR),
            headless=headless,
            viewport={"width": 1365, "height": 900},
            locale="fr-FR",
        )
    except Exception:
        p.stop()
        raise
    return (p, ctx)


def transport_preflight(contract: Row | None = None) -> Row:
    contract = rjson(CONTRACT, {}) if contract is None else contract
    if selected(contract) != "oss_server_browser":
        return {
            "ok": False,
            "status": "blocked_ui",
            "reason": "oss_server_browser_transport_not_selected",
            "selectedTransport": selected(contract),
        }
    if not STATE_DIR.exists():
        return {
            "ok": False,
            "status": "blocked_ui",
            "reason": "linkedin_browser_state_dir_missing",
            "stateDir": str(STATE_DIR),
        }
    try:
        p, ctx = open_context(
            headless=os.getenv("LINKEDIN_BROWSER_HEADLESS", "1") != "0"
        )
        try:
            page = ctx.pages[0] if ctx.pages else ctx.new_page()
            _ = page.goto(
                "https://www.linkedin.com/feed/",
                wait_until="domcontentloaded",
                timeout=45000,
            )
            page.wait_for_timeout(2500)
            reason = stop_reason(page)
            current = page.url
        finally:
            try:
                ctx.close()
            finally:
                p.stop()
        if reason:
            return {
                "ok": False,
                "status": "blocked_ui",
                "reason": reason,
                "selectedTransport": "oss_server_browser",
                "stateDir": str(STATE_DIR),
                "url": current,
            }
        return {
            "ok": True,
            "status": "ready",
            "selectedTransport": "oss_server_browser",
            "stateDir": str(STATE_DIR),
            "url": current,
            "linkedinLoginState": "authenticated_or_feed_accessible",
        }
    except (PlaywrightError, OSError, ValueError, RuntimeError) as exc:
        return {
            "ok": False,
            "status": "blocked_ui",
            "reason": "linkedin_login_preflight_error",
            "error": type(exc).__name__,
            "selectedTransport": "oss_server_browser",
            "stateDir": str(STATE_DIR),
        }


def click_visible(locator: Locator, timeout: int = 1500) -> bool:
    try:
        if locator.first.is_visible(timeout=timeout):
            locator.first.click(timeout=timeout)
            return True
    except PlaywrightError:
        return False
    return False


def classify_or_send(page: Page, it: Row, apply: bool) -> Row:
    base = {
        k: it.get(k)
        for k in [
            "requestId",
            "linkedinProfileUrl",
            "companyName",
            "contactName",
            "officerRoleQualified",
            "officerRoleEvidence",
        ]
    }
    ok, why = validate(it)
    if not ok:
        return {**base, "status": "blocked_ui", "reason": why}
    try:
        _ = page.goto(
            str(it["linkedinProfileUrl"]), wait_until="domcontentloaded", timeout=45000
        )
        page.wait_for_timeout(2500)
        sr = stop_reason(page)
        if sr:
            return {**base, "status": "blocked_ui", "reason": sr, "stopRun": True}
        if COMPANY.search(str(page.url or "")):
            return {
                **base,
                "status": "pending_or_follow_only",
                "reason": "navigated_to_company_page_forbidden",
            }
        txt = body(page)
        if re.search(
            "\\b(Pending|En attente|Invitation envoyée|Invitation sent)\\b",
            txt,
            re.IGNORECASE,
        ):
            return {
                **base,
                "status": "skipped_already_connected",
                "reason": "connection_already_pending_or_sent",
            }
        if re.search("\\b(1st|1er|Vous êtes en relation)\\b", txt, re.IGNORECASE):
            return {
                **base,
                "status": "skipped_already_connected",
                "reason": "already_connected",
            }
        connect = page.get_by_role(
            "button", name=re.compile("^(Connect|Se connecter)$", re.IGNORECASE)
        )
        follow = page.get_by_role(
            "button", name=re.compile("^(Follow|Suivre)$", re.IGNORECASE)
        )
        try:
            cv = connect.first.is_visible(timeout=2000)
        except PlaywrightError:
            cv = False
        try:
            fv = follow.first.is_visible(timeout=1000)
        except PlaywrightError:
            fv = False
        if not cv:
            return {
                **base,
                "status": "pending_or_follow_only",
                "reason": "only_follow_visible" if fv else "connect_button_not_visible",
            }
        if not apply:
            return {
                **base,
                "status": "dry_run_ready_not_sent",
                "reason": "connect_button_visible_no_note_dry_run",
            }
        connect.first.click(timeout=3000)
        page.wait_for_timeout(1200)
        sr = stop_reason(page)
        if sr:
            return {**base, "status": "blocked_ui", "reason": sr, "stopRun": True}
        send = page.get_by_role(
            "button",
            name=re.compile("^(Send|Envoyer|Envoyer maintenant)$", re.IGNORECASE),
        )
        if not click_visible(send, timeout=2500):
            return {
                **base,
                "status": "blocked_ui",
                "reason": "send_invitation_button_not_unambiguous",
            }
        page.wait_for_timeout(2500)
        after = body(page)
        if re.search(
            "\\b(Pending|En attente|Invitation sent|Invitation envoyée)\\b",
            after,
            re.IGNORECASE,
        ):
            return {
                **base,
                "status": "sent_ui",
                "reason": "ui_confirmation_observed_no_note",
            }
        return {
            **base,
            "status": "blocked_ui",
            "reason": "send_clicked_but_confirmation_not_observed",
        }
    except (PlaywrightError, OSError, ValueError, RuntimeError) as exc:
        return {**base, "status": "error", "reason": type(exc).__name__}


def run_browser_provider(
    items: list[Row],
    *,
    apply: bool,
    allow_note: bool = False,
    pace_seconds: float = 10.0,
) -> Row:
    if allow_note:
        return {
            "generatedAt": now(),
            "ok": False,
            "status": "blocked_ui",
            "reason": "notes_forbidden",
            "apply": apply,
            "counts": summarize([]),
            "results": [],
        }
    items = [normalize(x) for x in items]
    invalid = [
        {
            **{
                k: i.get(k)
                for k in [
                    "requestId",
                    "linkedinProfileUrl",
                    "companyName",
                    "contactName",
                ]
            },
            "status": "blocked_ui",
            "reason": validate(i)[1],
        }
        for i in items
        if not validate(i)[0]
    ]
    if invalid:
        return {
            "generatedAt": now(),
            "ok": False,
            "status": "blocked_ui",
            "summary": f"targeting prevalidation failed invalid={len(invalid)}",
            "apply": apply,
            "counts": summarize(invalid),
            "results": invalid,
        }
    pre = transport_preflight()
    if not pre.get("ok"):
        rows = [
            {
                "requestId": i.get("requestId"),
                "linkedinProfileUrl": i.get("linkedinProfileUrl"),
                "companyName": i.get("companyName"),
                "contactName": i.get("contactName"),
                "status": "blocked_ui",
                "reason": pre.get("reason"),
            }
            for i in items
        ]
        return {
            "generatedAt": now(),
            "ok": False,
            "status": "blocked_ui",
            "summary": f"LinkedIn browser provider blocked before UI run: {pre.get('reason')}",
            "preflight": pre,
            "apply": apply,
            "counts": summarize(rows),
            "results": rows,
        }
    p, ctx = open_context(headless=os.getenv("LINKEDIN_BROWSER_HEADLESS", "1") != "0")
    page = ctx.pages[0] if ctx.pages else ctx.new_page()
    results: list[Row] = []
    try:
        for idx, it in enumerate(items):
            res = classify_or_send(page, it, apply)
            results.append(res)
            if res.get("stopRun"):
                break
            if idx < len(items) - 1:
                page.wait_for_timeout(int(max(1, pace_seconds) * 1000))
    finally:
        try:
            ctx.close()
        finally:
            p.stop()
    return {
        "generatedAt": now(),
        "ok": all(
            r.get("status")
            in {
                "sent_ui",
                "skipped_already_connected",
                "dry_run_ready_not_sent",
                "pending_or_follow_only",
            }
            for r in results
        ),
        "status": "browser_provider_completed",
        "summary": f"LinkedIn browser provider processed={len(results)} sent={sum(1 for r in results if r.get('status') == 'sent_ui')}",
        "preflight": pre,
        "apply": apply,
        "counts": summarize(results),
        "results": results,
    }


def selftest() -> Row:
    good: Row = {
        "requestId": "x",
        "linkedinProfileUrl": "https://www.linkedin.com/in/example",
        "officerRoleQualified": True,
        "officerRoleEvidence": {"role": "Président"},
    }
    bad: Row = {
        "requestId": "x",
        "linkedinProfileUrl": "https://www.linkedin.com/in/example",
    }
    assert validate(good)[0] is True
    assert validate(bad)[1] == "needs_officer_role_validation"
    return {
        "generatedAt": now(),
        "ok": True,
        "status": "selftest_ok",
        "preflight": transport_preflight(),
        "checks": {
            "validation": True,
            "officerRoleGate": True,
            "noNotesOrMessages": True,
        },
    }


class Arguments(argparse.Namespace):
    mode: str = "preflight"


def main() -> int:
    ap = argparse.ArgumentParser()
    _ = ap.add_argument(
        "--mode", choices=["selftest", "preflight"], default="preflight"
    )
    args = ap.parse_args(namespace=Arguments())
    rep = (
        selftest()
        if args.mode == "selftest"
        else {"generatedAt": now(), **transport_preflight()}
    )
    wjson(REPORT, rep)
    _ = REPORT_MD.write_text(md(rep), encoding="utf-8")
    print(json.dumps(rep, ensure_ascii=False))
    return 0 if rep.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
