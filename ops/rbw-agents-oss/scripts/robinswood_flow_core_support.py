from __future__ import annotations

import base64
import hashlib
import json
import os
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal, NotRequired, TypedDict
from zoneinfo import ZoneInfo

from pydantic import JsonValue, TypeAdapter, ValidationError

ROOT = Path(os.environ.get("RBW_OSS_ROOT", "/srv/rbw-agents-oss"))
WS = Path(os.environ.get("RBW_FLOW_WORKSPACE", "/home/craft/.craft-agent/workspaces/my-workspace-2"))
OPS = WS / "campaigns" / "ops"
CAM = WS / "campaigns"
TZ = ZoneInfo("Europe/Paris")

APPROVAL = OPS / "robinswood-flow-approval-queue.json"
COMPOSE = Path(os.environ.get("RBW_FLOW_COMPOSE", str(ROOT / "compose/.env")))
CONTRACT = ROOT / "config/robinswood-flow-outbound-chain.json"
CRMSTATE = OPS / "robinswood-flow-sellsy-sync-state.json"
EMAILQ = OPS / "robinswood-flow-email-action-queue.json"
EVENTS = OPS / "robinswood-flow-attribution-events.jsonl"
GOOGLE_CREDS = Path(os.environ.get("RBW_FLOW_GOOGLE_CREDS", "/home/craft/.craft-agent/xdg-config/google-mcp/credentials.json"))
GOOGLE_TOKENS = Path(os.environ.get("RBW_FLOW_GOOGLE_TOKENS", "/home/craft/.craft-agent/xdg-data/google-mcp/tokens.json"))
HUMAN = OPS / "robinswood-flow-human-action-queue.json"
JsonObject = dict[str, JsonValue]

class FlowProfile(TypedDict):
    sender: str
    accountKey: str
    sourceMessageId: str
    sourceThreadId: str
    accounts: list[JsonObject]
    staleMessageIds: list[str]
    privateTextValues: dict[str, str]
    technicalDuplicates: NotRequired[JsonObject]

LEDGER = OPS / "robinswood-flow-sequence-ledger.jsonl"
LIQ = OPS / "robinswood-flow-linkedin-action-queue.json"
PROFILE_PATH = Path(os.environ.get("RBW_FLOW_PROFILE", "/etc/rbw-agents-oss/robinswood-flow-profile.json"))
REG = OPS / "robinswood-flow-account-registry.json"
REPLY = OPS / "robinswood-flow-reply-state.json"
SUPPRESSION = CAM / "contact-suppression.json"
JSON_ADAPTER: TypeAdapter[JsonValue] = TypeAdapter(JsonValue)
JSON_OBJECT_ADAPTER: TypeAdapter[JsonObject] = TypeAdapter(dict[str, JsonValue])




def id_value(value: JsonValue | None) -> str | int | None:
    if isinstance(value, str) and value:
        return value
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    return None

def object_value(value: JsonValue, code: str) -> JsonObject:
    if not isinstance(value, dict):
        raise TypeError(code)
    return JSON_OBJECT_ADAPTER.validate_python(value)

def _object_list(value: JsonValue | None, code: str) -> list[JsonObject]:
    if not isinstance(value, list):
        raise TypeError(code)
    return [object_value(item, code) for item in value]

def optional_object(value: JsonValue | None, code: str) -> JsonObject:
    if value is None:
        return {}
    return object_value(value, code)

def required_text(value: JsonValue | None, code: str) -> str:
    return string_value(value, code)

def rows_value(value: JsonValue | None, code: str) -> list[JsonObject]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise TypeError(code)
    return [object_value(item, code) for item in value]

def string_value(value: JsonValue | None, code: str) -> str:
    if not isinstance(value, str) or not value:
        raise TypeError(code)
    return value

def _string_list(value: JsonValue | None, code: str) -> list[str]:
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        raise TypeError(code)
    return [item for item in value if isinstance(item, str)]

def string_values(value: JsonValue | None, code: str) -> list[str]:
    if value is None:
        return []
    return _string_list(value, code)

def text_value(value: JsonValue | None, default: str = "") -> str:
    return value if isinstance(value, str) else default

def validated_object(value: object, code: str) -> JsonObject:
    return object_value(JSON_ADAPTER.validate_python(value), code)

def values(value: JsonValue | None, code: str) -> list[JsonValue]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise TypeError(code)
    return value

def account_key() -> str:
    return profile()["accountKey"]

def accounts() -> list[JsonObject]:
    return profile()["accounts"]

def append_unique(path: Path, row: object, key: str) -> bool:
    record = object_value(JSON_ADAPTER.validate_python(row), "ledger_row_must_be_object")
    if any(str(existing.get(key)) == str(record.get(key)) for existing in rows(path)):
        return False
    _ = path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as stream:
        _ = stream.write(json.dumps(record, ensure_ascii=False) + "\n")
    return True

