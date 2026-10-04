#!/usr/bin/env python3
"""Consume approved operator facts, read complete native ledgers, route open cases.
This preparer never grants or performs a native mutation or an external send.
"""
from __future__ import annotations
import calendar
import hashlib
import json
import os
import re
import tempfile
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
import oss_process
from action_queue_contract import normalize_action_list, validate_action_item

WS = Path(os.environ.get('RBW_OSS_WORKSPACE', '/home/craft/.craft-agent/workspaces/my-workspace-2'))
OPS = WS / 'campaigns' / 'ops'
SOURCE = WS / 'sources' / 'inqom'
GUIDANCE = OPS / 'inqom-operator-guidance-20261004.json'
REPORT = OPS / 'inqom-operator-guidance-materializer.json'
SNAPSHOT = OPS / 'inqom-operator-guidance-native-snapshot.json'
QUEUE = OPS / 'inqom-operator-guidance-action-queue.json'
ORIGIN = 'inqom-operator-guidance-materializer'
FOLDERS = (18627, 124920, 124921)
BLOCKED = ['inqom_mutation','native_reconciliation','native_lettering','entry_creation','entry_update','entry_delete','external_delivery','sellsy_mutation']

def now_iso():
    return datetime.now(timezone.utc).isoformat().replace('+00:00','Z')

def read_json(path, default=None):
    try: return json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError): return default

def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile('w', encoding='utf-8', dir=path.parent, delete=False) as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2); fh.write('\n'); temporary=fh.name
    os.replace(temporary, path)

def account(line):
    return str((line.get('BookAccountDto') or {}).get('AccountName') or line.get('AccountName') or '')

def is_open(line):
    return not (line.get('MatchedId') or line.get('MatchedLetter'))

def compact_line(line, folder):
    return {'folderId':folder,'entryId':line.get('EntryId'),'lineId':line.get('Id'),
            'account':account(line),'accountId':line.get('AccountId'),'subAccountId':line.get('SubAccountId'),
            'amount':line.get('Amount'),'date':str(line.get('Date') or '')[:10],
            'docRef':line.get('DocRef'),'label':line.get('Label'),'entryLabel':line.get('EntryLabel'),
            'source':line.get('Source'),'sourceType':line.get('SourceType'),
            'matchedId':line.get('MatchedId'),'matchedLetter':line.get('MatchedLetter')}

def open_compact(line):
    return not (line.get('matchedId') or line.get('matchedLetter'))

def reference(line):
    text=f"{line.get('docRef') or ''} {line.get('label') or ''}".upper()
    # Generic bank export labels are not invoice evidence.
    text=text.replace('FACT-20190612-00001','')
    m=re.search(r'\b(?:FC|FA|F|AV)[- ]?\d{4,}\b',text)
    return re.sub(r'[- ]','',m.group()) if m else ''

def guidance_issues(g):
    if not isinstance(g,dict): return ['guidance_missing']
    errors=[]
    if g.get('schemaVersion') != 'inqom-operator-guidance-v1': errors.append('guidance_schema')
    if sorted((g.get('scope') or {}).get('folderIds') or []) != sorted(FOLDERS): errors.append('guidance_scope')
    required={'namourland_rent','namourland_wrong_salary_transfer','ursaff_settlement_difference_030',
              'invoice_collection','pns_credit_note','jlm_credit_note_and_chargeback','jlm_5000_balance'}
    ids=[r.get('id') for r in g.get('rules') or [] if isinstance(r,dict)]
    if set(ids)!=required or len(ids)!=len(set(ids)): errors.append('guidance_rules')
    if len((g.get('process') or {}).get('steps') or [])<12: errors.append('guidance_process')
    if (g.get('source') or {}).get('type')!='direct_user_answers': errors.append('guidance_authority')
    return errors

