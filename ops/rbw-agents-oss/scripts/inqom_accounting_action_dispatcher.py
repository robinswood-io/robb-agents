#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from action_queue_contract import normalize_action_list, validate_action_item

OPS = Path('/home/craft/.craft-agent/workspaces/my-workspace-2/campaigns/ops')
WORKDIR = OPS / 'inqom-accounting-action-workpapers'
OUT_JSON = OPS / 'inqom-accounting-action-dispatcher.json'
OUT_MD = OPS / 'inqom-accounting-action-dispatcher.md'
LEDGER = OPS / 'inqom-accounting-action-dispatcher-ledger.jsonl'
FOLLOWUP_QUEUE = OPS / 'inqom-accounting-action-dispatcher-followup-queue.json'
ORIGIN = 'inqom-accounting-action-dispatcher'
MUTATING = {'inqom_mutation','native_reconciliation','native_lettering','entry_creation','entry_update','entry_delete','external_delivery','sellsy_mutation'}
QUEUE_FILES = [
    OPS / 'inqom-operator-guidance-action-queue.json',
    OPS / 'inqom-source-quality-logical-review-queue.json',
    OPS / 'inqom-manual-reconciliation-action-queue.json',
    OPS / 'inqom-group-accounting-order-action-queue.json',
    OPS / 'inqom-quality-autonomy-action-queue.json',
    OPS / 'inqom-intercompany-reconciliation-action-queue.json',
    OPS / 'inqom-bank-reconciliation-action-queue.json',
    OPS / 'finance-inqom-vat-cash-basis-monthly-period-lettering-action-queue.json',
]

def now_iso() -> str: return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
def read_json(path: Path, default: Any) -> Any:
    try: return json.loads(path.read_text(encoding='utf-8'))
    except Exception: return default
def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
def sha(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, default=str).encode('utf-8')).hexdigest()[:16]
def read_ledger() -> set[str]:
    done: set[str] = set()
    if not LEDGER.exists(): return done
    for line in LEDGER.read_text(encoding='utf-8').splitlines():
        try:
            row = json.loads(line)
            # Do not treat previous blocked attempts as done; a guard-enrichment patch may unblock them.
            if row.get('status') in {'executed_prepare_only','escalated_human_gate'}:
                done.add(str(row.get('dispatchKey')))
        except Exception: pass
    return done
def append_ledger(row: dict[str, Any]) -> None:
    LEDGER.parent.mkdir(parents=True, exist_ok=True)
    with LEDGER.open('a', encoding='utf-8') as fh:
        fh.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + '\n')
def load_actions() -> list[dict[str, Any]]:
    actions=[]
    for path in QUEUE_FILES:
        data=read_json(path, [])
        if isinstance(data, dict) and isinstance(data.get('actions'), list): data=data['actions']
        if not isinstance(data, list): continue
        for item in data:
            if isinstance(item, dict):
                row=dict(item); row['_sourceQueue']=str(path); actions.append(row)
    seen=set(); out=[]
    for a in actions:
        key=a.get('dedupeKey') or a.get('id') or sha(a)
        if key in seen: continue
        seen.add(key); out.append(a)
    return out
def normalize_guards(action: dict[str, Any]) -> tuple[set[str], set[str], list[str]]:
    data=action.setdefault('data', {})
    allowed=set(data.get('allowedEffects') or [])
    blocked=set(data.get('blockedEffects') or [])
    notes=[]
    missing=sorted(MUTATING - blocked)
    if missing:
        blocked |= MUTATING
        data['blockedEffects']=sorted(blocked)
        notes.append(f'auto_enriched_missing_blocked_effects:{len(missing)}')
    return allowed, blocked, notes
def classify_action(action: dict[str, Any]) -> tuple[str, str, list[str]]:
    allowed, blocked, notes = normalize_guards(action)
    owner=str(action.get('owner') or '').lower()
    action_type=str(action.get('actionType') or '').lower()
    if allowed & MUTATING:
        return 'blocked_mutation_guard', 'allowed_effects_contains_mutating_effect', notes
    if owner in {'agent', 'automation'} or action_type.startswith(('prepare_', 'autonomize_', 'separate_', 'maintain_')):
        return 'execute_prepare_only', 'agent_prepare_only_action', notes
    return 'escalate_human_gate', f'owner_{owner or "unknown"}_requires_review', notes