def load(path: Path, default: JsonObject) -> JsonObject:
    if not path.exists():
        return default
    try:
        value = JSON_ADAPTER.validate_json(path.read_bytes())
    except (OSError, ValidationError) as exc:
        raise RuntimeError("state_file_invalid") from exc
    return object_value(value, "state_file_must_be_object")

def localnow() -> datetime:
    return datetime.now(TZ)

def now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")

def private_text(key: str) -> str:
    values = profile()["privateTextValues"]
    return string_value(values.get(key), "flow_profile_missing_" + key)

def profile() -> FlowProfile:
    if not PROFILE_PATH.is_file():
        raise RuntimeError("flow_profile_missing")
    try:
        value = JSON_ADAPTER.validate_json(PROFILE_PATH.read_bytes())
    except (OSError, ValidationError) as exc:
        raise RuntimeError("flow_profile_invalid") from exc
    data = object_value(value, "flow_profile_must_be_object")
    account_rows = _object_list(data.get("accounts"), "flow_profile_accounts_invalid")
    for account in account_rows:
        _ = required_text(account.get("key"), "flow_profile_account_key_invalid")
    if len(account_rows) != 13:
        raise RuntimeError("flow_profile_account_count_invalid")
    account_value = string_value(data.get("accountKey"), "flow_profile_account_key_invalid")
    if sum(1 for row in account_rows if row.get("key") == account_value) != 1:
        raise RuntimeError("flow_profile_approved_account_invalid")
    text_values = object_value(data.get("privateTextValues"), "flow_profile_text_values_invalid")
    if any(not isinstance(item, str) or not item for item in text_values.values()):
        raise RuntimeError("flow_profile_text_value_invalid")
    typed_profile: FlowProfile = {
        "sender": string_value(data.get("sender"), "flow_profile_missing_sender"),
        "accountKey": account_value,
        "sourceMessageId": string_value(data.get("sourceMessageId"), "flow_profile_missing_sourceMessageId"),
        "sourceThreadId": string_value(data.get("sourceThreadId"), "flow_profile_missing_sourceThreadId"),
        "accounts": account_rows,
        "staleMessageIds": _string_list(data.get("staleMessageIds"), "flow_profile_stale_ids_invalid"),
        "privateTextValues": {key: item for key, item in text_values.items() if isinstance(item, str)},
    }
    if "technicalDuplicates" in data:
        typed_profile["technicalDuplicates"] = object_value(data.get("technicalDuplicates"), "flow_profile_technical_duplicates_invalid")
    return typed_profile

def technical_duplicates() -> JsonObject:
    value = profile().get("technicalDuplicates")
    if value is None:
        raise RuntimeError("flow_profile_technical_duplicates_missing")
    return value

def report(mode: str, data: object, ok: bool = True, status: str = "processed") -> int:
  payload = validated_object(data, "report_payload_invalid")
  output_path = OPS / f'robinswood-flow-{mode.replace("_", "-")}-last.json'
  markdown_path = output_path.with_suffix('.md')
  env = validated_object({'generatedAt': now(), 'contractVersion': 'robinswood-flow-runtime-v1', 'capabilityId': f"robinswood-flow-{mode.replace('_', '-')}" + mode.replace('_', '-'), 'ok': ok, 'status': status, **payload}, 'report_envelope_invalid')
  save(output_path, env)
  counts = payload.get('counts') or payload.get('summary') or {}
  _ = markdown_path.write_text(f"# Robinswood Flow — {mode}\n\n- Generated: {env['generatedAt']}\n- Status: `{status}`\n- OK: **{ok}**\n- Summary: {json.dumps(counts, ensure_ascii=False)}\n", encoding='utf-8')
  print(json.dumps({'ok': ok, 'status': status, 'counts': payload.get('counts'), 'artifacts': {'json': str(output_path), 'md': str(markdown_path)}}, ensure_ascii=False))
  return 0 if ok else 1

def rows(path: Path) -> list[JsonObject]:
    result: list[JsonObject] = []
    try:
        lines = path.read_text(encoding="utf-8", errors="ignore").splitlines()
    except OSError:
        return result
    for line in lines:
        try:
            value = JSON_ADAPTER.validate_json(line)
        except ValidationError:
            continue
        if isinstance(value, dict):
            result.append(JSON_OBJECT_ADAPTER.validate_python(value))
    return result

def save(path: Path, data: object) -> None:
    value = JSON_ADAPTER.validate_python(data)
    _ = path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name("." + path.name + ".tmp")
    _ = temporary.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
    _ = temporary.replace(path)

def sender_email() -> str:
    return profile()["sender"]