def validate_period(result):
    """Do not turn an API page cap or missing identifiers into full coverage."""
    issues=[]
    lines=result.get('lines') or []; pages=result.get('pages') or []
    if not pages: return ['pages_missing']
    if pages[-1].get('rawItemCount',9999)>=9999: issues.append('page_cap_reached')
    if result.get('lineCount')!=len(lines) or sum(p.get('lineCount',-1) for p in pages)!=len(lines):
        issues.append('line_count_mismatch')
    ids=[l.get('Id') for l in lines]
    if any(not l.get('Id') or not l.get('EntryId') or l.get('Amount') is None or not account(l) for l in lines):
        issues.append('native_identifiers_missing')
    if len(ids)!=len(set(ids)): issues.append('duplicate_native_lines')
    first=pages[0].get('metadata') or {}
    if first.get('LinesCount') is not None and first['LinesCount']!=len(lines): issues.append('metadata_lines_mismatch')
    if first.get('ItemCount') is not None and first['ItemCount']!=sum(p.get('rawItemCount',0) for p in pages):
        issues.append('metadata_entries_mismatch')
    return issues

def periods(year, end):
    for month in range(1,end.month+1):
        last=min(end.day,calendar.monthrange(year,month)[1]) if month==end.month else calendar.monthrange(year,month)[1]
        yield f'{year}-{month:02d}-01', f'{year}-{month:02d}-{last:02d}'

def fetch_native(g):
    year=int(g['scope']['period'])
    end=datetime.now(timezone.utc).date()
    if end.year!=year: raise ValueError('guidance_period_requires_renewal')
    requests=[{'folderId':folder,'startDate':start,'endDate':stop,'pageSize':9999,'maxPages':100}
              for folder in FOLDERS for start,stop in periods(year,end)]
    sdk=SOURCE/'node_modules/@modelcontextprotocol/sdk/dist/esm/client'
    code=r"""
import fs from 'node:fs';
import {Client} from '__CLIENT__';
import {StdioClientTransport} from '__STDIO__';
const input=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const client=new Client({name:'inqom-operator-guidance-native-audit',version:'1.0.0'});
const transport=new StdioClientTransport({command:'node',args:['server-lite.js'],stderr:'pipe'});
const out=[];
try{
 await client.connect(transport);
 for(const args of input.requests){
  let value;
  for(let attempt=0;attempt<3;attempt++){
   await new Promise(r=>setTimeout(r,800+attempt*1500));
   const raw=await client.callTool({name:'inqom_search_accounting_entries_paged',arguments:args});
   if(raw.isError){
    const error=(raw.content||[]).filter(x=>x.type==='text').map(x=>x.text).join(' ');
    if(error.includes('429') && attempt<2)continue;
    throw Error('native_read_failed:'+args.folderId+':'+args.startDate);
   }
   value=JSON.parse((raw.content||[]).filter(x=>x.type==='text').map(x=>x.text).join('\n'));break;
  }
  out.push({...value,request:args});
 }
 fs.writeFileSync(input.output,JSON.stringify(out));
 console.log(JSON.stringify({ok:true,periods:out.length}));
} catch(e){ console.log(JSON.stringify({ok:false,error:String(e.message)}));process.exitCode=1; }
finally{await client.close().catch(()=>{});}
""".replace('__CLIENT__',str(sdk/'index.js')).replace('__STDIO__',str(sdk/'stdio.js'))
    with tempfile.TemporaryDirectory(prefix='inqom-guidance-') as temporary:
        base=Path(temporary); script=base/'audit.mjs'; args=base/'args.json'; output=base/'native.json'
        script.write_text(code,encoding='utf-8')
        args.write_text(json.dumps({'requests':requests,'output':str(output)}),encoding='utf-8')
        env=os.environ.copy()
        env['INQOM_ENABLE_MUTATIONS']='false';env['INQOM_ENABLE_NATIVE_LETTERING']='false'
        env.pop('INQOM_MUTATION_APPROVAL_FILE',None)
        proc=oss_process.run(['node',str(script),str(args)],cwd=str(SOURCE),env=env,capture_output=True,text=True,timeout=540)
        if proc.returncode!=0 or not output.exists():
            raise RuntimeError('complete_native_audit_failed:'+proc.stdout[-500:])
        return json.loads(output.read_text(encoding='utf-8'))