def workpaper_for(action: dict[str, Any], status: str, reason: str, guard_notes: list[str], generated_at: str) -> dict[str, Any]:
    dispatch_key=action.get('dedupeKey') or action.get('id') or sha(action)
    slug=f"{status}-{sha(dispatch_key)}"
    payload={'generatedAt':generated_at,'contractVersion':'standard-v3-accounting-action-workpaper-period-vat-lettering','capabilityId':ORIGIN,'dispatchKey':dispatch_key,'status':status,'reason':reason,'guardNotes':guard_notes,'sourceQueue':action.get('_sourceQueue'),'action':action,'executionMode':'prepare_only_no_mutation','performedSteps':[],'mutationAttempted':False,'blockedEffects':sorted(MUTATING),'humanGate':'Toute mutation Inqom, rapprochement natif, lettrage natif, écriture ou livraison externe reste hors périmètre de ce dispatcher.'}
    if status=='executed_prepare_only': payload['performedSteps']=['validated_action_contract','auto_enriched_missing_mutation_guards_when_needed','materialized_evidence_pointer_or_pack_reference','created_prepare_only_workpaper','left_native_accounting_state_unchanged']
    elif status=='escalated_human_gate':
        payload['performedSteps']=['validated_action_contract','auto_enriched_missing_mutation_guards_when_needed','created_human_review_question_pack','left_native_accounting_state_unchanged']
        payload['questions']=[f"Valider/compléter l’action: {action.get('title')}",f"Critère de fin: {action.get('doneCondition')}",'Confirmer la nature comptable/preuve avant toute mutation éventuelle.']
    else: payload['performedSteps']=['detected_explicit_mutating_allowed_effect','blocked_execution','left_native_accounting_state_unchanged']
    path=WORKDIR / f'{slug}.json'; write_json(path, payload)
    return {'dispatchKey':dispatch_key,'status':status,'reason':reason,'guardNotes':guard_notes,'workpaperJson':str(path),'target':action.get('target'),'title':action.get('title'),'owner':action.get('owner'),'priority':action.get('priority')}

