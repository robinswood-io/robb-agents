"""Validated JSON boundaries for audience preparation and cached provider replies."""
from __future__ import annotations

from collections.abc import Mapping
from typing import NotRequired

from pydantic import JsonValue, TypeAdapter
from scotland_public_evidence import AudienceItem, PublicPage
from typing_extensions import TypedDict

type JsonObject = dict[str, JsonValue]
OBJECT: TypeAdapter[JsonObject] = TypeAdapter(JsonObject)
OBJECTS: TypeAdapter[list[JsonObject]] = TypeAdapter(list[JsonObject])
STRINGS: TypeAdapter[list[str]] = TypeAdapter(list[str])
PAGE: TypeAdapter[PublicPage] = TypeAdapter(PublicPage)

class CompanyResult(TypedDict, extra_items=object):
    domain: str
    company: JsonObject
    blocked: NotRequired[str]
    candidates: NotRequired[list[AudienceItem]]

class AudienceState(TypedDict, extra_items=object):
    items: list[AudienceItem]
    companies: NotRequired[dict[str, CompanyResult]]
    verifications: NotRequired[dict[str, JsonObject]]
    counts: NotRequired[dict[str, int]]
    generatedAt: NotRequired[str]
    updatedAt: NotRequired[str]
    stopReason: NotRequired[str]

STATE: TypeAdapter[AudienceState] = TypeAdapter(AudienceState)

def obj(value: object) -> JsonObject:
    return OBJECT.validate_python(value)

def objects(value: object) -> list[JsonObject]:
    return OBJECTS.validate_python(value)

def field(value: Mapping[str, JsonValue], name: str) -> JsonObject:
    return obj(value.get(name, {}))

def text(value: object) -> str:
    if not isinstance(value, str):
        raise TypeError("Expected a text field in audience evidence")
    return value

def optional_text(value: object) -> str | None:
    return None if value is None else text(value)

def number(value: object) -> int | float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise TypeError("Expected a numeric provider field")
    return value


def audience_counts(state: AudienceState) -> dict[str, int]:
    return {
        "verifiedAddresses": len(state["items"]),
        "companiesExamined": len(state.get("companies", {})),
        "distinctCandidateCompanies": len({item["domain"] for item in state["items"]}),
        "verificationRequests": len(state.get("verifications", {})),
    }
