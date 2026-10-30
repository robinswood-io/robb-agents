"""Transport regression cases use fake pages and never contact LinkedIn."""

from __future__ import annotations

import tempfile
import unittest
from collections.abc import Generator
from contextlib import ExitStack, contextmanager
from pathlib import Path
from unittest.mock import PropertyMock, patch

import evergreen_offline_test_guard as offline
import linkedin_connection_browser_provider_core as browser
from flow_contact_evidence_state import Row
from playwright.sync_api import BrowserContext, Locator, Page, Playwright


def tearDownModule() -> None:
    offline.assert_no_external_attempts()


def target() -> Row:
    return {
        "requestId": "qa-1",
        "linkedinProfileUrl": "https://www.linkedin.com/in/qa",
        "companyName": "Example",
        "contactName": "Alex Example",
        "officerRoleQualified": True,
        "officerRoleEvidence": {"role": "CEO"},
    }


class BrowserFixture:
    """Isolated API objects; every exercised browser method is patched."""

    def __init__(self) -> None:
        self.page: Page = object.__new__(Page)
        self.context: BrowserContext = object.__new__(BrowserContext)
        self.driver: Playwright = object.__new__(Playwright)
        self.connect: Locator = object.__new__(Locator)
        self.send: Locator = object.__new__(Locator)
        self.follow: Locator = object.__new__(Locator)
        self.current_url: str = "https://www.linkedin.com/in/qa"
        self.goto_error: bool = False
        self.goto_calls: int = 0
        self.connect_clicks: int = 0
        self.send_clicks: int = 0
        self.closed: int = 0
        self.stopped: int = 0

    def goto(self, url: str, **kwargs: object) -> None:
        _ = kwargs
        self.goto_calls += 1
        if self.goto_error:
            raise RuntimeError("QA secret must not appear in a report")
        self.current_url = url

    def get_by_role(self, role: str, **kwargs: object) -> Locator:
        _ = role
        name = str(kwargs.get("name"))
        return (
            self.connect
            if "Connect" in name
            else self.follow
            if "Follow" in name
            else self.send
        )

    def close(self) -> None:
        self.closed += 1

    def stop(self) -> None:
        self.stopped += 1


@contextmanager
def browser_fixture() -> Generator[BrowserFixture]:
    fixture = BrowserFixture()

    def first(locator: Locator) -> Locator:
        return locator

    def visible(locator: Locator, **kwargs: object) -> bool:
        _ = kwargs
        return locator is not fixture.follow

    def click(locator: Locator, **kwargs: object) -> None:
        _ = kwargs
        if locator is fixture.connect:
            fixture.connect_clicks += 1
        elif locator is fixture.send:
            fixture.send_clicks += 1

    with ExitStack() as stack:
        for owner, name, implementation in [
            (Locator, "first", property(first)),
            (Locator, "is_visible", visible),
            (Locator, "click", click),
        ]:
            _ = stack.enter_context(patch.object(owner, name, implementation))
        _ = stack.enter_context(
            patch.object(
                Page,
                "url",
                new_callable=PropertyMock,
                side_effect=lambda: fixture.current_url,
            )
        )
        _ = stack.enter_context(patch.object(Page, "goto", side_effect=fixture.goto))
        _ = stack.enter_context(
            patch.object(Page, "get_by_role", side_effect=fixture.get_by_role)
        )
        _ = stack.enter_context(patch.object(Page, "wait_for_timeout"))
        _ = stack.enter_context(
            patch.object(
                BrowserContext,
                "pages",
                new_callable=PropertyMock,
                return_value=[fixture.page],
            )
        )
        _ = stack.enter_context(
            patch.object(BrowserContext, "close", side_effect=fixture.close)
        )
        _ = stack.enter_context(
            patch.object(Playwright, "stop", side_effect=fixture.stop)
        )
        _ = stack.enter_context(
            patch.object(
                browser, "open_context", return_value=(fixture.driver, fixture.context)
            )
        )
        yield fixture


