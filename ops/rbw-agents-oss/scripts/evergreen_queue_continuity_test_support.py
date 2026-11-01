"""Typed temporary fixtures for offline queue continuity tests."""

from __future__ import annotations

import base64
import json
import sqlite3
import tempfile
import unittest
from collections.abc import Callable
from contextlib import ExitStack
from datetime import datetime, timedelta
from pathlib import Path
from typing import cast, override
from unittest.mock import patch

import evergreen_campaign_data as campaign_data
import evergreen_campaign_data_types as data_types
import evergreen_offline_test_guard
import evergreen_queue_continuity as q
import outbound_sender_guard as guard
import robinswood_evergreen_france as e
import robinswood_evergreen_france_tests as fixture

T: datetime = fixture.T


def required_row(cursor: sqlite3.Cursor) -> sqlite3.Row:
    raw: object = cast(object, cursor.fetchone())
    if not isinstance(raw, sqlite3.Row):
        raise TypeError("query did not return a database row")
    return raw


def table_exists(connection: sqlite3.Connection, name: str) -> bool:
    raw: object = cast(
        object,
        connection.execute(
            "SELECT name FROM sqlite_master WHERE name=?", (name,)
        ).fetchone(),
    )
    return raw is not None


def required_rows(cursor: sqlite3.Cursor) -> list[sqlite3.Row]:
    raw_value: object = cast(object, cursor.fetchall())
    if not isinstance(raw_value, list):
        raise TypeError("query did not return database rows")
    raw_rows: list[object] = cast(list[object], raw_value)
    rows: list[sqlite3.Row] = []
    for raw_row in raw_rows:
        if not isinstance(raw_row, sqlite3.Row):
            raise TypeError("query returned a non-row result")
        rows.append(raw_row)
    return rows