def pending_review_results(actions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    active={str(a.get('dedupeKey') or a.get('id') or sha(a)) for a in actions if a.get('actionableNow') is True}
    latest={}
    if LEDGER.exists():
        for line in LEDGER.read_text(encoding='utf-8').splitlines():
            try:
                row=json.loads(line);key=str(row.get('dispatchKey'))
                if key in active: latest[key]=row
            except (ValueError,TypeError): pass
    return [row for row in latest.values() if row.get('status') in {'escalated_human_gate','blocked_mutation_guard'}]

def build_followup_queue(results: list[dict[str, Any]]) -> list[dict[str, Any]]:
    actions=[]
    for r in results:
        if r['status']=='escalated_human_gate':
            actions.append({'owner':'finance-ops','actionType':'review_accounting_action_workpaper','priority':r.get('priority') or 'high','actionableNow':True,'target':f"accounting-action-workpaper:{r['dispatchKey']}",'blockingReason':r['reason'],'doneCondition':'Le workpaper est validé, annoté ou transformé en règle/policy; aucune mutation native n’est effectuée ici.','title':f"Revue workpaper — {r.get('title')}",'summary':f"Revoir le workpaper {r['workpaperJson']}",'data':{'workpaper':r,'allowedEffects':['writes_reports','writes_action_queue','policy_update_proposal'],'blockedEffects':sorted(MUTATING)},'dedupeKey':f"{ORIGIN}:followup:{r['dispatchKey']}"})
        elif r['status']=='blocked_mutation_guard':
            actions.append({'owner':'operator','actionType':'fix_accounting_action_guard','priority':'critical','actionableNow':True,'target':f"accounting-action-guard:{r['dispatchKey']}",'blockingReason':r['reason'],'doneCondition':'La queue source ne doit autoriser aucun effet mutant.','title':f"Corriger garde-fou action — {r.get('title')}",'summary':f"Action bloquée: {r['reason']}",'data':{'workpaper':r,'allowedEffects':['writes_reports','writes_action_queue'],'blockedEffects':sorted(MUTATING)},'dedupeKey':f"{ORIGIN}:guard:{r['dispatchKey']}"})
    return normalize_action_list(actions, origin_automation=ORIGIN)
def write_markdown(payload: dict[str, Any]) -> None:
    lines=[f"# Inqom accounting action dispatcher — {payload['generatedAt']}",'',f"- Summary: {payload['summary']}",f"- Mutation attempted: **{payload['mutationAttempted']}**",'', '## Results']
    for r in payload.get('results') or []: lines.append(f"- **{r['status']}** — {r.get('title')} — {r.get('workpaperJson')}")
    OUT_MD.write_text('\n'.join(lines)+'\n',encoding='utf-8')
def main() -> None:
    generated_at=now_iso(); WORKDIR.mkdir(parents=True, exist_ok=True)
    actions=load_actions(); done=read_ledger(); results=[]; skipped=[]; validation_issues=[]
    for action in actions:
        if action.get('actionableNow') is False:
            skipped.append({'dispatchKey': action.get('dedupeKey') or action.get('id'), 'reason': 'documented_wait_not_actionable', 'title': action.get('title')}); continue
        issues=validate_action_item(action)
        if issues: validation_issues.append({'id':action.get('id'),'issues':issues,'sourceQueue':action.get('_sourceQueue')})
        dispatch_key=str(action.get('dedupeKey') or action.get('id') or sha(action))
        if dispatch_key in done:
            skipped.append({'dispatchKey':dispatch_key,'reason':'already_in_ledger','title':action.get('title')}); continue
        decision, reason, guard_notes=classify_action(action)
        status={'execute_prepare_only':'executed_prepare_only','escalate_human_gate':'escalated_human_gate','blocked_mutation_guard':'blocked_mutation_guard'}[decision]
        row=workpaper_for(action,status,reason,guard_notes,generated_at); results.append(row); append_ledger({'generatedAt':generated_at,**row,'mutationAttempted':False})
    followup=build_followup_queue(pending_review_results(actions)); write_json(FOLLOWUP_QUEUE, followup)
    counts={'sourceActions':len(actions),'executedPrepareOnly':len([r for r in results if r['status']=='executed_prepare_only']),'escalatedHumanGate':len([r for r in results if r['status']=='escalated_human_gate']),'blockedMutationGuard':len([r for r in results if r['status']=='blocked_mutation_guard']),'skippedAlreadyDone':len(skipped),'followupQueue':len(followup),'validationIssues':len(validation_issues),'guardAutoEnriched':sum(1 for r in results if r.get('guardNotes'))}
    blocking=[]
    if counts['blockedMutationGuard']: blocking.append('mutation_guard_blocked_actions')
    if validation_issues: blocking.append('action_contract_validation_issues')
    payload={'generatedAt':generated_at,'contractVersion':'standard-v3-accounting-action-dispatcher-period-vat-lettering-queue','capabilityId':ORIGIN,'ok':not blocking,'status':'processed' if not blocking else 'partial','summary':f"inqom_accounting_action_dispatcher: source_actions={counts['sourceActions']} executed={counts['executedPrepareOnly']} escalated={counts['escalatedHumanGate']} blocked={counts['blockedMutationGuard']} skipped={counts['skippedAlreadyDone']} followup={counts['followupQueue']} guard_auto_enriched={counts['guardAutoEnriched']}",'counts':counts,'blockingReasons':blocking,'mutationAttempted':False,'results':results,'skipped':skipped,'followupQueue':followup,'validationIssues':validation_issues,'sourceQueues':[str(p) for p in QUEUE_FILES],'artifacts':{'reportJson':str(OUT_JSON),'reportMd':str(OUT_MD),'ledgerJsonl':str(LEDGER),'workpaperDir':str(WORKDIR),'followupQueueJson':str(FOLLOWUP_QUEUE)},'updatedBy':ORIGIN}
    write_json(OUT_JSON,payload); write_markdown(payload)
    print(json.dumps({'generatedAt':generated_at,'summary':payload['summary'],'blockingReasons':blocking},ensure_ascii=False))
    if blocking: raise SystemExit(1)
if __name__=='__main__': main()