class BrowserTransportTests(unittest.TestCase):
    def test_validation_rejects_unqualified_and_company_targets_before_navigation(
        self,
    ) -> None:
        with browser_fixture() as fixture:
            page = fixture.page
            cases: list[Row] = [
                {"officerRoleQualified": False},
                {"officerRoleEvidence": {}},
                {"linkedinProfileUrl": "https://www.linkedin.com/company/qa"},
                {"linkedinProfileUrl": "https://www.linkedin.com.evil.test/in/qa"},
            ]
            for fields in cases:
                with self.subTest(fields=fields):
                    result = browser.classify_or_send(
                        page, {**target(), **fields}, True
                    )
                    self.assertEqual(result["status"], "blocked_ui")
            self.assertEqual(fixture.goto_calls, 0)

    def test_dry_run_does_not_click_and_drops_message_draft(self) -> None:
        with browser_fixture() as fixture:
            page = fixture.page
            with patch.object(browser, "body", return_value="QA profile"):
                result = browser.classify_or_send(page, target(), False)
            self.assertEqual(result["status"], "dry_run_ready_not_sent")
            self.assertEqual((fixture.connect_clicks, fixture.send_clicks), (0, 0))
            self.assertEqual(
                browser.normalize({**target(), "messageDraft": "must never send"})[
                    "messageDraft"
                ],
                "",
            )

    def test_notes_request_blocks_before_browser_preflight(self) -> None:
        with patch.object(
            browser, "transport_preflight", side_effect=AssertionError("no preflight")
        ):
            result = browser.run_browser_provider(
                [target()], apply=True, allow_note=True
            )
        self.assertFalse(result["ok"])
        self.assertEqual(result["reason"], "notes_forbidden")

    def test_login_checkpoint_and_unexpected_host_stop_execution(self) -> None:
        with browser_fixture() as fixture:
            page = fixture.page
            for url, content, reason in [
                ("https://www.linkedin.com/login", "Login", "linkedin_not_logged_in"),
                (
                    "https://www.linkedin.com/checkpoint/qa",
                    "Challenge",
                    "linkedin_checkpoint_captcha_or_account_warning",
                ),
                ("https://evil.test/", "Feed", "unexpected_navigation_host"),
            ]:
                with (
                    self.subTest(url=url),
                    patch.object(browser, "body", return_value=content),
                ):
                    fixture.current_url = url
                    self.assertEqual(browser.stop_reason(page), reason)

    def test_send_needs_confirmation_and_error_is_redacted(self) -> None:
        with browser_fixture() as fixture:
            page = fixture.page
            with patch.object(
                browser,
                "body",
                side_effect=["QA profile", "QA profile", "Dialog", "En attente"],
            ):
                result = browser.classify_or_send(page, target(), True)
            self.assertEqual(result["status"], "sent_ui")
            self.assertEqual((fixture.connect_clicks, fixture.send_clicks), (1, 1))
            fixture.goto_error = True
            result = browser.classify_or_send(page, target(), True)
            self.assertEqual(result["reason"], "RuntimeError")
            self.assertNotIn("secret", str(result))

    def test_failed_navigation_closes_preflight_context_and_driver(self) -> None:
        with browser_fixture() as fixture:
            fixture.goto_error = True
            context, driver = fixture.context, fixture.driver
            with (
                tempfile.TemporaryDirectory() as tmp,
                patch.object(browser, "STATE_DIR", Path(tmp)),
                patch.object(
                    browser,
                    "open_context",
                    return_value=(driver, context),
                ),
            ):
                result = browser.transport_preflight(
                    {"transport": {"selected": "oss_server_browser"}}
                )
            self.assertFalse(result["ok"])
            self.assertEqual(result["error"], "RuntimeError")
            self.assertEqual((fixture.closed, fixture.stopped), (1, 1))

    def test_row_failure_cannot_report_success_and_resources_close(self) -> None:
        with browser_fixture() as fixture:
            context, driver = fixture.context, fixture.driver
            with (
                patch.object(browser, "transport_preflight", return_value={"ok": True}),
                patch.object(
                    browser,
                    "open_context",
                    return_value=(driver, context),
                ),
                patch.object(
                    browser, "classify_or_send", return_value={"status": "blocked_ui"}
                ),
            ):
                result = browser.run_browser_provider([target()], apply=True)
            self.assertFalse(result["ok"])
            self.assertEqual((fixture.closed, fixture.stopped), (1, 1))

    def test_malformed_configuration_is_not_silently_defaulted(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            config = Path(tmp) / "config.json"
            _ = config.write_text("{broken", encoding="utf-8")
            with self.assertRaises(ValueError):
                _ = browser.rjson(config, {})


if __name__ == "__main__":
    _ = unittest.main()
