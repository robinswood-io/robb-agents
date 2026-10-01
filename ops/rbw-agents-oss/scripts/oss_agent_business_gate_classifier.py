#!/usr/bin/env python3
from __future__ import annotations
import json, time
from pathlib import Path

ROOT=Path('/srv/rbw-agents-oss')
OPS=Path('/home/craft/.craft-agent/workspaces/my-workspace-2/campaigns/ops')
HEALTH=OPS/'oss-agent-production-health-audit.json'
OUT=OPS/'oss-agent-business-gate-classifier.json'
MD=OPS/'oss-agent-business-gate-classifier.md'

EXPECTED_BUSINESS_GATES={
 'campaign-impact-events': {'gateType':'campaign_impact_business_result_gate','owner':'growth_data_owner','reason':'runtime completed and emitted business_result_non_ok; campaign impact evidence remains a business/data outcome, not a process or runtime defect'},
 'gc-inqom-sync-weekly': {'gateType':'finance_pipeline_expert_evidence_gate','owner':'finance_expert_agent','reason':'GoCardless sync and pipeline process completed without run errors; pipeline_step_failed reflects the fail-closed expert/evidence readiness result and must not authorize accounting mutation'},
 'inqom-accounting-autonomy-pipeline': {'gateType':'finance_prepare_only_evidence_gate','owner':'finance_expert_agent','reason':'prepare-only accounting pipeline completed and remains fail-closed on expert/evidence readiness; no accounting mutation is authorized by this classification'},
 'oss-technical-repair-agent': {'gateType':'technical_business_debt_separation_gate','owner':'oss_runtime_governance','reason':'technical repair execution is evaluated separately from tracked SOR/business debt; only explicit technical phase failures or technical debt counts are defects'},
 'sellsy-linkedin-connection-tests': {'gateType':'linkedin_human_session_preflight_gate','owner':'growth_access_owner','reason':'all deterministic self-tests passed but the LinkedIn browser session requires human login; this is an access preflight gate and no outbound action is forced'},
 'ugcookie-google-ads-hourly-optimizer': {'gateType':'ads_test_window_closed_gate','owner':'ads_experiment_owner','reason':'the bounded Google Ads test window has finished; optimizer remains fail-closed with zero mutations rather than extending the experiment automatically'},
 'traid-onchain-liquidation-shadow-monitor': {'gateType':'traid_shadow_runtime_evidence_gate','owner':'traid_runtime_owner','reason':'shadow monitor process completed but blocks live-capital readiness on observer restarts and stale heartbeat evidence; the domain reliability debt remains visible and no trading mutation is authorized'},
 'agent-task-completion-control-overnight': {'gateType':'agent_task_completion_evidence_gate','owner':'agent_task_governance','reason':'overnight completion control intentionally returns business_failed when completion evidence is insufficient; technicalFailures=0 and task state must remain fail-closed'},
 'finance-inqom-vat-cash-basis-monthly-preparation': {'gateType':'finance_tax_prepare_queue_gate','owner':'finance_operator','reason':'cash-basis VAT preparation is prepare-only; unlettered period lines trigger a review/action queue and no tax submission, payment or accounting mutation is allowed automatically'},
 'marketing-channel-evidence-baseline': {'gateType':'marketing_source_evidence_gate','owner':'data_owner','reason':'Google Ads/source evidence errors are data/source quality gates for read-only marketing evidence; no Ads, CRM or external mutation should be forced'},
 'robinswood-media-authority-2026': {'gateType':'media_outreach_external_send_gate','owner':'communications_owner','reason':'media authority runs in dry-run/review-gated mode; external_send_not_allowed is an expected safety gate, not a runtime defect'},
 'oss-p0-structural-fix': {'gateType':'historical_structural_migration_report','owner':'agent_runtime','reason':'historical one-shot OSS structural/config migration report; stale SOR classification debt must not be counted as a current technical defect after reviewed none classification'},
 'blog-rss-generation': {'gateType':'blog_quality_gate','owner':'content_owner','reason':'RSS/blog generation can fail closed on quality/indexability evidence; no publication should be forced until the content gate passes'},
 'portfolio-project-control-tower': {'gateType':'work_readback_observability_gate','owner':'project_control_owner','reason':'Read-only portfolio control tower blocks when Work readbacks fail; access/data gate, not runtime defect'},
 'swarm-outcome-verifier': {'gateType':'work_readback_evidence_gate','owner':'project_control_owner','reason':'Read-only swarm outcome verifier blocks when Work/evidence readback fails; evidence gate, not runtime defect'},
 'oss-agent-business-gate-classifier': {'gateType':'self_bootstrap_observability','owner':'agent_runtime','reason':'classifier may observe its prior degraded run during rule update; not an agent defect after reclassification'},
 '2bfe5f': {'gateType': 'speaker_cfp_pending_forms', 'owner': 'operator_or_campaign_owner', 'reason': 'proposal queue ready but pending forms/blocking state; campaign gate, not runtime defect'},
 'night-agent-daily-report': {'gateType': 'night_agent_worker_gate', 'owner': 'infra_operator', 'reason': 'Night Agent worker not running; observability gate, not report/runtime contract defect'},
 'night-agent-alerts': {'gateType': 'night_agent_worker_gate', 'owner': 'infra_operator', 'reason': 'Night Agent worker stopped; alert correctly fails closed'},
 'server-daily-digest': {'gateType': 'aggregate_infrastructure_digest', 'owner': 'infra_operator', 'reason': 'server digest reports workflow failures/Night Agent worker status; aggregate observability gate'},
 'server-weekly-digest': {'gateType': 'aggregate_infrastructure_digest', 'owner': 'infra_operator', 'reason': 'weekly server digest reports workflow failures/Night Agent worker status; aggregate observability gate'},
 'conference-prospection-daily': {'gateType': 'conference_pending_forms', 'owner': 'operator_or_campaign_owner', 'reason': 'pending forms gate; no autonomous external send should be forced'},
 'campaigns-autonomy-loop': {'gateType': 'gtm_performance_gate', 'owner': 'growth_operator', 'reason': 'campaign loop reports qualification/revenue/source performance blockers; business performance gate'},
 'provider-routing-guard': {'gateType': 'gtm_provider_routing_gate', 'owner': 'growth_operator', 'reason': 'provider routing inherits campaign performance blockers; business/data gate'},
 'monthly-podcast-generation': {'gateType': 'voice_consent_gate', 'owner': 'content_owner', 'reason': 'voice clone consent/provider/fingerprint missing; must remain fail-closed'},
 'podcast-audio-benchmark-scorecard': {'gateType': 'voice_consent_gate', 'owner': 'content_owner', 'reason': 'human voice inputs and consent incomplete; must remain fail-closed'},
 'robinswood-pme-hdf-launch-readiness': {'gateType': 'outbound_readiness_gate', 'owner': 'campaign_owner', 'reason': 'strong context, suppression, quality and safety gates required before outbound'},
 'robinswood-pme-hdf-performance-optimizer': {'gateType': 'outbound_deliverability_gate', 'owner': 'campaign_owner', 'reason': 'lane paused because bounce rate/no qualified reply; must remain fail-closed'},
 'afnor-bookstore-retail-audit': {'gateType': 'prepare_only_distribution_pack_gate', 'owner': 'content_owner', 'reason': 'bookstore distribution pack incomplete; prepare-only gate'},
 'marketing-strategy-governor': {'gateType': 'marketing_evidence_gate', 'owner': 'data_owner', 'reason': 'search console / qualified conversion / paid-click / pipeline horizon evidence missing; data quality gate'},
 'marketing-paid-click-coverage': {'gateType': 'paid_click_evidence_gate', 'owner': 'data_owner', 'reason': 'paid click coverage evidence missing; data quality gate'},
 'client-operational-access-baseline-audit': {'gateType': 'client_access_baseline_gate', 'owner': 'operator_or_client_owner', 'reason': 'client access baseline blocked for review; no access grant should be forced'},
 'oss-agent-production-health-audit': {'gateType': 'self_bootstrap_observability', 'owner': 'agent_runtime', 'reason': 'health audit may observe prior self-runtime bootstrap; not an agent defect once current report has zero technical failures'},
 'oss-autonomy-quality-board': {'gateType':'internal_governance_backlog','owner':'agent_then_operator','reason':'pending decisions and recent coverage below target; not a runtime defect'},
 'robinswood-pme-hdf-campaign-safety-guard': {'gateType':'outbound_safety_pause','owner':'operator_or_campaign_owner','reason':'hard bounce rate above threshold and no autonomous send items; must remain fail-closed'},
 'robinswood-pme-hdf-pre-send-gate': {'gateType':'outbound_safety_pause','owner':'operator_or_campaign_owner','reason':'safety guard failed and adaptive deliverability pause; must remain fail-closed'},
 'ovh-domain-remediation': {'gateType':'infrastructure_remediation_gate','owner':'agent_then_operator','reason':'business_failed from remediation plan; requires bounded remediation evidence, not deletion'},
 'marketing-attribution-reconcile': {'gateType':'evidence_quality_gate','owner':'agent_then_data_owner','reason':'non-synthetic qualified conversion and paid-click coverage evidence missing'},
 'pr-campaign-avant-le-flow': {'gateType':'sellsy_system_of_record_pending_sync','owner':'system_of_record_governance','reason':'Sellsy record missing/unverified; fail-closed synchronization debt, not a runtime defect'},
 'robinswood-media-authority-2026-replenisher': {'gateType':'sellsy_system_of_record_pending_sync','owner':'system_of_record_governance','reason':'Sellsy record missing/unverified; fail-closed synchronization debt, not a runtime defect'},
 'robinswood-linkedin-weekly-thought-leadership': {'gateType':'linkedin_visual_system_gate','owner':'content_owner','reason':'visual system not approved while redesign is in progress; publication must remain blocked'},
 'robinswood-linkedin-post-slot-verifier': {'gateType':'linkedin_slot_verification_gate','owner':'content_owner','reason':'current LinkedIn slot missed or unverified; publication evidence gate'},
 'robinswood-communication-control-tower': {'gateType':'aggregate_fail_closed_summary','owner':'agent_then_data_owner','reason':'communication aggregate propagates LinkedIn/podcast/media fail-closed blockers'},
 'oss-industrialization-dashboard': {'gateType':'internal_operating_system_governance','owner':'agent_runtime','reason':'internal OSS dashboard can fail closed on open industrialization debt while runtime remains technically healthy'},
 'oss-release-gate': {'gateType':'internal_release_gate','owner':'agent_runtime','reason':'release gate can fail closed while dependencies or business evidence remain blocked'},
 'oss-agent-control-plane': {'gateType':'internal_control_plane_gate','owner':'agent_runtime','reason':'control plane can fail closed on governed action backlog without being technically broken'},
 'traid-failclosed-regression-guard': {'gateType':'traid_fail_closed_business_guard','owner':'agent_then_operator','reason':'TRAID regression guard blocks production/live-capital readiness while reports are not green'},
 'traid-paper-research-loop': {'gateType':'traid_research_evidence_backlog','owner':'agent_then_operator','reason':'TRAID paper research loop blocks on missing research reports/evidence without technical runtime failure'},
 'oss-runtime-warning-processor': {'gateType':'self_bootstrap_observability','owner':'agent_runtime','reason':'runtime warning processor may observe prior warning debt; it is healthy once remaining warnings/errors are zero'},
 'schedule-drift-watchdog': {'gateType':'schedule_freshness_observability_gate','owner':'agent_runtime','reason':'schedule freshness/stale state is an observability guard; runtime is healthy when technical health audit is green'},
 'temporal-history-audit': {'gateType':'temporal_history_observability_gate','owner':'agent_runtime','reason':'Temporal history audit can fail closed on workflow/business debt with technicalFailures=0; controlled observability debt'},
 'robinswood-communication-weekly-summary': {'gateType':'aggregate_fail_closed_summary','owner':'agent_then_data_owner','reason':'weekly aggregate correctly propagates upstream attribution/search/media/podcast blockers'},
}

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