def classify(line):
    text=f"{line.get('account')} {line.get('label')} {line.get('entryLabel')} {line.get('docRef')}".upper()
    folder=line['folderId']; amount=round(float(line['amount']),2); ref=reference(line)
    if amount==0: return 'zero_movement_review',False
    if line['lineId']==2593322531: return 'pns_credit_note',False
    if ref=='FC02147' and folder==18627: return 'jlm_5000_balance',False
    if 'EDF' in text: return 'edf_annual_upload',False
    if 'ANTONINI' in text or 'ANTONONI' in text: return 'antonini_final_invoice',False
    if folder==124920 and line['account'].startswith('431') and abs(amount) in (606,606.30):
        return 'ursaff_settlement_difference_030',True
    if re.search(r'\bAV[- ]?\d{4,}',text): return 'credit_note_native_invoice_and_prior_cancellation',True
    if 'CHARGEBACK' in text or 'GOCARDLESS' in text or re.search(r'\b(?:PAY-|PM01|CB-PM)',text):
        return 'gocardless_current_status_and_chargeback',True
    if ((folder==124921 and 'YOUCO' in text) or (folder==18627 and 'NAMOU' in text)):
        if 'LOYER' in text: return 'namourland_rent',True
        return 'namourland_distinguish_rent_deposit_return',True
    return 'native_reference_and_document_research',True

def treatment(rule):
    return {
      'pns_credit_note':"Attendre l'arbitrage Laure sur l'annulation manuelle 2025 et AV-00130 ; ne pas relettrer FC-02120 déjà fermé.",
      'jlm_5000_balance':"Attendre paid_out et la contrepartie bancaire de PM01XVZ3DZ248PH9GQMV16YXK8RX ; aucune relance ni nouveau prélèvement.",
      'edf_annual_upload':"Collecte/upload annuel EDF ; aucune relance mensuelle.",
      'antonini_final_invoice':"Attendre la facture de solde complète Antonini ; conserver les acomptes documentés.",
      'ursaff_settlement_difference_030':"Confirmer une paire unique déclaration 606.30/prélèvement 606.00 de la même échéance. Vérifier 758 actif et le précédent expert, préparer OD 431 -0.30 / 758 +0.30 puis lettrage à trois lignes. Exclure 610 et les autres montants.",
      'credit_note_native_invoice_and_prior_cancellation':"Lire le lien facture natif Sellsy et les mentions de l'avoir. Contrôler annulations, AN et extournes antérieures ; arbitrage expert en cas de conflit d'exercice.",
      'gocardless_current_status_and_chargeback':"Identifier le paymentId et la facture, lire le statut courant et les événements. Rechercher un rejet existant avant de préparer la restauration de créance puis lettrer l'avoir exact.",
      'namourland_rent':"Classer les flux locatifs concernés en loyers, aucun apport en compte courant. Vérifier période et date d'effet de la réévaluation et électricité voiture auprès de Laure.",
      'namourland_distinguish_rent_deposit_return':"Distinguer loyer, dépôt de garantie et retour d'erreur par pièces et deux mouvements bancaires. Pour un retour prouvé, OD entre contreparties et lettrage séparé par compte, aucune écriture bancaire artificielle.",
      'zero_movement_review':"Ligne sans mouvement financier ; documenter le statut, ne pas créer d'écart ou de règlement.",
    }.get(rule,"Rechercher facture et règlement par dossier, tiers, référence et période. Rechercher Gmail/notifications/portail puis demander au fournisseur l'envoi à l'adresse Inqom vérifiée du dossier. Aucun rapprochement sur montant seul.")

