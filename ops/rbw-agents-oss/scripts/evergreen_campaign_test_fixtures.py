"""Synthetic, offline fixtures shared by Evergreen campaign tests."""
import base64
from collections.abc import Iterable, Mapping
from contextlib import AbstractContextManager, ExitStack
from datetime import UTC, datetime
from email import policy as email_policy
from email.message import EmailMessage
from email.parser import BytesParser
from pathlib import Path
from types import ModuleType, TracebackType
from typing import cast, final, override
from unittest.mock import Mock, patch

import evergreen_campaign_data as data
import outbound_sender_guard as guard
import robinswood_evergreen_france as engine
from evergreen_campaign_data_types import (
 CampaignRunResult,
 JsonObject,
 JsonValue,
 data_coerce_json_object,
 data_json_object_or_empty,
 data_json_objects,
 data_text,
)

__all__ = ['EndGateway', 'EnginePatcher', 'FakeGateway', 'T', 'add_test_attachment', 'add_test_cc', 'body_of', 'change_test_campaign', 'change_test_sender', 'headers_of', 'message', 'object_path', 'patch_engine', 'payload_of', 'raw', 'sent_now']

T: datetime = datetime(2026, 10, 5, 8, 0, tzinfo=UTC)

def _header(message_value: JsonObject, name: str) -> str:
 payload=data_json_object_or_empty(message_value.get('payload'))
 for header in data_json_objects(payload.get('headers')):
  if data_text(header.get('name')).lower()==name.lower():return data_text(header.get('value'))
 return ''

def payload_of(message_value: JsonObject) -> JsonObject:
 return data_json_object_or_empty(message_value.get('payload'))

def body_of(message_value: JsonObject) -> JsonObject:
 return data_json_object_or_empty(payload_of(message_value).get('body'))

def headers_of(message_value: JsonObject) -> list[JsonObject]:
 return data_json_objects(payload_of(message_value).get('headers'))

def object_path(value: JsonObject, *keys: str) -> JsonObject:
 current = value
 for key in keys: current = data_json_object_or_empty(current.get(key))
 return current

def raw(op: str = 'test-op', lane: str = 'pme', email: str = 'alice@fixture.invalid', subject: str = 'Fixture') -> str:
 m = EmailMessage()
 m['From'] = guard.SENDER
 m['To'] = email
 m['Subject'] = subject
 m['Message-ID'] = '<' + op + '@robinswood.io>'
 m['X-RBW-Operation'] = op
 m['X-RBW-Campaign'] = engine.IDS[lane]
 m.set_content('Bonjour Alice,\n\nTexte approuvé.\n\nSignature réelle\n')
 return base64.urlsafe_b64encode(m.as_bytes()).decode()

def message(data: str, mid: str = 'sent-1', thread: str = 'thread-1', t: datetime = T) -> JsonObject:
 parsed = cast(object, BytesParser(policy=email_policy.default).parsebytes(base64.urlsafe_b64decode(data)))
 if not isinstance(parsed, EmailMessage): raise TypeError('expected an email message')
 checked_headers: list[tuple[str, str]] = []
 items = cast(Iterable[tuple[object, object]], parsed.items())
 for key, value in items:
  if not isinstance(key, str) or not isinstance(value, str): raise TypeError('expected text email headers')
  checked_headers.append((key, value))
 m = cast(EmailMessage, parsed)
 body = m.get_body(preferencelist=('plain',))
 if body is None: raise AssertionError('expected plain message body')
 content = cast(object, body.get_content())
 if not isinstance(content, str): raise TypeError('expected text message body')
 headers = [{'name': key, 'value': value} for key, value in checked_headers]
 return data_coerce_json_object({
  'id': mid,
  'threadId': thread,
  'labelIds': ['SENT'],
  'internalDate': str(int(t.timestamp() * 1000)),
  'payload': {
   'mimeType': 'text/plain',
   'headers': headers,
   'body': {'data': base64.urlsafe_b64encode(content.encode()).decode()},
  },
 })

@final
class FakeGateway:
 time: datetime = T

 def __init__(self) -> None:
  self.messages: dict[str, JsonObject] = {}
  self.posts = 0
  self.fail_after_post = False
  self.fail_before_post = False

 def get(self, mid: str) -> JsonObject:
  return self.messages[mid]

 def search(self, query: str) -> list[JsonObject]:
  if query.startswith('to:'):
   recipient = query.removeprefix('to:').split()[0].lower()
   return [{'id': item_id} for item_id, value in self.messages.items() if _header(value, 'To').lower() == recipient]
  suffix = query.split('rfc822msgid:')[-1]
  return [{'id': item_id} for item_id, value in self.messages.items() if _header(value, 'Message-ID').strip('<>') == suffix]

 def call(self, path: str) -> JsonObject:
  if path.startswith('/messages/'):
   return self.messages[path.split('/')[2].split('?')[0]]
  return {'messages': [{'id': item_id} for item_id in self.messages]}

 def post(self, data: str, thread: str | None = None) -> JsonObject:
  self.posts += 1
  if self.fail_before_post:
   raise TimeoutError('network ambiguity')
  message_id = 'sent-' + str(self.posts)
  actual_thread = thread or 'thread-' + str(self.posts)
  sent_message = message(data, message_id, actual_thread, t=self.time)
  self.messages[message_id] = sent_message
  if self.fail_after_post:
   raise TimeoutError('response lost')
  return {'id': sent_message['id'], 'threadId': sent_message['threadId']}