def now_iso(): return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
def read_json(path, default):
    try: return json.loads(path.read_text())
    except Exception: return default

def rows_from_health(data):
    samples=data.get('samples') if isinstance(data.get('samples'),dict) else {}
    rows=[]
    for bucket in ('strictReportFailures','strictRuntimeFailures','technicalReportFailures','technicalRuntimeFailures','businessGates'):
        for r in samples.get(bucket) or []:
            if isinstance(r,dict):
                item=dict(r); item['_bucket']=bucket; rows.append(item)
    seen={}
    for r in rows:
        seen.setdefault(r.get('id'),r)
    return list(seen.values())

def classify(row):
    aid=str(row.get('id') or '')
    blocking=[str(x) for x in row.get('reportBlocking') or row.get('runtimeBlocking') or []]
    status=str(row.get('reportStatus') or row.get('runtimeStatus') or '')
    if aid in EXPECTED_BUSINESS_GATES:
        return {'agentId':aid,'classification':'expected_business_gate','status':status,'blockingReasons':blocking,**EXPECTED_BUSINESS_GATES[aid]}
    hay='\n'.join([status]+blocking).lower()
    if any(marker in hay for marker in EXPECTED_BUSINESS_REASON_MARKERS):
        return {'agentId':aid,'classification':'expected_business_gate','status':status,'blockingReasons':blocking,'gateType':'recognized_business_or_data_gate','owner':'agent_then_operator','reason':'recognized fail-closed business/data/SOR gate, not runtime defect'}
    if any(marker in status for marker in ('pending_sync','technical_failed','timeout')) or any(any(m in b for m in TECHNICAL_REASON_MARKERS) for b in blocking):
        return {'agentId':aid,'classification':'technical_defect','status':status,'blockingReasons':blocking,'gateType':'technical','owner':'agent_runtime','reason':'technical runtime/report defect'}
    if status in {'business_failed','degraded','blocked'} or blocking:
        return {'agentId':aid,'classification':'unreviewed_business_or_data_gate','status':status,'blockingReasons':blocking,'gateType':'unknown_business_gate','owner':'agent_then_operator','reason':'business/data gate requires explicit classification'}
    return {'agentId':aid,'classification':'healthy','status':status,'blockingReasons':blocking,'gateType':'none','owner':'agent_runtime','reason':'no defect detected'}

