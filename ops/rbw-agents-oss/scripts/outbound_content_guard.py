from __future__ import annotations

import json
import re
import unicodedata
from collections.abc import Mapping
from html.parser import HTMLParser
from pathlib import Path
from typing import TypedDict, override

from pypdf import PdfReader
from pypdf.errors import PyPdfError

type Contact = Mapping[str, object]

class Salutation(TypedDict):
 salutation: str
 mode: str
 first_name: str
 last_name: str
 civility: str | None
 civilitySource: str | None
 inferenceUsed: bool

class PDFQuality(TypedDict):
 ok: bool
 contractVersion: str
 pdfPath: str | None
 htmlPath: str | None
 bytes: int | None
 minBytes: int
 maxBytes: int
 textChars: int
 reasons: list[str]

CONTRACT_VERSION="outbound-content-guard-v1"
PDF_BRAND_CONTRACT_VERSION="robinswood-client-pdf-brand-v1"
PDF_MIN_BRANDED_BYTES=20_000
PDF_MAX_BRANDED_BYTES=5_000_000
ATTACHMENT_PATTERNS=(r"\bje\s+joins\b",r"\bci[- ]joint(?:e|es|s)?\b",r"\ben\s+pi[eè]ce\s+jointe\b",r"\bpi[eè]ce\s+jointe\b",r"\battached\b",r"\battachment\b")
CHALLENGE_SENDERS=("invitations.mailinblack.com","challenge-response","email-protection")
CHALLENGE_TEXT=("un clic pour délivrer votre email","un clic pour delivrer votre email","cliquez pour délivrer votre email","cliquez pour delivrer votre email","je suis protégé par protect de mailinblack","je suis protege par protect de mailinblack","confirm you are human","verify you are human","sender verification challenge")
CIVILITY={"madame":"Madame","mme":"Madame","mrs":"Madame","ms":"Madame","monsieur":"Monsieur","m":"Monsieur","mr":"Monsieur"}
VERIFIED_SOURCES={"explicit","provided","crm_verified","public_source","official_source"}
def clean(v:object)->str:return re.sub(r"\s+"," ",str(v or "").strip())
def token(v:object)->str:
 s="".join(c for c in unicodedata.normalize("NFKD",clean(v)) if not unicodedata.combining(c)).lower();return re.sub(r"[^a-z]+","",s)
def mentions_attachment(body:object)->bool:return any(re.search(p,clean(body),re.IGNORECASE) for p in ATTACHMENT_PATTERNS)
def attachment_semantic_reasons(body:object,expected_count:int)->list[str]:
 n=int(expected_count or 0);mentioned=mentions_attachment(body);reasons:list[str]=[]
 if n not in (0,1):reasons.append("attachment_count_not_bounded_to_zero_or_one")
 if mentioned and n!=1:reasons.append("body_mentions_attachment_but_exactly_one_not_expected")
 if n==1 and not mentioned:reasons.append("one_attachment_expected_but_body_does_not_disclose_it")
 return reasons
def split_name(v:object)->tuple[str,str]:
 p=clean(v).split();return (p[0]," ".join(p[1:])) if p else ("","")
def contact_names(c:Contact)->tuple[str,str]:
 first,last=clean(c.get("first_name")),clean(c.get("last_name"))
 if first or last:return first,last
 for k in ("recipientName","decisionMakerName","contact_name","fullName","name"):
  if clean(c.get(k)):return split_name(c[k])
 return "",""
def verified_civility(c:Contact)->tuple[str|None,str|None]:
 civ=CIVILITY.get(token(c.get("civility") or c.get("title_civility")))
 source=clean(c.get("civility_source") or c.get("civilitySource") or c.get("civility_proof_source")).lower() or "explicit"
 return (civ,source) if civ and source in VERIFIED_SOURCES else (None,None)
def safe_salutation(c:Contact)->Salutation:
 first,last=contact_names(c);civ,source=verified_civility(c)
 if civ and last:greeting,mode=f"Bonjour {civ} {last},","verified-civility-last-name"
 else:greeting,mode="Bonjour,","neutral-generic"
 return {"salutation":greeting,"mode":mode,"first_name":first,"last_name":last,"civility":civ if last else None,"civilitySource":source if last else None,"inferenceUsed":False}
def apply_safe_salutation(body:object,c:Contact)->tuple[str,Salutation]:
 text=str(body or "").strip();resolved=safe_salutation(c);lines=text.splitlines()
 if lines and lines[0].strip().lower().startswith("bonjour"):lines[0]=resolved["salutation"];text="\n".join(lines)
 else:text=resolved["salutation"]+("\n\n"+text if text else "")
 return text,resolved
def salutation_reasons(body:object,c:Contact)->list[str]:
 lines=str(body or "").strip().splitlines();actual=lines[0].strip() if lines else "";reasons:list[str]=[]
 if actual!=safe_salutation(c)["salutation"]:reasons.append("salutation_not_equal_to_safe_resolved_value")
 if re.match(r"^Bonjour\s+(Monsieur|Madame)\b",actual) and not verified_civility(c)[0]:reasons.append("unverified_gendered_civility_forbidden")
 return reasons
def is_delivery_challenge(from_email:object,subject:object,body:object)->bool:
 sender=clean(from_email).lower();text=(clean(subject)+" "+clean(body)).lower();return any(x in sender for x in CHALLENGE_SENDERS) or any(x in text for x in CHALLENGE_TEXT)
