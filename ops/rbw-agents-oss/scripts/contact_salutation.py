from __future__ import annotations

import json
import re
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path
from typing import TypedDict

from outbound_content_guard import Contact, Salutation
from pydantic import JsonValue, TypeAdapter

type JsonObject = dict[str, JsonValue]
VALUE_ADAPTER: TypeAdapter[JsonValue] = TypeAdapter(JsonValue)

class Inference(TypedDict):
 used: bool
 method: str

class FormalSalutation(Salutation):
 formatted_last_name: str
 salutationMode: str
 inference: Inference
 canUseNamedSalutation: bool
 isGenericMailbox: bool
 email: str

from outbound_content_guard import (
 CONTRACT_VERSION,
 apply_safe_salutation,
 safe_salutation,
 verified_civility,
)

ROOT=Path("/home/craft/.craft-agent/workspaces/my-workspace-2")
OPS=ROOT/"campaigns/ops"; ENR=ROOT/"campaigns/enrichment"
REPORT=OPS/"contact-salutation-last.json"
SOURCES=(ENR/"robinswood-flow-contacts.json",ENR/"robinswood-flow-pilot-accounts-v2.json",OPS/"robinswood-pme-hdf-campaign.json")
def now()->str:return datetime.now(UTC).isoformat()
def load(p:Path,default: JsonValue) -> JsonValue:
 try:return VALUE_ADAPTER.validate_json(p.read_bytes())
 except (OSError,ValueError):return default
