"""Private duplicate identifiers are validated from the existing flow profile."""

from __future__ import annotations

import hashlib
import json
from typing import Annotated, ClassVar

from flow_contact_evidence_state import OBJECT
from pydantic import BaseModel, ConfigDict, Field
from robinswood_flow_core_support import technical_duplicates

type Identifier = Annotated[int, Field(gt=0)]
type AccountKey = Annotated[str, Field(min_length=1)]


class DuplicateTargets(BaseModel):
    model_config: ClassVar[ConfigDict] = ConfigDict(
        strict=True, extra="forbid", frozen=True
    )
    companies: Annotated[
        dict[AccountKey, tuple[Identifier, Identifier]], Field(min_length=1)
    ]
    contacts: dict[Identifier, tuple[AccountKey, Identifier]]
    falsePositiveContacts: dict[Identifier, AccountKey]

    @property
    def excluded_ids(self) -> set[int]:
        return (
            {pair[0] for pair in self.companies.values()}
            | set(self.contacts)
            | set(self.falsePositiveContacts)
        )


def targets() -> DuplicateTargets:
    value = DuplicateTargets.model_validate_json(json.dumps(technical_duplicates()))
    company_duplicates = [pair[0] for pair in value.companies.values()]
    if len(company_duplicates) != len(set(company_duplicates)):
        raise ValueError("duplicate_company_identifier_reused")
    if set(value.contacts) & set(value.falsePositiveContacts):
        raise ValueError("duplicate_contact_has_conflicting_roles")
    canonical = {pair[1] for pair in value.companies.values()} | {
        pair[1] for pair in value.contacts.values()
    }
    if canonical & value.excluded_ids:
        raise ValueError("canonical_identifier_is_also_excluded")
    if any(key not in value.companies for key, _ in value.contacts.values()):
        raise ValueError("duplicate_contact_account_unknown")
    if any(key not in value.companies for key in value.falsePositiveContacts.values()):
        raise ValueError("false_positive_account_unknown")
    return value


def duplicate_ids() -> set[int]:
    return targets().excluded_ids


def fingerprint(value: DuplicateTargets) -> str:
    canonical = json.dumps(
        OBJECT.validate_json(value.model_dump_json()),
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode()).hexdigest()
