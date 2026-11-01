"""Read-only Gmail legacy reconciliation; no external sends or OAuth-secret output."""
from __future__ import annotations

import argparse
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Protocol
from urllib import error

from pydantic import JsonValue, TypeAdapter
from scotland_conference_transport import SENDER, Gateway, addresses, header, plain
from scotland_executive_conference_eligibility import dt
from scotland_executive_conference_october import digest, save

type JsonObject = dict[str, JsonValue]
OBJECT_ADAPTER: TypeAdapter[JsonObject] = TypeAdapter(dict[str, JsonValue])
ROOT = Path('/home/craft/.craft-agent/workspaces/my-workspace-2/campaigns/ops')
OUT = ROOT / 'product-campaigns/robinswood-evergreen-france/legacy-gmail-audit.json'
LEDGERS = ('robinswood-media-authority-2026-ledger.jsonl', 'robinswood-pme-hdf-audited-mailer-ledger.jsonl')
SUMMARY_KEYS = ('totalUniqueHistoricalMessages', 'completed', 'verified', 'unverified', 'newExternalSends')


class ReadGateway(Protocol):
    def get(self, mid: str) -> JsonObject: ...


def _text(value: JsonValue) -> str:
    if not isinstance(value, str):
        raise TypeError('historical_audit_text_required')
    return value


def run(limit: int = 15, gateway: ReadGateway | None = None) -> JsonObject:
    result: JsonObject = OBJECT_ADAPTER.validate_json(OUT.read_bytes()) if OUT.exists() else {
        'checked': {}, 'startedAt': datetime.now(UTC).isoformat(), 'newExternalSends': 0,
    }
    checked_records = result.get('checked')
    if not isinstance(checked_records, dict):
        raise TypeError('historical_audit_checked_records_required')
    rows: list[JsonObject] = []
    for name in LEDGERS:
        for line in (ROOT / name).read_text().splitlines():
            record = OBJECT_ADAPTER.validate_json(line)
            mid = record.get('gmailMessageId')
            if mid and (record.get('event') == 'sent' or record.get('status') in (
                'sent', 'sent_verified', 'sent_needs_manual_verification',
            )):
                rows.append({
                    'messageId': _text(mid), 'email': record.get('email') or record.get('recipientEmail'),
                    'subject': record.get('subject'), 'thread': record.get('threadId') or record.get('gmailThreadId'),
                    'campaign': record.get('campaignId'), 'sentAt': record.get('sentAt') or record.get('generatedAt'),
                })
    gateway = gateway or Gateway()
    for row in [row for row in rows if _text(row['messageId']) not in checked_records][:limit]:
        message_id = _text(row['messageId'])
        try:
            message = gateway.get(message_id)
            labels = message.get('labelIds', [])
            if not isinstance(labels, list):
                raise TypeError('historical_audit_labels_required')
            checks = {
                'SENT': 'SENT' in labels,
                'recipient': addresses(header(message, 'To')) == [_text(row['email']).lower()],
                'sender': addresses(header(message, 'From')) == [SENDER],
                'subject': header(message, 'Subject') == row['subject'],
                'thread': not row['thread'] or message.get('threadId') == row['thread'],
                'timestamp': abs(int(_text(message['internalDate'])) / 1000 - dt(_text(row['sentAt'])).timestamp()) < 600,
            }
            payload = message.get('payload')
            if not isinstance(payload, dict):
                raise TypeError('historical_audit_payload_required')
            checked_records[message_id] = {
                'campaign': row['campaign'], 'expectedRecipientSha256': digest(_text(row['email']).lower()),
                'checks': OBJECT_ADAPTER.validate_python(checks), 'ok': all(checks.values()),
                'actualThreadId': message.get('threadId'), 'actualInternalDate': message['internalDate'],
                'bodySha256': digest(plain(payload)),
                'bodyVerification': 'historical_body_not_in_ledger_no_exact_body_claim',
            }
        except (error.URLError, OSError, ValueError, TypeError, KeyError) as exc:
            checked_records[message_id] = {
                'campaign': row['campaign'], 'ok': False, 'error': type(exc).__name__, 'replayForbidden': True,
            }
        result['updatedAt'] = datetime.now(UTC).isoformat()
        save(OUT, result)
    total = len({_text(row['messageId']) for row in rows})
    checked = len(checked_records)
    verified = sum(isinstance(entry, dict) and entry.get('ok') is True for entry in checked_records.values())
    result.update(
        totalUniqueHistoricalMessages=total, completed=checked == total, verified=verified, unverified=checked - verified,
        historicalHDF={'sent': 48, 'hardBounces': 5, 'rate': 5 / 48, 'reset': False},
        legacySenderSecurityDisposition='quarantined_legacy_lane; new signed contract uses durable reservation, explicit signature and exact Gmail read-back',
    )
    save(OUT, result)
    return {key: result[key] for key in SUMMARY_KEYS}


class Arguments(argparse.Namespace):
    limit: int = 15


def main() -> None:
    parser = argparse.ArgumentParser()
    _ = parser.add_argument('--limit', type=int, default=15)
    args = parser.parse_args(namespace=Arguments())
    print(json.dumps(run(min(max(args.limit, 1), 30))))


if __name__ == '__main__':
    main()
