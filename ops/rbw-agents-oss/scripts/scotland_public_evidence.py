"""Pure public-page evidence qualification; no network or file effects."""
from __future__ import annotations

import re
from collections.abc import Sequence
from datetime import UTC, datetime
from typing import NotRequired, override
from urllib import parse

from pydantic import TypeAdapter
from typing_extensions import TypedDict


class AudienceItem(TypedDict, extra_items=object):
    id: str
    company: str
    domain: str
    email: str
    contactName: str
    role: str
    firstName: NotRequired[str]
    relevance: NotRequired[str]
    qualification: NotRequired[str]
    employeeMinimum: NotRequired[int]
    employeeEvidenceUrl: NotRequired[str]
    scottishHeadquarters: NotRequired[bool]
    corporateType: NotRequired[str]
    roleEvidenceUrl: NotRequired[str | None]
    legalEvidenceUrl: NotRequired[str]
    locationEvidenceUrl: NotRequired[str]
    roleCheckedAt: NotRequired[str | None]
    addressSourceType: NotRequired[str | None]
    addressBindingEvidenceUrl: NotRequired[str]
    addressBindingCheckedAt: NotRequired[str]


class PublicPage(TypedDict, extra_items=object):
    url: str
    checkedAt: str
    text: str
    emails: NotRequired[list[str]]


AUDIENCE_ADAPTER: TypeAdapter[AudienceItem] = TypeAdapter(AudienceItem)
PAGE_ADAPTER: TypeAdapter[PublicPage] = TypeAdapter(PublicPage)
QUALIFIED = 'qualified_public_role_and_provider_company_evidence'


def own_public_url(url: str | None, domain: str) -> bool:
 parsed=parse.urlparse(url or '')
 return parsed.scheme=='https' and parsed.hostname in [domain,'www.'+domain] and not parsed.username and not parsed.password and parsed.port in [None,443]

def fresh_public_evidence(value: str | None) -> bool:
 if value is None:return False
 try:
  age=(datetime.now(UTC)-datetime.fromisoformat(value)).total_seconds()
  return 0<=age<=14*86400
 except (ValueError,TypeError,AttributeError):return False

def public_html(content: str) -> tuple[str, list[str]]:
 # Preserve addresses actually published in links, before removing HTML tags.
 import html
 from html.parser import HTMLParser
 class MailLinks(HTMLParser):
  def __init__(self) -> None:super().__init__();self.emails: set[str]=set()
  @override
  def handle_starttag(self,tag: str,attrs: list[tuple[str, str | None]]) -> None:
   if tag.lower()!='a':return
   href=dict(attrs).get('href') or ''
   if href.lower().startswith('mailto:'):
    address=parse.unquote(href[7:].split('?',1)[0]).strip().lower()
    if re.fullmatch(r'[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+',address):self.emails.add(address)
 links=MailLinks();links.feed(content)
 content=re.sub(r'<(?:script|style)\b[^>]*>.*?</(?:script|style)>',' ',content,flags=re.DOTALL|re.IGNORECASE)
 text=re.sub(r'\s+',' ',html.unescape(re.sub('<[^>]+>',' ',content)))
 return text,sorted(links.emails)

def qualified_review(item: AudienceItem) -> bool:
 return item.get('qualification')==QUALIFIED and item.get('corporateType')=='limited_company' and own_public_url(item.get('roleEvidenceUrl'),item['domain']) and fresh_public_evidence(item.get('roleCheckedAt')) and parse.urlparse(item.get('legalEvidenceUrl','')).scheme=='https'

def qualify_item(original: object, pages: Sequence[object]) -> AudienceItem:
 original = AUDIENCE_ADAPTER.validate_python(original)
 item=original.copy();legal: PublicPage | None=None;role_page: PublicPage | None=None;contradiction=False
 pages=[PAGE_ADAPTER.validate_python(p) for p in pages]
 pages=[p for p in pages if own_public_url(p.get('url'),item['domain']) and fresh_public_evidence(p.get('checkedAt'))]
 for page in pages:
  text=page['text']
  if re.search(r'\b(?:'+re.escape(item['company'])+r')\s+(?:group\s+)?(?:limited|ltd|plc)\b|company (?:registration )?(?:number|no\.)\s*(?:SC[0-9]{6}|[0-9]{8})|registered in scotland no[:. ]*SC[0-9]{6}',text,re.IGNORECASE):legal=page
  aliases={'Chief Executive Officer':'CEO|chief executive(?: officer)?','Managing Director':'managing director','Chief Financial Officer':'CFO|chief financial(?: officer)?','Chief Operating Officer':'COO|chief operating(?: officer)?','Chief Technology Officer':'CTO|chief technology officer|chief technical officer','Chief Information Officer':'CIO|chief information(?: officer)?','Chief Marketing Officer':'CMO|chief marketing(?: officer)?'}
  title=aliases.get(item['role'],re.escape(item['role']))
  # Only the title attached after this person's name is evidence. Nearby cards
  # and biography references to other executives cannot qualify this recipient.
  prefix=r'^[\s,:;–—\-()|&]*(?:(?:group|global|joint|co-founder|founder|and|is|our|the|serves|as)[\s,:;–—\-()|&]+){0,6}'
  for name in re.finditer(r'\b'+re.escape(item['contactName'])+r'\b',text,re.IGNORECASE):
   tail=text[name.end():name.end()+150]
   if re.search(prefix+r'(?:former|retired|previous)\s+(?:'+title+r')\b',tail,re.IGNORECASE):contradiction=True
   elif re.search(prefix+r'(?:'+title+r')\b',tail,re.IGNORECASE):
    role_page=page;item['roleEvidenceExcerpt']=text[max(0,name.start()-30):name.end()+250][:400]

 if legal and role_page and not contradiction:
  item.update(corporateType='limited_company',legalEvidenceUrl=legal['url'],roleEvidenceUrl=role_page['url'],roleCheckedAt=role_page['checkedAt'],qualification=QUALIFIED)
  if item.get('addressSourceType')=='generated':
   binding=next((p for p in pages if item['email'].lower() in p.get('emails',[]) or re.search(r'(?<![\w.+-])'+re.escape(item['email'])+r'(?![\w.-])',p['text'],re.IGNORECASE)),None)
   if binding:item.update(addressBindingEvidenceUrl=binding['url'],addressBindingCheckedAt=binding['checkedAt'])
   else:item.update(qualification='address_binding_requires_primary_confirmation',roleCheckedAt=None)
 elif not contradiction and qualified_review(original):
  # Keep the original proof and timestamp, including a separately reviewed primary page.
  item=original.copy()
 else:item.update(qualification='current_public_role_or_corporate_evidence_missing',roleCheckedAt=None)
 item['publicEvidenceCheckedAt']=datetime.now(UTC).isoformat().replace('+00:00','Z')
 return item
