"""Validated JSON contracts for the Scottish executive campaign."""
from __future__ import annotations

from typing import NotRequired, Required, TypedDict


class CampaignEvent(TypedDict, total=False, extra_items=object):
    start: Required[str]
    end: Required[str]


class CampaignLimits(TypedDict, total=False, extra_items=object):
    dailyTouches: Required[int]
    weeklyTouches: Required[int]
    maxCompanies: Required[int]
    firstOutboundDate: Required[str]
    lastInitialDate: Required[str]
    lastOutboundDate: Required[str]
    maxFollowups: Required[int]
    maxContacts: NotRequired[int]
    maxRunTouches: NotRequired[int]
    hourlyTouches: NotRequired[int]
    minimumSendIntervalSeconds: NotRequired[int]
    cadenceProfile: NotRequired[str]
    timezone: NotRequired[str]
    sendingWindows: NotRequired[list[list[str]]]


class CampaignScheduleChange(TypedDict, total=False, extra_items=object):
    source: Required[str]
    previousScopeSha256: NotRequired[str]
    previousLimits: NotRequired[CampaignLimits]


class CampaignAuthorization(TypedDict, total=False, extra_items=object):
    scopeSha256: Required[str]
    source: Required[str]
    dailyScheduleChange: NotRequired[CampaignScheduleChange]


class CampaignItem(TypedDict, total=False, extra_items=object):
    contactName: str
    id: Required[str]
    email: Required[str]
    domain: Required[str]
    company: Required[str]
    firstName: Required[str]
    relevance: Required[str]
    role: NotRequired[str]
    employeeMinimum: NotRequired[int]
    employeeEvidenceUrl: NotRequired[str]
    scottishHeadquarters: NotRequired[bool]
    corporateType: NotRequired[str]
    roleEvidenceUrl: NotRequired[str]
    legalEvidenceUrl: NotRequired[str]
    locationEvidenceUrl: NotRequired[str]
    roleCheckedAt: NotRequired[str | None]
    qualification: NotRequired[str]


class CampaignProof(TypedDict, total=False, extra_items=object):
    checkedAt: NotRequired[str]
    result: NotRequired[str]
    acceptAll: NotRequired[bool]
    score: NotRequired[float]


class CampaignEvidence(TypedDict, total=False, extra_items=object):
    email: str
    domain: str
    contactName: str
    id: Required[str]
    qualification: NotRequired[str]
    roleEvidenceUrl: NotRequired[str]
    roleCheckedAt: NotRequired[str | None]
    legalEvidenceUrl: NotRequired[str]
    corporateType: NotRequired[str]
    role: NotRequired[str]
    employeeEvidenceUrl: NotRequired[str]
    locationEvidenceUrl: NotRequired[str]
    scottishHeadquarters: NotRequired[bool]


class CampaignProofDocument(TypedDict, total=False, extra_items=object):
    items: Required[dict[str, CampaignProof]]


class CampaignEvidenceDocument(TypedDict, total=False, extra_items=object):
    items: Required[list[CampaignEvidence]]


class CampaignLearningArm(TypedDict):
    maturedCompanies: int
    qualifiedCompanies: int
    posteriorMean: float


class CampaignLearningResult(TypedDict):
    reward: str
    probabilityABeatsB: float
    minMaturedCompaniesPerArm: int
    opensUsed: bool
    automaticBudgetOrAudienceChanges: bool
    arms: dict[str, CampaignLearningArm]
    winner: str | None
    allocation: str
    copyVersion: str | None


class CampaignDraft(TypedDict, total=False, extra_items=object):
    subject: Required[str]
    body: Required[str]
    copyVersion: NotRequired[str]


class CampaignTemplate(TypedDict, total=False, extra_items=object):
    subject: Required[str]
    body: Required[str]
    url: NotRequired[str]
    version: NotRequired[str]


class CampaignLane(TypedDict, total=False):
    dailyMax: NotRequired[int]
    weeklyMax: NotRequired[int]


class SignedCampaignScope(TypedDict):
    campaignId: str
    event: CampaignEvent
    limits: CampaignLimits
    templates: dict[str, CampaignTemplate]
    items: list[CampaignItem]
    sender: str
    language: str
    paidAdsAllowed: bool
    crmMutationAllowed: bool


class ExecutiveCampaignContract(TypedDict, total=False):
    campaignId: Required[str]
    authorization: Required[CampaignAuthorization]
    sender: Required[str]
    language: Required[str]
    event: Required[CampaignEvent]
    limits: Required[CampaignLimits]
    items: Required[list[CampaignItem]]
    templates: Required[dict[str, CampaignTemplate]]
    activation: Required[str]
    paidAdsAllowed: Required[bool]
    crmMutationAllowed: Required[bool]
    timezone: NotRequired[str]
    lanes: NotRequired[dict[str, CampaignLane]]


class CampaignDecision(TypedDict, total=False):
    id: Required[str]
    company: Required[str]
    step: Required[str]
    variant: Required[str]
    blockingReasons: Required[list[str]]
    status: Required[str]
    gmailMessageId: str
    gmailThreadId: str
    errorType: str


class CampaignFunnel(TypedDict):
    programmeRequestedCompanies: int
    interestCompanies: int
    qualifiedNeedCompanies: int
    programmeDeliveredCompanies: int
    meetingsConfirmed: None
    conferencesBooked: None
    bookingEvidenceAvailable: bool


class CampaignReport(TypedDict, extra_items=object):
    blockingReasons: list[str]
    audienceContacts: int
    audienceCompanies: int
    qualifiedAudienceContacts: int
    qualifiedAudienceCompanies: int
    ok: bool
    status: str
    externalSendsThisRun: int
    verifiedSendsTotal: int
    qualifiedCompanies: int
    counts: dict[str, int]
    decisions: list[CampaignDecision]
    learning: CampaignLearningResult
    simulation: bool
    commercialFunnel: CampaignFunnel
    copyVersion: str
    hourlyTouchesUsed: int
    dailyTouchesUsed: int
    weeklyTouchesUsed: int
    authorizationScopeSha256: str
