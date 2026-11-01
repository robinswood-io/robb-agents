from __future__ import annotations

import json
import time
from pathlib import Path

from pydantic import JsonValue, TypeAdapter

JSON_OBJECT = TypeAdapter(dict[str, JsonValue])
JSON_ARRAY = TypeAdapter(list[JsonValue])

ROOT=Path('/srv/rbw-agents-oss')
OPS=Path('/home/craft/.craft-agent/workspaces/my-workspace-2/campaigns/ops')
HEALTH=OPS/'oss-agent-production-health-audit.json'
OUT=OPS/'oss-agent-business-gate-classifier.json'
MD=OPS/'oss-agent-business-gate-classifier.md'

EXPECTED_BUSINESS_GATES: dict[str, dict[str, JsonValue]] = {}
CLASSIFICATION_POLICY=ROOT/'config/registry/oss-business-gate-classification-policy.json'

TECHNICAL_REASON_MARKERS=('system_of_record_classification_missing','missing_runtime','technical_failed','timeout','script_missing')
EXPECTED_BUSINESS_REASON_MARKERS=(
 'sellsy_record_missing_or_unverified',
 'record_missing_or_unverified',
 'visual_system_not_approved',
 'business_result_non_ok',
 'business_report_current_slot',
 'blog_quality_gate_failed',
 'work_readback_failed',
 'traid_reports_not_ok',
 'traid_paper_research_remote_failed',
 'p41_report_missing',
 'schedule_freshness_stale',
 'worker_not_running',
 'pending_forms',
 'deliverability_bounce_rate',
 'adaptive_deliverability_pause',
 'lane_hard_bounce_rate',
 'no_qualified_reply_observed',
)

def now_iso() -> str: return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
def read_json(path: Path, default: JsonValue) -> JsonValue:
    try: return TypeAdapter(JsonValue).validate_json(path.read_bytes())
    except (OSError, ValueError): return default

def rows_from_health(data: dict[str, JsonValue]) -> list[dict[str, JsonValue]]:
    sample_value = data.get('samples')
    samples = sample_value if isinstance(sample_value, dict) else {}
    rows: list[dict[str, JsonValue]] = []
    for bucket in ('strictReportFailures','strictRuntimeFailures','technicalReportFailures','technicalRuntimeFailures','businessGates'):
        for r in JSON_ARRAY.validate_python(samples.get(bucket) or []):
            if isinstance(r,dict):
                item=dict(r); item['_bucket']=bucket; rows.append(item)
    seen: dict[str | None, dict[str, JsonValue]] = {}
    for r in rows:
        key = TypeAdapter(str | None).validate_python(r.get('id'))
        _ = seen.setdefault(key, r)
    return list(seen.values())

def classify(row: dict[str, JsonValue], expected_gates: dict[str, dict[str, JsonValue]] | None = None) -> dict[str, JsonValue]:
    gates=EXPECTED_BUSINESS_GATES if expected_gates is None else expected_gates
    aid=str(row.get('id') or '')
    blocking=[str(value) for field in ('reportBlocking', 'runtimeBlocking')
              for value in JSON_ARRAY.validate_python(row.get(field) or [])]
    status=str(row.get('reportStatus') or row.get('runtimeStatus') or '')
    if (str(row.get('_bucket')) in {'strictReportFailures', 'strictRuntimeFailures',
                                'technicalReportFailures', 'technicalRuntimeFailures'}
            or status.lower() in {'technical_failed', 'timeout', 'failed', 'error'}
            or row.get('reportReadError') or row.get('runtimeReadError')
            or any(marker in status for marker in ('pending_sync', 'technical_failed', 'timeout'))
            or any(marker in reason for reason in blocking for marker in TECHNICAL_REASON_MARKERS)):
        return {'agentId':aid,'classification':'technical_defect','status':status,
                'blockingReasons':list(blocking),'gateType':'technical','owner':'agent_runtime',
                'reason':'failed technical report/runtime evidence takes precedence over business labels'}
    if aid in gates:
        return {'agentId':aid,'classification':'expected_business_gate','status':status,'blockingReasons':list(blocking),**gates[aid]}
    hay='\n'.join([status]+blocking).lower()
    if any(marker in hay for marker in EXPECTED_BUSINESS_REASON_MARKERS):
        return {'agentId':aid,'classification':'expected_business_gate','status':status,'blockingReasons':list(blocking),'gateType':'recognized_business_or_data_gate','owner':'agent_then_operator','reason':'recognized fail-closed business/data/SOR gate, not runtime defect'}
    if status in {'business_failed','degraded','blocked'} or blocking:
        return {'agentId':aid,'classification':'unreviewed_business_or_data_gate','status':status,'blockingReasons':list(blocking),'gateType':'unknown_business_gate','owner':'agent_then_operator','reason':'business/data gate requires explicit classification'}
    return {'agentId':aid,'classification':'healthy','status':status,'blockingReasons':list(blocking),'gateType':'none','owner':'agent_runtime','reason':'no defect detected'}