class QueueHarness(unittest.TestCase):
    tmp: tempfile.TemporaryDirectory[str]
    root: Path
    db: sqlite3.Connection
    c: data_types.JsonObject
    cfg: data_types.JsonObject
    real_policy: Callable[[Path | None], data_types.JsonObject | None]
    cleanups: ExitStack
    g: fixture.EndGateway

    @override
    def __init__(self, methodName: str = "runTest") -> None:
        super().__init__(methodName)
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.db = e.db_open(self.root)
        self.c = e.contract(
            Path(__file__).parent.parent / "config/robinswood-evergreen-france.json"
        )
        cfg = q.policy(
            Path(__file__).parent.parent / "config/robinswood-evergreen-queue.json"
        )
        if cfg is None:
            raise AssertionError("queue policy fixture is missing")
        self.cfg = cfg
        self.real_policy = q.policy
        self.cleanups = ExitStack()
        self.g = fixture.EndGateway(self.root)

        def search(query: str) -> list[data_types.JsonObject]:
            if query.startswith("in:sent to:"):
                email = query.split("to:")[-1].split(" ")[0]
                return [
                    {"id": message["id"]}
                    for message in self.g.messages.values()
                    if self._has_label(message, "SENT")
                    and e.transport.addresses(guard.header(message, "To")) == [email]
                ]
            if query.startswith("from:"):
                email = query.split("from:")[1].split(" ")[0]
                return [
                    {"id": message["id"]}
                    for message in self.g.messages.values()
                    if not self._has_label(message, "SENT")
                    and e.transport.addresses(guard.header(message, "From")) == [email]
                ]
            return self.g.delegate.search(query)

        _ = self.cleanups.enter_context(
            patch.object(self.g, "search", side_effect=search)
        )

    @override
    def setUp(self) -> None:
        super().setUp()
        _ = self.cleanups.enter_context(
            patch.object(q, "policy", return_value=self.cfg)
        )

    @staticmethod
    def _has_label(message: data_types.JsonObject, expected: str) -> bool:
        labels = message.get("labelIds", [])
        return isinstance(labels, list) and any(
            label == expected for label in labels if isinstance(label, str)
        )

    @override
    def tearDown(self) -> None:
        try:
            evergreen_offline_test_guard.assert_no_external_attempts()
        finally:
            self.cleanups.close()
            self.db.close()
            self.tmp.cleanup()
        super().tearDown()

    def candidate(
        self,
        email: str = "editor@fixture.invalid",
        lane: str = "presse",
        company: str = "Fixture",
    ) -> sqlite3.Row:
        item: data_types.JsonObject = {
            "email": email,
            "name": "Fixture Person",
            "company": company,
            "domain": "fixture.invalid",
            "lane": lane,
            "sourceUrls": ["https://fixture.invalid/"],
        }
        e.put_candidate(self.db, item)
        _ = self.db.execute(
            "UPDATE candidates SET proof=?,checked=? WHERE email=?",
            (
                json.dumps({"ok": True, "checkedAt": campaign_data.stamp(T)}),
                campaign_data.stamp(T),
                email,
            ),
        )
        self.db.commit()
        row = required_row(
            self.db.execute("SELECT * FROM candidates WHERE email=?", (email,))
        )
        return row

    def legacy(
        self,
        email: str = "editor@fixture.invalid",
        campaign: str = "robinswood-media-authority-2026",
        state: str = "sent",
        age: int = 14,
        message_id: str = "original",
    ) -> tuple[sqlite3.Row, data_types.JsonObject]:
        row = self.candidate(email)
        raw_message = fixture.raw(
            "legacy-op",
            lane="presse",
            email=email,
            subject="Objet réellement envoyé en juillet",
        )
        parsed = guard.parse_raw(raw_message)
        del parsed["X-RBW-Campaign"]
        del parsed["X-RBW-Operation"]
        encoded = base64.urlsafe_b64encode(parsed.as_bytes()).decode()
        message = fixture.message(
            encoded, message_id, "original-thread", T - timedelta(days=age)
        )
        self.g.messages[message_id] = message
        _ = self.db.execute(
            "INSERT INTO legacy VALUES(?,?,?,?,?)",
            (email, campaign, message_id, guard.header(message, "Subject"), state),
        )
        self.db.commit()
        return row, message

    @staticmethod
    def headers_of(message: data_types.JsonObject) -> list[data_types.JsonObject]:
        payload = message.get("payload")
        if not isinstance(payload, dict):
            raise TypeError("message payload is missing")
        headers = payload.get("headers")
        if not isinstance(headers, list):
            raise TypeError("message headers are missing")
        if not all(isinstance(header, dict) for header in headers):
            raise AssertionError("message header entry is not an object")
        return [header for header in headers if isinstance(header, dict)]

    @staticmethod
    def body_of(message: data_types.JsonObject) -> data_types.JsonObject:
        payload = message.get("payload")
        if not isinstance(payload, dict):
            raise TypeError("message payload is missing")
        body = payload.get("body")
        if not isinstance(body, dict):
            raise TypeError("message body is missing")
        return body

    @staticmethod
    def row_text(row: sqlite3.Row, key: str) -> str:
        value: object = cast(object, row[key])
        if not isinstance(value, str):
            raise TypeError(f"database value {key!r} is not text")
        return value

    def scalar_int(self, query: str) -> int:
        row = required_row(self.db.execute(query))
        value: object = cast(object, row[0])
        if not isinstance(value, int):
            raise TypeError("query result is not an integer")
        return value

    def scalar_text(self, query: str) -> str:
        row = required_row(self.db.execute(query))
        value: object = cast(object, row[0])
        if not isinstance(value, str):
            raise TypeError("query result is not text")
        return value

    def audit(self) -> data_types.JsonObject:
        return q.audit_historical(
            self.db, self.g, "presse", T, set(), campaign_data.business_days, self.cfg
        )

    def runit(self) -> data_types.CampaignRunResult:
        self.g.time = T

        def import_reserves(db: sqlite3.Connection) -> None:
            _ = db

        with (
            patch.object(e, "OPS", self.root / "reports"),
            patch.object(e, "import_reserves", import_reserves),
            patch.object(e, "suppressed", return_value=set()),
            patch.object(e, "now", return_value=T),
        ):
            return e.run(
                "presse",
                apply=True,
                root=self.root,
                c=self.c,
                gateway=self.g,
                t=T,
                research_batch=0,
            )