def materialize(g, native):
    errors=[]; lines=[]; coverage=[]
    end=datetime.now(timezone.utc).date(); year=int(g['scope']['period'])
    expected={(f,a,b) for f in FOLDERS for a,b in periods(year,end)}
    actual=[((r.get('request') or {}).get('folderId'),(r.get('request') or {}).get('startDate'),(r.get('request') or {}).get('endDate')) for r in native]
    if len(actual)!=len(set(actual)) or set(actual)!=expected: errors.append('incomplete_period_coverage')
    for result in native:
        problems=validate_period(result)
        req=result.get('request') or {}; folder=result.get('folderId')
        if folder not in FOLDERS or req.get('folderId')!=folder: problems.append('folder_scope_mismatch')
        errors.extend(f"{folder}:{req.get('startDate')}:{p}" for p in problems)
        coverage.append({'folderId':folder,'period':result.get('period'),'pages':len(result.get('pages') or []),
                         'entries':sum(p.get('rawItemCount',0) for p in result.get('pages') or []),
                         'lines':len(result.get('lines') or []),'complete':not problems})
        lines.extend(compact_line(l,folder) for l in result.get('lines') or [])
    keys=[(l['folderId'],l['lineId']) for l in lines]
    if len(keys)!=len(set(keys)): errors.append('duplicate_line_across_periods')
    if set(l['folderId'] for l in lines)!=set(FOLDERS): errors.append('missing_folder_coverage')
    groups=defaultdict(list)
    for line in lines:
        if not open_compact(line) or not line['account'].startswith(('401','411','421','431','437','438','47')): continue
        rule,actionable=classify(line)
        key=(line['folderId'],rule,line['account'],line['subAccountId'],reference(line),actionable)
        groups[key].append(line)
    actions=[]
    rules={r['id']:r for r in g['rules']}
    for (folder,rule,acc,sub,ref,actionable),rows in sorted(groups.items(),key=lambda x:str(x[0])):
        identity=hashlib.sha256(json.dumps([folder,rule,sorted(r['lineId'] for r in rows)]).encode()).hexdigest()[:20]
        actions.append({'owner':'agent' if actionable else 'expert_accountant' if rule=='pns_credit_note' else 'finance-ops',
          'actionType':'prepare_operator_guided_accounting_case' if actionable else 'wait_documented_accounting_evidence',
          'priority':'high' if rule in ('pns_credit_note','ursaff_settlement_difference_030') else 'medium',
          'actionableNow':actionable,'target':f'inqom:{folder}:{rule}:{identity}',
          'blockingReason':'native_evidence_preflight_required' if actionable else 'documented_evidence_or_expert_wait',
          'doneCondition':'État natif relu, traitement approuvé et exécuté avec preuve de lettrage ou attente documentée réévaluée.',
          'title':f'{folder} — {rule} — {acc} {ref}',
          'summary':treatment(rule),'dedupeKey':f'{ORIGIN}:{identity}',
          'data':{'folderId':folder,'ruleId':rule,'account':acc,'subAccountId':sub,'reference':ref,
                  'canonicalLines':rows,'operatorRule':rules.get(rule) or rules['invoice_collection'],
                  'process':g['process']['steps'],'allowedEffects':['writes_reports','writes_action_queue','prepare_expert_pack'],
                  'blockedEffects':BLOCKED,'mutationAllowed':False,'externalSendAllowed':False,
                  'retryPolicy':'After any mutation error read the native reference and matched IDs before any retry; never replay an unknown result.'}})
    actions=normalize_action_list(actions,origin_automation=ORIGIN)
    for a in actions: errors.extend(validate_action_item(a))
    stats=[{'folderId':f,'lines':sum(l['folderId']==f for l in lines),
            'openThirdParty':sum(l['folderId']==f and open_compact(l) and l['account'].startswith(('401','411')) for l in lines),
            'openSelectedSocial':sum(l['folderId']==f and open_compact(l) and l['account'].startswith(('421','431','437','438')) for l in lines)} for f in FOLDERS]
    return {'lines':lines,'coverage':coverage,'stats':stats,'actions':actions,'issues':errors}

def fresh_snapshot(snapshot, max_age_seconds=3600):
    try:
        age=(datetime.now(timezone.utc)-datetime.fromisoformat(snapshot['generatedAt'].replace('Z','+00:00'))).total_seconds()
        return snapshot.get('ok') is True and 0<=age<=max_age_seconds
    except (KeyError,TypeError,ValueError): return False

def open_candidates(snapshot,folder):
    """Complete unique native reference pairs; never join on amount alone."""
    grouped=defaultdict(list)
    for line in snapshot.get('lines') or []:
        if line['folderId']!=folder or not open_compact(line) or not line['account'].startswith(('401','411')):continue
        ref=reference(line)
        if not ref or ref.startswith('AV'):continue
        grouped[(line['account'],line['subAccountId'],ref)].append(line)
    out={'client':[],'supplier':[]}
    for (acc,sub,ref),rows in grouped.items():
        pos=[r for r in rows if r['amount']>0];neg=[r for r in rows if r['amount']<0]
        if len(pos)!=1 or len(neg)!=1 or abs(pos[0]['amount']+neg[0]['amount'])>.005:continue
        out['client' if acc.startswith('411') else 'supplier'].append({
          'thirdPartyKey':acc,'positive':pos[0],'negative':neg[0],'sharedReferenceToken':ref,
          'source':'complete_native_open_ledger','folderId':folder,'type':'pair_exact_offset','residual':0.0})
    return out

