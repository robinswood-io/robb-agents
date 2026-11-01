"""Offline mail and campaign fixtures; no credentials or external effects."""
from __future__ import annotations

import base64
import copy
import re
import tempfile
import unittest
from collections.abc import Mapping
from datetime import UTC, datetime, timedelta
from email import policy
from email.message import MIMEPart
from email.parser import BytesParser
from pathlib import Path
from typing import NotRequired, cast, override
from unittest.mock import patch

import evergreen_offline_test_guard as offline_guard
import scotland_conference_transport as transport
import scotland_executive_conference_october as m
from pydantic import JsonValue, TypeAdapter
from scotland_executive_conference_types import (
    CampaignItem,
    CampaignProof,
    CampaignReport,
    ExecutiveCampaignContract,
)
from typing_extensions import TypedDict

type JsonObject = dict[str, JsonValue]
OBJECT_ADAPTER: TypeAdapter[JsonObject] = TypeAdapter(dict[str, JsonValue])
ITEM_ADAPTER: TypeAdapter[CampaignItem] = TypeAdapter(CampaignItem)
T = datetime(2026, 10, 1, 8, 20, tzinfo=UTC)


class Header(TypedDict):
    name: str
    value: str


class MailBody(TypedDict):
    data: str


class MailPayload(TypedDict):
    mimeType: str
    headers: list[Header]
    filename: NotRequired[str]
    parts: NotRequired[list[MailPayload]]
    body: NotRequired[MailBody]


class MailMessage(TypedDict):
    id: str
    threadId: str
    labelIds: list[str]
    internalDate: str
    payload: MailPayload


def payload(part: MIMEPart[object, str]) -> MailPayload:
    out: MailPayload = {'mimeType': part.get_content_type(),
                        'headers': [{'name': key, 'value': str(value)} for key, value in part.items()],
                        'filename': part.get_filename() or ''}
    if part.is_multipart():
        out['parts'] = [payload(child) for child in part.iter_parts()]
    else:
        body = cast(object, part.get_payload(decode=True))
        if not isinstance(body, bytes):
            raise TypeError('mail fixture must decode to bytes')
        out['body'] = {'data': base64.urlsafe_b64encode(body).decode()}
    return out


def inbound(text: str, sender: str = 'alex@example.co.uk', mid: str = 'reply1', thread: str = 't1', auto: str | None = None) -> MailMessage:
    headers: list[Header] = [{'name': 'From', 'value': sender}, {'name': 'To', 'value': transport.SENDER}]
    if auto:
        headers.append({'name': 'Auto-Submitted', 'value': auto})
    return {'id': mid, 'threadId': thread, 'labelIds': ['INBOX'],
            'internalDate': str(int((T + timedelta(hours=1)).timestamp() * 1000)),
            'payload': {'mimeType': 'text/plain', 'headers': headers,
                        'body': {'data': base64.urlsafe_b64encode(text.encode()).decode()}}}


class Fake:
    def __init__(self, uncertain: bool = False, mismatch: bool = False, history: bool = False) -> None:
        self.identity: JsonObject | None = {'signature': '<div>Thibault Fritsch<br>Robinswood</div>', 'verificationStatus': 'accepted'}
        self.token: str = 'offline-fixture'
        self.messages: dict[str, MailMessage] = {}
        self.uncertain: bool = uncertain
        self.mismatch: bool = mismatch
        self.history: bool = history
        self.send_calls: int = 0

    def prepare(self, item: JsonObject, draft: Mapping[str, JsonValue], operation: str, parent: JsonObject | None = None) -> tuple[str, str, str]:
        return transport.Gateway.prepare(self, item, draft, operation, parent)

    def search(self, query: str) -> list[JsonObject]:
        if self.history:
            return [{'id': 'old-company-contact'}]
        if 'rfc822msgid:' in query:
            operation = query.split('rfc822msgid:')[1]
            return [{'id': key} for key, value in self.messages.items()
                    if transport.header(OBJECT_ADAPTER.validate_python(value), 'Message-ID').strip('<>') == operation]
        targets = [match.group(1) for match in re.finditer(r'(?:to|from):([^\s{}]+)', query)]
        result: list[JsonObject] = []
        for key, value in self.messages.items():
            message = OBJECT_ADAPTER.validate_python(value)
            addresses = transport.addresses(transport.header(message, 'To')) + transport.addresses(transport.header(message, 'From'))
            if any(address == target or address.endswith('@' + target) for address in addresses for target in targets):
                result.append({'id': key})
        return result

    def call(self, path: str, data: JsonValue | None = None) -> JsonObject:
        if data is not None:
            raise AssertionError('fixture call supports reads only')
        if path.startswith('/threads/'):
            thread = path.split('/')[2].split('?')[0]
            return {'messages': [OBJECT_ADAPTER.validate_python(value) for value in self.messages.values() if value['threadId'] == thread]}
        raise AssertionError(path)

    def get(self, mid: str) -> JsonObject:
        return OBJECT_ADAPTER.validate_python(copy.deepcopy(self.messages[mid]))

    def send(self, raw: str, thread_id: str | None = None, ops: Path | None = None) -> JsonObject:
        _ = ops
        self.send_calls += 1
        email: MIMEPart[object, str] = BytesParser(policy=policy.default).parsebytes(base64.urlsafe_b64decode(raw))
        key = 'm' + str(self.send_calls)
        message: MailMessage = {'id': key, 'threadId': thread_id or 't' + str(self.send_calls), 'labelIds': ['SENT'],
                                'payload': payload(email), 'internalDate': str(int(T.timestamp() * 1000))}
        if self.mismatch:
            message['payload']['headers'] = [header for header in message['payload']['headers'] if header['name'].lower() != 'to'] + [{'name': 'To', 'value': 'wrong@example.com'}]
        self.messages[key] = message
        if self.uncertain:
            self.uncertain = False
            raise TimeoutError()
        return {'id': key, 'threadId': message['threadId']}


