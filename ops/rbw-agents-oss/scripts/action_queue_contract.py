#!/usr/bin/env python3
from __future__ import annotations

import hashlib
from typing import Any

ALLOWED_PRIORITIES = ('critical', 'high', 'medium', 'normal', 'low')
REQUIRED_ACTION_FIELDS = (
    'id',
    'originAutomation',
    'owner',
    'actionType',
    'priority',
    'actionableNow',
    'target',
    'blockingReason',
    'doneCondition',
)


def canonical_priority(value: str | None, default: str = 'medium') -> str:
    raw = str(value or default).strip().lower()
    return raw if raw in ALLOWED_PRIORITIES else default


def make_action_id(origin_automation: str, action_type: str, target: str) -> str:
    raw = f"{origin_automation}:{action_type}:{target}"
    return hashlib.sha1(raw.encode('utf-8')).hexdigest()[:16]


def normalize_action_item(
    raw: dict[str, Any],
    *,
    origin_automation: str,
    default_owner: str = 'agent',
    default_priority: str = 'medium',
    default_target: str | None = None,
    default_blocking_reason: str = 'manual_review_required',
    default_done_condition: str = 'L’action est exécutée ou explicitement close comme non applicable.',
) -> dict[str, Any]:
    action_type = str(raw.get('actionType') or 'manual_review')
    target = str(raw.get('target') or raw.get('id') or default_target or origin_automation)
    blocking_reason = raw.get('blockingReason')
    item = {
        'id': str(raw.get('id') or make_action_id(origin_automation, action_type, target)),
        'originAutomation': str(raw.get('originAutomation') or origin_automation),
        'owner': str(raw.get('owner') or default_owner),
        'actionType': action_type,
        'priority': canonical_priority(raw.get('priority'), default_priority),
        'actionableNow': bool(raw.get('actionableNow', False)),
        'target': target,
        'blockingReason': str(blocking_reason if blocking_reason not in {None, ''} else default_blocking_reason),
        'doneCondition': str(raw.get('doneCondition') or default_done_condition),
    }
    for key in (
        'campaign',
        'notes',
        'formUrl',
        'missingAssets',
        'dedupeKey',
        'status',
        'title',
        'summary',
        'links',
        'data',
    ):
        if key in raw and raw.get(key) is not None:
            item[key] = raw.get(key)
    if 'dedupeKey' not in item:
        item['dedupeKey'] = f"{item['originAutomation']}:{item['actionType']}:{item['target']}"
    return item


def normalize_action_list(items: list[dict[str, Any]], *, origin_automation: str) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for raw in items:
        if not isinstance(raw, dict):
            continue
        item = normalize_action_item(raw, origin_automation=origin_automation)
        dedupe = str(item.get('dedupeKey') or item['id'])
        if dedupe in seen:
            continue
        seen.add(dedupe)
        out.append(item)
    return out


def validate_action_item(item: dict[str, Any]) -> list[str]:
    issues: list[str] = []
    for field in REQUIRED_ACTION_FIELDS:
        if field not in item:
            issues.append(f'missing_field:{field}')
    if 'priority' in item and item.get('priority') not in ALLOWED_PRIORITIES:
        issues.append(f"invalid_priority:{item.get('priority')}")
    if 'actionableNow' in item and not isinstance(item.get('actionableNow'), bool):
        issues.append('actionableNow_not_bool')
    return issues