def filter_candidates(candidates,snapshot,folder=18627):
    by_id={r['lineId']:r for r in snapshot.get('lines') or [] if r['folderId']==folder}
    accepted=[]; rejected=[]
    fresh=fresh_snapshot(snapshot)
    for c in candidates:
        source=[by_id.get((c.get(side) or {}).get('lineId')) for side in ('positive','negative')]
        reason=None
        if not fresh:reason='native_snapshot_missing_or_stale'
        elif not all(source):reason='native_line_missing'
        elif not all(open_compact(r) for r in source):reason='already_lettered_native'
        elif any(abs(float((c.get(side) or {}).get('amount') or 0)-float(source[i]['amount']))>.005 or (c.get(side) or {}).get('account')!=source[i]['account'] for i,side in enumerate(('positive','negative'))):
            reason='native_candidate_drift'
        elif source[0]['accountId']!=source[1]['accountId'] or source[0]['subAccountId']!=source[1]['subAccountId']:
            reason='native_account_or_subaccount_mismatch'
        elif any(classify(r)[0] != 'native_reference_and_document_research' for r in source):
            reason='operator_case_requires_specific_evidence'
        if reason:rejected.append({'lineIds':[(c.get(s) or {}).get('lineId') for s in ('positive','negative')],'reason':reason})
        else:accepted.append(c)
    return accepted,rejected

def main():
    gen=now_iso();g=read_json(GUIDANCE,{})
    errors=guidance_issues(g)
    try:
        if errors: raise ValueError(','.join(errors))
        data=materialize(g,fetch_native(g))
        errors.extend(data['issues'])
        snapshot={'generatedAt':now_iso(),'ok':not errors,'lines':data['lines'],'stats':data['stats'],'coverage':data['coverage']}
        write_json(SNAPSHOT,snapshot)
        # An incomplete read cannot refresh a downstream execution queue.
        write_json(QUEUE,data['actions'] if not errors else [])
        counts={'rulesConsumed':len(g['rules']),'processStepsConsumed':len(g['process']['steps']),
          'foldersCovered':len(data['stats']),'nativeLines':len(data['lines']),
          'openThirdParty':sum(s['openThirdParty'] for s in data['stats']),
          'actions':len(data['actions']),'pendingActions':len(data['actions']),
          'actionablePreparation':sum(a['actionableNow'] for a in data['actions']),
          'documentedWaits':sum(not a['actionableNow'] for a in data['actions'])}
        coverage=data['coverage'];stats=data['stats']
    except Exception as exc:
        errors.append(str(exc));counts={};coverage=[];stats=[]
        write_json(QUEUE,[])
        write_json(SNAPSHOT,{'generatedAt':now_iso(),'ok':False,'lines':[],'blockingReasons':errors})
    payload={'generatedAt':gen,'finishedAt':now_iso(),'capabilityId':ORIGIN,'ok':not errors,
      'status':'processed_prepare_only' if not errors else 'failed','guidanceSha256':hashlib.sha256(GUIDANCE.read_bytes()).hexdigest() if GUIDANCE.exists() else None,
      'summary':f"operator_guidance: rules={counts.get('rulesConsumed',0)} folders={counts.get('foldersCovered',0)} lines={counts.get('nativeLines',0)} pending={counts.get('pendingActions',0)}",
      'counts':counts,'stats':stats,'coverage':coverage,'blockingReasons':errors,
      'consumedAutomatically':True,'mutationAttempted':False,'externalSendAttempted':False,
      'artifacts':{'guidance':str(GUIDANCE),'nativeSnapshot':str(SNAPSHOT),'actionQueue':str(QUEUE)}}
    write_json(REPORT,payload);print(json.dumps({k:payload[k] for k in ('ok','summary','blockingReasons')},ensure_ascii=False))
    if errors:raise SystemExit(1)
if __name__=='__main__':main()
