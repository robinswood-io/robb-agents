from __future__ import annotations

import base64
import hashlib
import html
import json
import re
import time
from collections.abc import Mapping
from email.message import EmailMessage
from email.utils import getaddresses
from http.client import HTTPResponse
from pathlib import Path
from typing import Protocol, cast
from urllib import error, parse, request

from evergreen_campaign_data_types import (
    JsonObject,
    JsonValue,
    data_json_object_or_empty,
    data_json_objects,
    data_parse_json_object,
    data_text,
)
from pydantic import TypeAdapter

SENDER = 'thibault@robinswood.io'
JSON_ADAPTER: TypeAdapter[JsonValue] = TypeAdapter(JsonValue)

GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me'

def read(path: str | Path) -> JsonValue:
    return JSON_ADAPTER.validate_json(Path(path).read_bytes())

def require(condition: object, message: str = 'contract_guard_failed') -> None:
    if not condition:
        raise AssertionError(message)

def plain(payload: JsonObject) -> str:
    body = data_json_object_or_empty(payload.get('body'))
    if payload.get('mimeType') == 'text/plain':
        encoded = data_text(body.get('data'))
        return base64.urlsafe_b64decode(encoded + '=' * (-len(encoded) % 4)).decode('utf-8', 'replace')
    for part in data_json_objects(payload.get('parts')):
        found = plain(part)
        if found:
            return found
    if payload.get('mimeType') == 'text/html':
        encoded = data_text(body.get('data'))
        text = base64.urlsafe_b64decode(encoded + '=' * (-len(encoded) % 4)).decode('utf-8', 'replace')
        return html.unescape(re.sub('<[^>]+>', ' ', text))
    return ''


def header(message: JsonObject, key: str) -> str:
    payload = data_json_object_or_empty(message.get('payload'))
    headers = data_json_objects(payload.get('headers'))
    return next((data_text(item.get('value')) for item in headers if data_text(item.get('name')).lower() == key.lower()), '').strip()


def addresses(value: str) -> list[str]:
    return sorted(address.lower() for _, address in getaddresses([value]) if address)


def attachments(payload: JsonObject) -> bool:
    return bool(payload.get('filename')) or any(attachments(part) for part in data_json_objects(payload.get('parts')))


def classify(message: JsonObject) -> tuple[str, str]:
    # Work on the new response only. Never learn from the quoted invitation.
    payload = data_json_object_or_empty(message.get('payload'))
    text = re.split(r'(?im)^On .{0,200}wrote:|^From:|^_{4,}|^-{4,}.*Original Message|^>', plain(payload))[0].strip().lower()
    auto = header(message, 'Auto-Submitted').lower()
    if 'auto-replied' in auto or re.search(r'out of (?:the )?office|automatic reply|on annual leave', text):
        return 'automatic_reply', text[:600]
    if re.search(r'spam|complaint|report(?:ed|ing) you', text):
        return 'complaint', text[:600]
    if re.search(r'unsubscribe|remove me|do not contact|stop emailing|no thanks|not interested|not relevant', text):
        return 'opt_out_or_negative', text[:600]
    if re.search(r'undeliverable|delivery.*fail|5\.1\.1|address.*not found', text):
        return 'delivery_failure', text[:600]
    if re.search(r'\bnot\b|\bno\b|\bdon.t\b|\bwon.t\b', text):
        return 'reply_received', text[:600]
    if re.search(r"\b(?:send|share|see|receive|get|forward)\b.{0,60}\b(?:programme|program|agenda|one.page)\b|\b(?:prix|tarif|price|budget)\b.{0,40}\b(?:approx|estim|forfait|fee|cost)\b", text):
        return 'programme_requested', text[:600]
    if re.search(r"\b(?:we|our|i)\b", text) and re.search(r"\b(?:[0-9]+(?:\.[0-9]+)?|five|ten|fifteen|twenty|forty|fifty|cent)\s*(?:hours?|days?|weeks?|per|a week|par semaine|heures?|jours?)\b", text):
        return 'qualified_need', text[:600]
    if re.search(r"\b(?:yes\b|interested|sounds (?:useful|good|interesting)|please (?:send|share)|let.s (?:talk|discuss)|réunion|disponible)\b", text):
        return 'qualified_interest', text[:600]
    return 'reply_received', text[:600]

class GatewayPort(Protocol):
    token: str
    identity: JsonObject | None

    def call(self: GatewayPort, path: str, data: JsonValue | None = None) -> JsonObject: ...
    def search(self: GatewayPort, query: str) -> list[JsonObject]: ...
    def get(self: GatewayPort, mid: str) -> JsonObject: ...
    def prepare(
        self,
        item: JsonObject,
        draft: Mapping[str, JsonValue],
        operation: str,
        parent: JsonObject | None = None,
    ) -> tuple[str, str, str]: ...
    def send(self, raw: str, thread_id: str | None = None, ops: Path | None = None) -> JsonObject: ...