def add_test_cc(message_value: EmailMessage) -> None:
 message_value['Cc'] = 'other@fixture.invalid'
def change_test_sender(message_value: EmailMessage) -> None:
 message_value.replace_header('From', 'other@fixture.invalid')
def change_test_campaign(message_value: EmailMessage) -> None:
 message_value.replace_header('X-RBW-Campaign', 'unapproved')
def add_test_attachment(message_value: EmailMessage) -> None:
 message_value.add_attachment(b'x', maintype='application', subtype='octet-stream', filename='x.bin')

def sent_now(result: CampaignRunResult) -> int:
 counts = result.get('counts')
 if counts is None: raise AssertionError('campaign result omitted counts')
 return counts['sentNow']



class EnginePatcher:
 target: ModuleType
 name: str
 arguments: tuple[object, ...]
 options: dict[str, object]

 def __init__(self, name: str, *arguments: object, target_module: ModuleType = engine, **options: object) -> None:
  self.target = target_module
  self.name = name
  self.arguments = arguments
  self.options = options
  self.stack: ExitStack | None = None

 def __enter__(self) -> object:
  mirror_data_patch = self.target is engine and getattr(data, self.name, None) is getattr(engine, self.name, None)
  stack = ExitStack()
  self.stack = stack
  patch_options = dict(self.options)
  if not self.arguments and 'new' not in patch_options:
   patch_options['new_callable'] = Mock
  patch_context = cast(AbstractContextManager[object], patch.object(self.target, self.name, *self.arguments, **patch_options))
  replacement = stack.enter_context(patch_context)
  if mirror_data_patch:
   data_patch = cast(AbstractContextManager[object], patch.object(data, self.name, *self.arguments, **patch_options))
   _ = stack.enter_context(data_patch)
  return replacement

 def __exit__(self, exc_type: type[BaseException] | None, exc_value: BaseException | None, traceback: TracebackType | None) -> bool | None:
  if self.stack is None: raise RuntimeError('patch context was not entered')
  return self.stack.__exit__(exc_type, exc_value, traceback)

def patch_engine(name: str, *arguments: object, target_module: ModuleType = engine, **options: object) -> EnginePatcher:
 return EnginePatcher(name, *arguments, target_module=target_module, **options)



class EndGateway(engine.transport.GatewayPort):
 root: Path
 delegate: FakeGateway
 identity: JsonObject | None
 time: datetime

 def __init__(self, root: Path, t: datetime = T) -> None:
  self.token: str = ''
  self.delegate = FakeGateway()
  self.root = root
  self.time = t
  self.identity = {'signature': '<div>Thibault Fritsch<br>Robinswood</div>', 'verificationStatus': 'accepted'}

 @property
 def messages(self) -> dict[str, JsonObject]:
  return self.delegate.messages

 @property
 def posts(self) -> int:
  return self.delegate.posts

 @property
 def fail_after_post(self) -> bool:
  return self.delegate.fail_after_post

 @fail_after_post.setter
 def fail_after_post(self, value: bool) -> None:
  self.delegate.fail_after_post = value

 @override
 def call(self, path: str, data: JsonValue | None = None) -> JsonObject:
  if path == '/settings/sendAs':
   return {'sendAs': [{'sendAsEmail': guard.ROBB, 'verificationStatus': 'accepted', 'replyToAddress': guard.ROBB, 'signature': '<div>Thibault Fritsch<br>Robinswood</div>'}]}
  if path.startswith('/threads/'):
   thread_id = path.split('/')[2].split('?')[0]
   return {'messages': [item for item in self.delegate.messages.values() if item['threadId'] == thread_id]}
  return self.delegate.call(path)

 @override
 def search(self, query: str) -> list[JsonObject]:
  return self.delegate.search(query)

 @override
 def get(self, mid: str) -> JsonObject:
  return self.delegate.get(mid)

 @override
 def prepare(
  self,
  item: JsonObject,
  draft: Mapping[str, JsonValue],
  operation: str,
  parent: JsonObject | None = None,
 ) -> tuple[str, str, str]:
  return engine.Gateway.prepare(self, item, draft, operation, parent)

 def post(self, raw_message: str, thread_id: str | None = None) -> JsonObject:
  return self.delegate.post(raw_message, thread_id)

 @override
 def send(self, raw: str, thread_id: str | None = None, ops: Path | None = None) -> JsonObject:
  send_ops = self.root / 'sender' if ops is None else ops
  return guard.shared_send(self, raw, thread_id, lambda: self.post(raw, thread_id), ops=send_ops, t=self.time)