def save(p:Path,data: object) -> None:p.parent.mkdir(parents=True,exist_ok=True);_=p.write_text(json.dumps(data,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
def normalize_explicit_civility(value:object)->str|None:
 c,_=verified_civility({"civility":value,"civility_source":"explicit"});return c
def split_first_name(value:object)->str:
 return re.split(r"[\s-]+",str(value or "").strip(),maxsplit=1)[0] if str(value or "").strip() else ""
def infer_civility(first_name:object,role:object="",email:object="")->tuple[str,str]:
 _=first_name,role,email
 return "unknown","neutral-no-inference"
def resolve_contact_civility(contact:Contact)->tuple[str,str]:
 civ,source=verified_civility(contact)
 return ("woman" if civ=="Madame" else "man",f"verified-{source}") if civ else ("unknown","neutral-no-inference")
GENERIC_MAILBOX_LOCALPARTS={"info","contact","hello","bonjour","team","events","event","conference","program","programming","registration","press","presse","media","newsroom","editorial","editor","sales","partnerships","alliances","support","admin","office","commercial","communication","communications","marketing"}
def contact_email(contact:Contact)->str:
 return str(contact.get("email") or contact.get("recipient") or contact.get("to") or "").strip().lower()
def is_generic_mailbox_contact(contact:Contact)->bool:
 email=contact_email(contact)
 if "@" not in email:return False
 local=email.split("@",1)[0]
 return local in GENERIC_MAILBOX_LOCALPARTS or any(local.startswith(prefix+sep) for prefix in GENERIC_MAILBOX_LOCALPARTS for sep in (".","-","_"))
def resolve_formal_salutation(contact:Contact)->FormalSalutation:
 """Backward-compatible resolver backed only by the no-inference content guard."""
 resolved=safe_salutation(contact);last=str(resolved.get("last_name") or "");generic=is_generic_mailbox_contact(contact)
 return {**resolved,"formatted_last_name":last,"salutationMode":resolved["mode"],"inference":{"used":False,"method":"explicit-verified-civility-or-neutral-name"},"canUseNamedSalutation":bool(last and resolved.get("civility")),"isGenericMailbox":generic,"email":contact_email(contact)}
def apply_formal_salutation(contact:JsonObject)->FormalSalutation:
 resolved=resolve_formal_salutation(contact)
 if resolved.get("first_name") and not contact.get("first_name"):contact["first_name"]=resolved["first_name"]
 if resolved.get("last_name") and not contact.get("last_name"):contact["last_name"]=resolved["last_name"]
 if resolved.get("civility"):contact["civility"]=resolved["civility"]
 if resolved.get("civilitySource"):contact["civility_source"]=resolved["civilitySource"]
 contact["salutation"]=resolved["salutation"];contact["salutation_mode"]=resolved["salutationMode"];contact["civility_inference"]={"used":resolved["inference"]["used"],"method":resolved["inference"]["method"]}
 return resolved
def format_salutation(contact:Contact)->str:return safe_salutation(contact)["salutation"]
def apply_salutation_to_body(body:object,contact:Contact)->str:return apply_safe_salutation(body,contact)[0]
def iter_contacts(obj:JsonValue,path:str="root") -> Iterator[tuple[str,JsonObject]]:
 if isinstance(obj,list):
  for i,item in enumerate(obj):yield from iter_contacts(item,f"{path}[{i}]")
 elif isinstance(obj,dict):
  keys=set(obj)
  identity=bool(keys & {"first_name","last_name","recipientName","decisionMakerName","contact_name","fullName"})
  if identity:yield path,obj
  for key,value in obj.items():
   if isinstance(value,(dict,list)):yield from iter_contacts(value,f"{path}.{key}")
def selftest()->dict[str,object]:
 cases=[
  ({"first_name":"Véronique","last_name":"Exemple"},"Bonjour,","neutral-generic"),
  ({"first_name":"Odile","last_name":"Démonstration"},"Bonjour,","neutral-generic"),
  ({"first_name":"Alex","last_name":"Martin","role":"Directrice"},"Bonjour,","neutral-generic"),
  ({"first_name":"Véronique","last_name":"Exemple","civility":"Madame","civility_source":"official_source"},"Bonjour Madame Exemple,","verified-civility-last-name"),
  ({"first_name":"Pierre","last_name":"Durand","civility":"Monsieur"},"Bonjour Monsieur Durand,","verified-civility-last-name"),
 ]
 results:list[dict[str,object]]=[]
 for contact,expected,mode in cases:
  got=safe_salutation(contact);results.append({"contact":contact,"expected":expected,"actual":got["salutation"],"mode":got["mode"],"passed":got["salutation"]==expected and got["mode"]==mode and got["inferenceUsed"] is False})
 compatibility=[
  {"name":"named_neutral_refused","passed":resolve_formal_salutation({"first_name":"Alex","last_name":"Martin","role":"Directrice"})["canUseNamedSalutation"] is False and resolve_formal_salutation({"first_name":"Alex","last_name":"Martin","role":"Directrice"})["civility"] is None},
  {"name":"generic_mailbox_detected","passed":resolve_formal_salutation({"email":"conference@example.org"})["isGenericMailbox"] is True},
  {"name":"missing_last_name_fail_closed","passed":resolve_formal_salutation({"first_name":"Alex","email":"alex@example.org"})["canUseNamedSalutation"] is False},
  {"name":"explicit_verified_civility_only","passed":resolve_formal_salutation({"first_name":"Pierre","last_name":"Durand","civility":"Monsieur"})["civility"]=="Monsieur" and resolve_formal_salutation({"first_name":"Pierre","last_name":"Durand","civility":"Monsieur","civility_source":"official_source"})["civility"]=="Monsieur"},
 ]
 return {"ok":all(x["passed"] for x in results+compatibility),"cases":results,"compatibility":compatibility}
def main()->int:
 resolved: list[dict[str,object]]=[]
 for source in SOURCES:
  data=load(source,{})
  for path,contact in iter_contacts(data):
   sal=safe_salutation(contact);resolved.append({"source":str(source),"path":path,"email":contact.get("email"),"salutation":sal["salutation"],"mode":sal["mode"],"inferenceUsed":False,"verifiedCivilitySource":sal["civilitySource"]})
 test=selftest();report={"generatedAt":now(),"status":"ok" if test["ok"] else "blocked","contractVersion":CONTRACT_VERSION,"policy":"explicit verified civility only; otherwise neutral named greeting","contactsScanned":len(resolved),"resolved":resolved,"selftest":test};save(REPORT,report);print(json.dumps(report,ensure_ascii=False));return 0 if test["ok"] else 2
if __name__=="__main__":raise SystemExit(main())