def source_message_id() -> str:
    return profile()["sourceMessageId"]

def source_thread_id() -> str:
    return profile()["sourceThreadId"]

def stable(prefix: str, *parts: object) -> str:
    value = "|".join(str(part) for part in parts)
    return prefix + ":" + hashlib.sha256(value.encode()).hexdigest()[:20]

def stale_message_ids() -> list[str]:
    return profile()["staleMessageIds"]


def suppressed(email: str) -> bool:
    _ = profile()
    o = load(SUPPRESSION, {})
    return any(str((x or {}).get('email') or (x or {}).get('value') or '').lower() == email.lower() and ((x or {}).get('active') is True or str((x or {}).get('status') or '').lower() in {private_text('text_050'), 'blocked', 'unsubscribe', 'opt_out'}) for k in ('records', 'blockedRecipients') for x in rows_value(o.get(k), 'suppression_entries_invalid'))


def classify(text: str, frm: str='') -> Literal['ambiguous', 'hard_bounce', 'opt_out', 'out_of_office', 'positive_or_referral', 'objection', 'negative']:
    t = (text + ' ' + frm).lower()
    if any(x in t for x in ('mailer-daemon', 'postmaster', 'status: 5.', 'permanent error', 'recipient address rejected')):
        return 'hard_bounce'
    if any(x in t for x in ('unsubscribe', 'désabonner', 'desabonner', 'ne me contactez plus', 'remove me', 'opt out', 'opt-out')):
        return 'opt_out'
    if any(x in t for x in ('out of office', 'automatic reply', 'réponse automatique', 'absent du bureau', 'de retour le')):
        return 'out_of_office'
    if any(x in t for x in ('rendez-vous', 'disponible', 'intéressé', 'interesse', 'volontiers', 'avec plaisir', 'orienter', 'mettre en relation')):
        return 'positive_or_referral'
    if any(x in t for x in ('pas intéressé', 'pas interesse', 'non merci', 'pas maintenant')):
        return 'objection'
    return 'ambiguous'


def seq_stopped() -> bool:
    _ = profile()
    state = load(REPLY, {})
    accounts_state = optional_object(state.get('accounts'), 'reply_accounts_invalid')
    account_state = optional_object(accounts_state.get(account_key()), 'reply_account_invalid')
    stopped_accounts = optional_object(state.get('sequenceStoppedAccounts'), 'stopped_accounts_invalid')
    return bool(account_state.get('sequenceStopped')) or bool(stopped_accounts.get(account_key())) or suppressed(sender_email())


def hdict(msg: JsonObject) -> dict[str, str]:return {str(x.get('name') or '').lower():str(x.get('value') or '') for x in (rows_value(object_value(msg.get('payload'), 'gmail_payload_invalid').get('headers'), 'gmail_headers_invalid'))}


def btext(payload: JsonObject) -> str:
  _ = profile()
  out: list[str] = []
  def walk(part: JsonObject) -> None:
   body = optional_object(part.get('body'), 'gmail_body_invalid')
   data = text_value(body.get('data'))
   mime = text_value(part.get('mimeType'))
   if data and mime in {'text/plain', 'text/html'}:
    decoded = base64.urlsafe_b64decode(data + '=' * ((4 - len(data) % 4) % 4)).decode('utf-8', 'ignore')
    out.append(re.sub(r'<[^>]+>', ' ', decoded) if mime == 'text/html' else decoded)
   for child in rows_value(part.get('parts'), 'gmail_parts_invalid'):
    walk(child)
  walk(payload)
  return re.sub(r'\s+', ' ', ' '.join(out)).strip()


def due(x: JsonObject) -> bool:return localnow()>=datetime.fromisoformat(required_text(x.get('dueAt'), 'due_at_missing')).astimezone(TZ)





def stop_future(reason: str, source: str) -> None:
    _ = profile()
    for path in (EMAILQ, LIQ):
        queue = load(path, {})
        for item in rows_value(queue.get('items'), 'queue_items_invalid'):
            if item.get('status') == 'scheduled_conditional':
                item['status'] = 'cancelled_by_signal'
                item['cancelReason'] = reason
                item['cancelSource'] = source
                item['cancelledAt'] = now()
        save(path, queue)


def add_suppression(email: str, reason: str, source: str) -> None:
    _ = profile()
    state = load(SUPPRESSION, {})
    records = rows_value(state.get('records'), 'suppression_records_invalid')
    exists = any(text_value(item.get('email')).lower() == email.lower() for item in records)
    if not exists:
        records.append(validated_object({'email': email, 'status': 'do_not_contact', 'active': True, 'reason': reason, 'source': source, 'createdAt': now()}, 'suppression_record_invalid'))
        state['records'] = JSON_ADAPTER.validate_python(records)
        save(SUPPRESSION, state)