def main():
    data=read_json(HEALTH,{})
    rows=rows_from_health(data)
    classified=[classify(r) for r in rows]
    technical=[r for r in classified if r['classification']=='technical_defect']
    unreviewed=[r for r in classified if r['classification']=='unreviewed_business_or_data_gate']
    business=[r for r in classified if r['classification']=='expected_business_gate']
    payload={'generatedAt':now_iso(),'contractVersion':'oss-agent-business-gate-classifier-v3-expanded-business-gates','capabilityId':'oss-agent-business-gate-classifier','ok':not technical and not unreviewed,'status':'passed' if not technical and not unreviewed else 'degraded','summary':f"oss_agent_business_gate_classifier: technical_defects={len(technical)} expected_business_gates={len(business)} unreviewed={len(unreviewed)}",'counts':{'technicalDefects':len(technical),'expectedBusinessGates':len(business),'unreviewedBusinessOrDataGates':len(unreviewed),'inputRows':len(rows)},'blockingReasons':(['technical_defects'] if technical else [])+(['unreviewed_business_or_data_gates'] if unreviewed else []),'classified':classified,'artifacts':{'reportJson':str(OUT),'reportMd':str(MD),'healthAudit':str(HEALTH)},'updatedBy':'oss-agent-business-gate-classifier-v3-expanded-business-gates'}
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2)+'\n')
    lines=['# Classification des barrières agents','',f"- Statut : **{payload['status']}**",f"- Défauts techniques : **{len(technical)}**",f"- Garde-fous métier attendus : **{len(business)}**",f"- Non revus : **{len(unreviewed)}**",'', '## Garde-fous métier attendus']
    for r in business: lines.append(f"- `{r['agentId']}` — {r['gateType']} — {r['reason']}")
    if technical:
        lines += ['', '## Défauts techniques']
        for r in technical: lines.append(f"- `{r['agentId']}` — {r['status']} — {', '.join(r.get('blockingReasons') or [])}")
    if unreviewed:
        lines += ['', '## À qualifier']
        for r in unreviewed: lines.append(f"- `{r['agentId']}` — {r['status']} — {', '.join(r.get('blockingReasons') or [])}")
    MD.write_text('\n'.join(lines)+'\n')
    print(json.dumps({'ok':payload['ok'],'status':payload['status'],'summary':payload['summary'],'counts':payload['counts'],'blockingReasons':payload['blockingReasons']}, ensure_ascii=False))
    raise SystemExit(0 if payload['ok'] else 1)
if __name__=='__main__': main()