class Gateway:
    token: str
    identity: JsonObject | None

    def __init__(self) -> None:
        self.token = ''
        self.identity = None
        creds_root = data_json_objects([read('/home/craft/.craft-agent/xdg-config/google-mcp/credentials.json')])[0]
        creds = data_json_objects([creds_root.get('installed')])[0]
        tokens = data_json_objects([read('/home/craft/.craft-agent/xdg-data/google-mcp/tokens.json')])[0]
        data = parse.urlencode({'client_id': data_text(creds.get('client_id')), 'client_secret': data_text(creds.get('client_secret')), 'refresh_token': data_text(tokens.get('refresh_token')), 'grant_type': 'refresh_token'}).encode()
        response_value = cast(object, request.urlopen(request.Request(data_text(creds.get('token_uri')), data=data), timeout=25))
        if not isinstance(response_value, HTTPResponse):
            raise TypeError('gmail_token_response_expected')
        with response_value as response:
            self.token = data_text(data_parse_json_object(response.read().decode('utf-8')).get('access_token'))
        require(data_text(self.call('/profile').get('emailAddress')).lower() == SENDER, 'unexpected_gmail_account')

    def call(self: GatewayPort, path: str, data: JsonValue | None = None) -> JsonObject:
        headers = {'Authorization': 'Bearer ' + self.token}
        if data is not None:
            headers['Content-Type'] = 'application/json'
        # Only idempotent reads may retry. A Gmail write with an ambiguous
        # outcome remains reserved in SQLite and is reconciled on the next run.
        attempts = 3 if data is None else 1
        for attempt in range(attempts):
            try:
                response_value = cast(object, request.urlopen(request.Request(GMAIL + path, data=json.dumps(data).encode() if data is not None else None, headers=headers), timeout=25))
                if not isinstance(response_value, HTTPResponse):
                    raise TypeError('gmail_response_expected')
                with response_value as response:
                    return data_parse_json_object(response.read().decode('utf-8'))
            except error.HTTPError as exc:
                if exc.code not in (500, 502, 503, 504) or attempt + 1 >= attempts:
                    raise
                retry_after_value = cast(object, exc.headers.get('Retry-After', '') if exc.headers else '')
                if not isinstance(retry_after_value, str):
                    raise TypeError('gmail_retry_after_must_be_text')
                retry_after = retry_after_value
                # A long or dated server cooldown is left to the next native tick.
                if retry_after and (not retry_after.isdecimal() or int(retry_after) > 30):
                    raise
                retry_after_seconds: int = int(retry_after) if retry_after else 0
                delay: int = 2 << attempt
                delay = max(delay, retry_after_seconds)
                exc.close()
                time.sleep(float(delay))
        raise RuntimeError('gmail_retry_exhausted')

    def search(self: GatewayPort, query: str) -> list[JsonObject]:
        return data_json_objects(self.call('/messages?' + parse.urlencode({'q': query, 'maxResults': 100})).get('messages'))

    def get(self: GatewayPort, mid: str) -> JsonObject:
        return self.call('/messages/' + mid + '?format=full')

    def prepare(self: GatewayPort, item: JsonObject, draft: Mapping[str, JsonValue], operation: str, parent: JsonObject | None = None) -> tuple[str, str, str]:
        if self.identity is None:
            self.identity = next(x for x in data_json_objects(self.call('/settings/sendAs').get('sendAs')) if data_text(x.get('sendAsEmail')).lower() == SENDER)
        identity = self.identity
        signature = data_text(identity.get('signature')).strip()
        require(signature and identity.get('verificationStatus') in [None, 'accepted'], 'sender_signature_not_ready')
        sig_text = html.unescape(re.sub('<[^>]+>', ' ', re.sub(r'<br\s*/?>', '\n', signature)))
        expected = data_text(draft.get('body')).strip() + '\n\n' + sig_text.strip() + '\n'
        m = EmailMessage()
        m['From'], m['To'], m['Subject'] = SENDER, data_text(item.get('email')), data_text(draft.get('subject'))
        m['Message-ID'] = '<' + operation + '@robinswood.io>'
        m['X-RBW-Campaign'] = 'scotland-executive-conference-october-2026'
        m['X-RBW-Operation'] = operation
        if parent:
            m['In-Reply-To'] = header(parent, 'Message-ID')
            m['References'] = header(parent, 'Message-ID')
        m.set_content(expected)
        m.add_alternative('<div>' + html.escape(data_text(draft.get('body'))).replace('\n', '<br>') + '</div><br>' + signature, subtype='html')
        raw = base64.urlsafe_b64encode(m.as_bytes()).decode()
        return raw, expected, hashlib.sha256(signature.encode()).hexdigest()

    def send(self, raw: str, thread_id: str | None = None, ops: Path | None = None) -> JsonObject:
        data: JsonObject = {'raw': raw}
        if thread_id:
            data['threadId'] = thread_id
        from outbound_sender_guard import OPS as default_ops
        from outbound_sender_guard import shared_send
        send_ops = default_ops if ops is None else ops
        return shared_send(self, raw, thread_id, lambda: self.call('/messages/send', data), ops=send_ops)

__all__ = ['GMAIL', 'SENDER', 'Gateway', 'addresses', 'attachments', 'classify', 'header', 'plain', 'read', 'require']