class CampaignFixture(unittest.TestCase):
    def __init__(self, methodName: str = 'runTest') -> None:
        super().__init__(methodName)
        self.root: Path = Path('.')
        self.supp: Path = Path('.')
        self.item: CampaignItem ={'id':'one','company':'Example Scotland','domain':'example.co.uk','email':'alex@example.co.uk','firstName':'Alex','contactName':'Alex Example','role':'CEO','employeeMinimum':36,'employeeEvidenceUrl':'https://example.co.uk/about','scottishHeadquarters':True,'corporateType':'limited_company','roleEvidenceUrl':'https://example.co.uk/team','legalEvidenceUrl':'https://example.co.uk/legal','locationEvidenceUrl':'https://example.co.uk/contact','roleCheckedAt':m.stamp(T-timedelta(days=1)),'relevance':'financial controls'}
        self.c: ExecutiveCampaignContract ={'campaignId':'scotland-executive-conference-october-2026','sender':m.SENDER,'language':'en-GB','activation':'active','paidAdsAllowed':False,'crmMutationAllowed':False,'event':{'start':'2026-10-07','end':'2026-10-14'},'limits':{'dailyTouches':10,'weeklyTouches':40,'maxCompanies':40,'maxFollowups':1,'firstOutboundDate':'2026-10-01','lastInitialDate':'2026-10-08','lastOutboundDate':'2026-10-13'},'templates':{k:{'subject':'AI for {company}','body':"Hello {firstName},\n\nAn in-person session for {company}. Your work on {relevance} is relevant.\n\nReply 'no thanks' to opt out."} for k in ['A','B','followup']},'items':[self.item],'authorization':{'scopeSha256':'','source':'human_campaign_launch_request_2026-09-30','externalSendAuthorized':True}}
        self.proof: CampaignProof ={'checkedAt':m.stamp(T-timedelta(days=1)),'result':'deliverable','acceptAll':False,'score':100}

    @override
    def setUp(self) -> None:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root=Path(directory.name)
        self.supp=self.root/'suppression.json'
        m.save(self.supp,{'blockedRecipients':[],'records':[]})
        self.write()
        _ = self.enterContext(patch.object(m, 'GLOBAL_SUPPRESSION', self.supp))
    @override
    def tearDown(self) -> None:
        _ = self.doCleanups()
    def write(self) -> None:
        self.c['authorization']['scopeSha256']=m.digest(m.signed_scope(self.c))
        m.save(self.root/'campaign-contract.json',self.c)
        m.save(self.root/'email-evidence.json',{'items':{x['email']:self.proof for x in self.c['items']}})
    def runit(self, g: Fake | None = None, t: datetime = T, apply: bool = True) -> CampaignReport:
        return m.run(self.root,gateway=g or Fake(),apply=apply,t=t,suppression_path=self.supp)

    def assert_offline(self) -> None:
        offline_guard.assert_no_external_attempts()

    def changed_limits_payload(self, limits: dict[str, int]) -> JsonObject:
        contract = OBJECT_ADAPTER.validate_python(self.c)
        scope = OBJECT_ADAPTER.validate_python(m.signed_scope(self.c))
        updated_limits = OBJECT_ADAPTER.validate_python(self.c['limits'])
        updated_limits.update(limits)
        scope['limits'] = updated_limits
        contract['limits'] = updated_limits
        authorization = contract['authorization']
        if not isinstance(authorization, dict):
            raise TypeError('fixture authorization must be an object')
        authorization['scopeSha256'] = m.digest(scope)
        return contract