def load_classification_policy(path: Path) -> dict[str, dict[str, JsonValue]]:
    data=read_json(path,{})
    if not isinstance(data,dict) or data.get('schemaVersion')!='oss-business-gate-classification-policy-v1':
        raise ValueError('classification_policy_missing_or_invalid')
    gates=data.get('expectedBusinessGates')
    if not isinstance(gates,dict) or not gates:
        raise ValueError('classification_rules_missing')
    for rule in gates.values():
        if not isinstance(rule,dict) or not all(
                isinstance(rule.get(field),str) and rule[field] for field in ('gateType','owner','reason')):
            raise ValueError('classification_rule_invalid')
    return TypeAdapter(dict[str, dict[str, JsonValue]]).validate_python(gates)

def main() -> None:
    data=JSON_OBJECT.validate_python(read_json(HEALTH,{}))
    if not isinstance(data.get('ok'), bool) or not isinstance(data.get('samples'), dict):
        raise TypeError('health_audit_missing_or_invalid')
    rows=rows_from_health(data)
    expected=load_classification_policy(CLASSIFICATION_POLICY)
    classified=[classify(r,expected) for r in rows]
    technical=[r for r in classified if r['classification']=='technical_defect']
    unreviewed=[r for r in classified if r['classification']=='unreviewed_business_or_data_gate']
    business=[r for r in classified if r['classification']=='expected_business_gate']
    payload={'generatedAt':now_iso(),'contractVersion':'oss-agent-business-gate-classifier-v3-expanded-business-gates','capabilityId':'oss-agent-business-gate-classifier','ok':not technical and not unreviewed,'status':'passed' if not technical and not unreviewed else 'degraded','summary':f"oss_agent_business_gate_classifier: technical_defects={len(technical)} expected_business_gates={len(business)} unreviewed={len(unreviewed)}",'counts':{'technicalDefects':len(technical),'expectedBusinessGates':len(business),'unreviewedBusinessOrDataGates':len(unreviewed),'inputRows':len(rows)},'blockingReasons':(['technical_defects'] if technical else [])+(['unreviewed_business_or_data_gates'] if unreviewed else []),'classified':classified,'artifacts':{'reportJson':str(OUT),'reportMd':str(MD),'healthAudit':str(HEALTH),'classificationPolicy':str(CLASSIFICATION_POLICY)},'updatedBy':'oss-agent-business-gate-classifier-v3-expanded-business-gates'}
    _ = OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2)+'\n')
    lines=['# Classification des barrières agents','',f"- Statut : **{payload['status']}**",f"- Défauts techniques : **{len(technical)}**",f"- Garde-fous métier attendus : **{len(business)}**",f"- Non revus : **{len(unreviewed)}**",'', '## Garde-fous métier attendus']
    for r in business: lines.append(f"- `{r['agentId']}` — {r['gateType']} — {r['reason']}")
    if technical:
        lines += ['', '## Défauts techniques']
        for r in technical: lines.append(f"- `{r['agentId']}` — {r['status']} — {', '.join(TypeAdapter(list[str]).validate_python(r.get('blockingReasons') or []))}")
    if unreviewed:
        lines += ['', '## À qualifier']
        for r in unreviewed: lines.append(f"- `{r['agentId']}` — {r['status']} — {', '.join(TypeAdapter(list[str]).validate_python(r.get('blockingReasons') or []))}")
    _ = MD.write_text('\n'.join(lines)+'\n')
    print(json.dumps({'ok':payload['ok'],'status':payload['status'],'summary':payload['summary'],'counts':payload['counts'],'blockingReasons':payload['blockingReasons']}, ensure_ascii=False))
    raise SystemExit(0 if payload['ok'] else 1)
if __name__=='__main__': main()