class _VisibleTextParser(HTMLParser):
 def __init__(self) -> None:super().__init__();self.parts: list[str]=[];self.skip: int=0
 @override
 def handle_starttag(self,tag: str,attrs: list[tuple[str,str|None]]) -> None:
  if tag in ("style","script"):self.skip+=1
 @override
 def handle_endtag(self,tag: str) -> None:
  if tag in ("style","script") and self.skip:self.skip-=1
 @override
 def handle_data(self,data: str) -> None:
  if not self.skip and data and data.strip():self.parts.append(data.strip())
def _visible_html_text(value:str)->str:
 parser=_VisibleTextParser()
 try:parser.feed(value or "")
 except ValueError:return ""
 return clean(" ".join(parser.parts))
def _extract_pdf_text(path:Path)->str:
 try:
  with path.open("rb") as source:
   reader=PdfReader(source)
   return "\n".join(page.extract_text() or "" for page in reader.pages)
 except (OSError,ValueError,PyPdfError):return ""
def _html_brand_reasons(html_text:str)->list[str]:
 low=(html_text or "").lower();visible=_visible_html_text(html_text).lower();reasons:list[str]=[]
 required=[("pdf_brand_robinswood_missing","robinswood"),("pdf_brand_blue_missing","#08033a"),("pdf_brand_coral_missing","#e0796b"),("pdf_brand_font_dm_sans_missing","dm sans"),("pdf_brand_font_cormorant_missing","cormorant garamond")]
 for reason,needle in required:
  if needle not in low and needle not in visible:reasons.append(reason)
 if "#f7f4ef" not in low and "background" not in low:reasons.append("pdf_brand_warm_background_or_card_missing")
 return reasons
def pdf_attachment_quality(pdf_path:object,html_path:object=None,min_bytes:int=PDF_MIN_BRANDED_BYTES,max_bytes:int=PDF_MAX_BRANDED_BYTES)->PDFQuality:
 p=Path(str(pdf_path or ""));h=Path(str(html_path or "")) if html_path else None;reasons:list[str]=[];size=None;text=""
 if not str(pdf_path or "").strip():reasons.append("pdf_attachment_path_missing")
 elif not p.exists() or not p.is_file():reasons.append("pdf_attachment_file_missing")
 else:
  size=p.stat().st_size
  if p.suffix.lower()!=".pdf":reasons.append("pdf_attachment_suffix_not_pdf")
  try:
   if not p.read_bytes()[:5].startswith(b"%PDF-"):reasons.append("pdf_attachment_magic_header_invalid")
  except OSError:reasons.append("pdf_attachment_unreadable")
  if size<min_bytes:reasons.append(f"pdf_attachment_too_small_for_robinswood_brand:{size}<{min_bytes}")
  if size>max_bytes:reasons.append(f"pdf_attachment_too_large:{size}>{max_bytes}")
  text=_extract_pdf_text(p)
  if not text.strip():reasons.append("pdf_attachment_text_unreadable")
  elif "robinswood" not in text.lower():reasons.append("pdf_attachment_text_missing_robinswood")
 if h:
  if not h.exists() or not h.is_file():reasons.append("pdf_source_html_missing")
  else:reasons+=_html_brand_reasons(h.read_text(encoding="utf-8",errors="ignore"))
 return {"ok":not reasons,"contractVersion":PDF_BRAND_CONTRACT_VERSION,"pdfPath":str(p) if str(pdf_path or "").strip() else None,"htmlPath":str(h) if h else None,"bytes":size,"minBytes":min_bytes,"maxBytes":max_bytes,"textChars":len(text.strip()),"reasons":sorted(set(reasons))}
def pdf_attachment_quality_reasons(pdf_path:object,html_path:object=None)->list[str]:return pdf_attachment_quality(pdf_path,html_path).get("reasons") or []
def outbound_content_reasons(body:object,expected_attachment_count:int,contact:Contact|None=None)->list[str]:
 reasons=attachment_semantic_reasons(body,expected_attachment_count)
 if contact is not None:reasons+=salutation_reasons(body,contact)
 return sorted(set(reasons))
def selftest()->dict[str,object]:
 matrix=[("Je joins un pré-audit.",1,True),("Je joins un pré-audit.",0,False),("Voici mes hypothèses.",0,True),("Voici mes hypothèses.",1,False)];aok=all((not attachment_semantic_reasons(b,n)) is ok for b,n,ok in matrix);neutral=safe_salutation({"first_name":"Véronique","last_name":"Exemple"});explicit=safe_salutation({"first_name":"Véronique","last_name":"Exemple","civility":"Madame","civility_source":"official_source"});challenge=is_delivery_challenge("artus@invitations.mailinblack.com","Un clic pour délivrer votre email !","Protect de Mailinblack");missing=pdf_attachment_quality("/definitely/missing/robinswood.pdf");html_reasons=_html_brand_reasons("<style>body{color:#08033A;background:#F7F4EF;font-family:'DM Sans'}h1{font-family:'Cormorant Garamond';color:#E0796B}</style><body>Robinswood</body>");pdf_gate_ok=missing.get("ok") is False and "pdf_attachment_file_missing" in (missing.get("reasons") or []) and html_reasons==[];ok=aok and neutral["salutation"]=="Bonjour," and explicit["salutation"]=="Bonjour Madame Exemple," and challenge and pdf_gate_ok;return {"ok":bool(ok),"contractVersion":CONTRACT_VERSION,"attachmentMatrix":aok,"neutralSalutation":neutral,"explicitSalutation":explicit,"deliveryChallenge":challenge,"pdfBrandGate":pdf_gate_ok}
if __name__=="__main__":print(json.dumps(selftest(),ensure_ascii=False))
