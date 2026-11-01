"""Learning summary preserving the approved evidence and exploration rules."""
from __future__ import annotations

import random
import sqlite3
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from pydantic import TypeAdapter
from scotland_executive_conference_eligibility import dt
from scotland_executive_conference_state import state_rows
from scotland_executive_conference_types import (
    CampaignDraft,
    CampaignLearningArm,
    CampaignLearningResult,
)

DRAFT_ADAPTER: TypeAdapter[CampaignDraft] = TypeAdapter(CampaignDraft)

def business_days(start: datetime, end: datetime) -> int:
    day = start.astimezone(ZoneInfo('Europe/London')).date()
    final_day = end.astimezone(ZoneInfo('Europe/London')).date()
    count = 0
    while day < final_day:
        day += timedelta(days=1)
        count += day.weekday() < 5
    return count


def learn(db: sqlite3.Connection, t: datetime, copy_version: str | None = None) -> CampaignLearningResult:
    result: dict[str, CampaignLearningArm] = {}
    for variant in ('A', 'B'):
        rows = state_rows(db.execute(
            "SELECT * FROM touches WHERE step='initial' AND state='sent_verified' AND variant=?", (variant,)
        ))
        matured = [row['item'] for row in rows
                   if business_days(dt(row['created']), t) >= 3 and (
                       copy_version is None or
                       DRAFT_ADAPTER.validate_json(row['draft']).get('copyVersion', 'legacy') == copy_version)]
        reward_kind = 'qualified_need' if copy_version else 'qualified_interest'
        successes = {row['item'] for row in state_rows(db.execute(
            'SELECT * FROM replies WHERE kind=?', (reward_kind,)
        ))}
        success = len(successes & set(matured))
        result[variant] = {'maturedCompanies': len(matured), 'qualifiedCompanies': success,
                           'posteriorMean': (1 + success) / (2 + len(matured))}
    ready = all(arm['maturedCompanies'] >= 8 for arm in result.values()) and sum(
        arm['qualifiedCompanies'] for arm in result.values()) >= 3
    rng = random.Random(20261007)
    probability_a = sum(
        rng.betavariate(1 + result['A']['qualifiedCompanies'],
                       1 + result['A']['maturedCompanies'] - result['A']['qualifiedCompanies']) >
        rng.betavariate(1 + result['B']['qualifiedCompanies'],
                       1 + result['B']['maturedCompanies'] - result['B']['qualifiedCompanies'])
        for _ in range(5000)) / 5000 if ready else .5
    winner = ('A' if probability_a >= .95 else 'B' if probability_a <= .05 else None) if ready else None
    return {
        'arms': result, 'winner': winner,
        'allocation': 'balanced' if not winner else '75_percent_winner_25_percent_exploration',
        'reward': 'one_qualified_need_per_company' if copy_version else 'one_qualified_interest_per_company',
        'copyVersion': copy_version or 'legacy', 'probabilityABeatsB': probability_a,
        'minMaturedCompaniesPerArm': 8, 'opensUsed': False, 'automaticBudgetOrAudienceChanges': False,
    }
