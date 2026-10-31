"""Action queue recovery: preserve identifiers, deduplication and manual review."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from action_queue_contract import (
    make_action_id,
    normalize_action_item,
    normalize_action_list,
    validate_action_item,
)
from pydantic import JsonValue


class ActionQueueContractTests(unittest.TestCase):
    def test_missing_requirements_default_to_manual_review(self) -> None:
        item = normalize_action_item({}, origin_automation='qa')
        self.assertEqual(validate_action_item(item), [])
        self.assertEqual(item['actionType'], 'manual_review')
        self.assertIs(item['actionableNow'], False)
        self.assertEqual(item['blockingReason'], 'manual_review_required')
        self.assertEqual(item['id'], make_action_id('qa', 'manual_review', 'qa'))
        self.assertEqual(item['dedupeKey'], 'qa:manual_review:qa')

    def test_deduplication_preserves_first_action_and_required_evidence(self) -> None:
        rows: list[JsonValue] = [
            {'target': 'invoice-qa', 'notes': 'first evidence', 'links': ['qa://report'], 'priority': 'HIGH'},
            {'target': 'invoice-qa', 'notes': 'duplicate'},
            {'target': 'invoice-qa-2', 'actionableNow': True},
            'invalid-row',
        ]
        actions = normalize_action_list(rows, origin_automation='qa')
        self.assertEqual(len(actions), 2)
        self.assertEqual(actions[0]['notes'], 'first evidence')
        self.assertEqual(actions[0]['links'], ['qa://report'])
        self.assertEqual(actions[0]['priority'], 'high')
        self.assertIs(actions[1]['actionableNow'], True)

    def test_explicit_constraints_are_preserved_and_invalid_types_are_reported(self) -> None:
        raw: dict[str, JsonValue] = {'id': 'stable-qa', 'owner': 'human', 'blockingReason': ['qa-review'],
                                    'doneCondition': 'approved and verified', 'priority': 'unknown'}
        item = normalize_action_item(raw, origin_automation='qa')
        self.assertEqual(item['id'], 'stable-qa')
        self.assertEqual(item['owner'], 'human')
        self.assertEqual(item['doneCondition'], 'approved and verified')
        self.assertEqual(item['priority'], 'medium')
        self.assertIn('qa-review', str(item['blockingReason']))
        item['actionableNow'] = 'yes'
        item['priority'] = 'unrecognized'
        self.assertEqual(validate_action_item(item), ['invalid_priority:unrecognized', 'actionableNow_not_bool'])


if __name__ == '__main__':
    _ = unittest.main()
