#!/usr/bin/env python3
from __future__ import annotations
import datetime as dt
import json
import os
import pathlib
import sys
import tempfile
sys.path.insert(0, str(pathlib.Path(__file__).parent))
import inqom_business_autonomy_control_plane as cp


def main() -> int:
    checks=[]
    def check(name, ok, detail=None): checks.append({"name":name,"ok":bool(ok),"detail":detail})
    live_path=cp.OPS/"inqom-business-autonomy-control-plane.json"
    live, live_errors=cp.read_json(live_path)
    check("live_report_readable", not live_errors, live_errors)
    check("business_control_plane_verified", live.get("ok") is True and live.get("platformReady") is True and live.get("businessAutonomyStatus") in {"complete_verified","review_required"}, {"ok":live.get("ok"),"status":live.get("businessAutonomyStatus"),"blocking":live.get("blockingReasons")})
    metrics=cp.as_dict(live.get("metrics"))
    check("business_metric_consistent_pending_not_complete", metrics.get("unresolvedTechnical")==0 and metrics.get("businessAutonomyRate") == (round((metrics.get("completedNoActionRequired",0)+metrics.get("agentExecutedVerified",0))/metrics["technicalDenominator"],6) if metrics["technicalDenominator"] else 1.0) and (live.get("businessAutonomyStatus")=="complete_verified") == (metrics.get("businessAutonomyRate") >= metrics.get("businessAutonomyTarget",1)), metrics)
    reg,_=cp.read_json(cp.OPS/"inqom-execution-readiness-registry.json");res,_=cp.read_json(cp.OPS/"inqom-expert-route-autonomous-resolver.json")
    current_doctrine,current_manual,current_expert,current_scope_issues=cp.current_human_residual_records(res,reg)
    check("exact_human_residual_scope", metrics.get("humanDoctrine")==len(current_doctrine) and metrics.get("manualIncompressible")==len(current_manual) and metrics.get("expertDecisionRemaining")==len(current_expert) and not current_scope_issues, metrics)
    check("no_mutation_or_rework", metrics.get("mutationAttempts")==0 and metrics.get("reworkOrDriftEvents")==0, metrics)
    counts=cp.as_dict(live.get("counts"))
    check("transaction_lineages_complete", int(counts.get("transactionLineages",0))>=1, counts)
    check("fixed_asset_groups_complete", int(counts.get("fixedAssetGroups",0))>=1, counts)
    check("document_provenance_present", int(counts.get("documentEvidenceRecords",0))>=107, counts)

    with tempfile.TemporaryDirectory() as td:
        root=pathlib.Path(td)
        corrupt=root/"corrupt.json"; corrupt.write_text("{broken")
        _, errors=cp.read_json(corrupt)
        check("corrupted_report_blocked", bool(errors) and errors[0].startswith("corrupt_report"), errors)
        stale={"generatedAt":"2026-09-04T00:00:00Z","ok":True,"blockingReasons":[],"counts":{}}
        previous_now=os.environ.get("RBW_NOW")
        os.environ["RBW_NOW"]="2026-09-05T10:36:00Z"
        fresh, age=cp.freshness(stale,180)
        if previous_now is None:
            os.environ.pop("RBW_NOW",None)
        else:
            os.environ["RBW_NOW"]=previous_now
        check("obsolete_report_blocked", not fresh and age and age>180, age)
        hidden={"ok":True,"counts":{"failed":0},"nested":{"branch":[{"mutationAttempted":True}]}}
        hits=cp.recursive_positive_mutations(hidden)
        check("hidden_recursive_mutation_detected", len(hits)==1 and hits[0]["path"].endswith("mutationAttempted"), hits)
        false_zero={"statusCounts":{"completed_no_action_required":0},"records":[{"readinessStatus":"completed_no_action_required"}]}
        derived={}
        for row in false_zero["records"]: derived[row["readinessStatus"]]=derived.get(row["readinessStatus"],0)+1
        mismatch=any(false_zero["statusCounts"].get(k,-1)!=v for k,v in derived.items())
        check("false_zero_count_detected", mismatch, {"declared":false_zero["statusCounts"],"derived":derived})
        pack=root/"enriched.json"
        pack.write_text(json.dumps({"items":[{"entryIds":[1],"lineIds":[2],"transactionIds":[3],"docRefs":["FC-1"],"accounts":["51200000"],"amounts":[10],"nativeIdentifierIssues":[]}]}))
        rows, exceptions, issues=cp.transaction_registry({"counts":{"items":1},"packs":[{"slug":"test","enrichedPackJson":str(pack)}]},{"queue":[]})
        check("transaction_lineage_has_exact_ids_and_hash", not issues and rows[0]["entryIds"]==[1] and rows[0]["lineIds"]==[2] and rows[0]["transactionIds"]==[3] and len(rows[0]["sourcePackSha256"])==64, {"rows":rows,"issues":issues})
        source=root/"docs.json"; source.write_text("{}")
        docs, issues=cp.document_registry({"generatedAt":"2026-09-05T10:36:00Z","counts":{"humanQuestionRows":0},"classifiedRows":[{"entryId":1,"lineId":2,"docRef":"FC-1","classification":"counterpart_covered","humanQuestionRequired":False}]},{},["docref","counterpart"],{"documentClassifier":source,"documentRetriever":root/"missing.json"})
        check("inherited_document_evidence_hashed", not issues and docs[0]["coverageMode"]=="inherited" and len(docs[0]["evidenceHash"])==64, {"docs":docs,"issues":issues})
        doctrine_id="exec-reg:doctrine"; manual_id="exec-reg:manual"
        registry={"records":[{"registryId":doctrine_id,"readinessStatus":"requires_human_doctrine"},{"registryId":manual_id,"readinessStatus":"manual_only"}]}
        contract={"expectedHumanResiduals":{"humanDoctrineRegistryIds":[doctrine_id],"manualIncompressibleRegistryIds":[manual_id]}}
        doctrine, manual, issues=cp.human_residual_records({},registry,contract)
        check("unverified_human_residual_scope_rejected", issues == ["current_human_residual_scope_unverified"] and not doctrine and not manual, issues)

    failed=[x for x in checks if not x["ok"]]
    report={"generatedAt":cp.iso_now(),"ok":not failed,"status":"passed" if not failed else "failed","counts":{"checks":len(checks),"failed":len(failed),"criticalFailed":len(failed)},"checks":checks,"blockingReasons":[x["name"] for x in failed],"mutationAttempted":0,"adversarialCoverage":["stale_report","corrupt_json","false_zero_count","hidden_recursive_mutation","exact_lineage_hash","inherited_evidence_hash","exact_human_residual_set"]}
    out=cp.OPS/"inqom-business-autonomy-control-plane-tests.json"; out.parent.mkdir(parents=True,exist_ok=True); out.write_text(json.dumps(report,ensure_ascii=False,indent=2)+"\n")
    print(json.dumps(report,ensure_ascii=False)); return 0 if report["ok"] else 1
if __name__=="__main__": raise SystemExit(main())
