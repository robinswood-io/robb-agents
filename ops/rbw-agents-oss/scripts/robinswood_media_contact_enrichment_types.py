"""Precise JSON and candidate contracts for media-contact enrichment."""
from __future__ import annotations

from typing import NotRequired, TypedDict

from pydantic import TypeAdapter

type JsonValue = str | int | float | bool | None | list[JsonValue] | dict[str, JsonValue]
type JsonObject = dict[str, JsonValue]
type HttpParams = dict[str, str]
JSON_VALUE_ADAPTER: TypeAdapter[JsonValue] = TypeAdapter(JsonValue)


class EmailVerificationResult(TypedDict, total=False, extra_items=JsonValue):
    provider: str
    result: str
    score: int | float | str
    statusCode: int | None
    smtpCheck: JsonValue
    acceptAll: JsonValue


class EnrichedCandidate(TypedDict, total=False, extra_items=JsonValue):
    emailVerification: EmailVerificationResult
    outreachEligible: bool
    outreachStatus: str
    enrichmentStatus: str
    nextStep: str
    enrichedAt: str
    emailStatus: str
    enrichedEmail: str
    profileEnrichment: ProfileEnrichment


class ExternalLink(TypedDict):
    url: str
    domain: str


class ProfileEnrichment(TypedDict):
    provider: str
    ok: bool
    extract: str
    externalLinks: list[ExternalLink]
    checkedAt: str


class WikiEnrichment(TypedDict):
    ok: bool
    extract: str
    externalLinks: list[ExternalLink]
    error: NotRequired[str]
