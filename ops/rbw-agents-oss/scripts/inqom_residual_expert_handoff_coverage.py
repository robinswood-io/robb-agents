#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from action_queue_contract import normalize_action_list, validate_action_item

WS = Path('/home/craft/.craft-agent/workspaces/my-workspace-2')
OPS = WS / 'campaigns' / 'ops'
ROUTER_JSON = OPS / 'inqom-execution-blocker-burndown-router.json'
ROUTER_QUEUE_JSON = OPS / 'inqom-execution-blocker-burndown-router-queue.json'
REGISTRY_JSON = OPS / 'inqom-execution-readiness-registry.json'
REGISTRY_JSONL = OPS / 'inqom-execution-readiness-registry-records.jsonl'
ACCOUNTANT_PACK_JSON = OPS / 'inqom-accountant-consolidated-review-pack.json'
ACCOUNTANT_INTAKE_JSON = OPS / 'inqom-accountant-response-intake.json'
OUT_JSON = OPS / 'inqom-residual-expert-handoff-coverage.json'
OUT_MD = OPS / 'inqom-residual-expert-handoff-coverage.md'
OUT_QUEUE = OPS / 'inqom-residual-expert-handoff-coverage-queue.json'
ACTIVE_APPROVAL = WS / 'sources' / 'inqom' / 'mutation-approvals' / 'active-autonomous-approval.json'
ORIGIN = 'inqom-residual-expert-handoff-coverage'

EXPECTED_EXPERT_ROUTES = {
    'source_quality_review',
    'expert_review',
    'bank_reconciliation_no_link_candidate_review',
    'bank_reconciliation_review',
    'closing_balance_review',
    'doctrine_question',
    'fixed_assets_expert_review',
    'manual_only',
    'unrevised_revision_expert_gate',
}
MUTATING_EFFECT_TOKENS = {
    'native_lettering',
    'native_reconciliation',
    'native_revision_marking',
    'entry_creation',
    'entry_update',
    'accounting_posting',
    'tax_submission',
    'tax_payment',
    'external_send',
    'inqom_mutation',
}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


def read_json(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except Exception:
        return default


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    try:
        for line in path.read_text(encoding='utf-8').splitlines():
            if line.strip():
                obj = json.loads(line)
                if isinstance(obj, dict):
                    rows.append(obj)
    except Exception:
        pass
    return rows


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True) + '\n', encoding='utf-8')


def stable_hash(value: Any) -> str:
    return hashlib.sha1(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()[:16]


def report_ok(path_value: Any) -> bool:
    try:
        path = Path(str(path_value))
    except Exception:
        return False
    payload = read_json(path, None)
    if isinstance(payload, list):
        return True
    if not isinstance(payload, dict):
        return False
    if payload.get('ok') is False:
        return False
    blockers = payload.get('blockingReasons')
    if isinstance(blockers, list) and blockers:
        return False
    return True


def report_summary(path_value: Any) -> dict[str, Any]:
    try:
        path = Path(str(path_value))
    except Exception:
        return {'path': str(path_value), 'exists': False, 'ok': False}
    payload = read_json(path, None)
    if isinstance(payload, list):
        return {'path': str(path), 'exists': path.exists(), 'ok': True, 'listCount': len(payload)}
    if isinstance(payload, dict):
        return {
            'path': str(path),
            'exists': path.exists(),
            'ok': payload.get('ok'),
            'status': payload.get('status'),
            'summary': payload.get('summary'),
            'blockingReasons': payload.get('blockingReasons'),
        }
    return {'path': str(path), 'exists': path.exists(), 'ok': False}


def compact_record(record: dict[str, Any]) -> dict[str, Any]:
    return {
        'registryId': record.get('registryId'),
        'family': record.get('family'),
        'title': record.get('title'),
        'readinessStatus': record.get('readinessStatus'),
        'mutationType': record.get('mutationType'),
        'sourceAutomation': record.get('sourceAutomation'),
        'sourceTarget': record.get('sourceTarget'),
        'readinessReasons': record.get('readinessReasons'),
        'blockersBeforeExecution': record.get('blockersBeforeExecution'),
    }


def route_record_ids(action: dict[str, Any]) -> list[str]:
    data = action.get('data') if isinstance(action.get('data'), dict) else {}
    return [str(x) for x in (data.get('registryIds') or [])]


def has_mutating_permission(action: dict[str, Any]) -> bool:
    data = action.get('data') if isinstance(action.get('data'), dict) else {}
    explicit_flags = [
        action.get('mutationAllowed'),
        action.get('externalSendAllowed'),
        data.get('mutationAllowed'),
        data.get('externalSendAllowed'),
        data.get('nativeReclassificationAllowed'),
        data.get('nativeReconciliationAllowed'),
        data.get('nativeLetteringAllowed'),
        data.get('nativeRevisionMarkingAllowed'),
        data.get('taxSubmissionAllowed'),
        data.get('taxPaymentAllowed'),
    ]
    return any(flag is True for flag in explicit_flags)


def coverage_label(route: str, families: list[str], statuses: dict[str, int]) -> str:
    if route == 'source_quality_review':
        return 'Recherche des pièces et justificatifs par les agents, puis demande au fournisseur vers l’adresse Inqom vérifiée selon les consignes opérateur ; décision comptable et écritures restent bloquées.'
    if route == 'expert_review':
        return 'Dossiers restants transmis à l’expert avec leurs identifiants et pièces ; aucune correction ni clôture automatique tant que la décision n’est pas justifiée.'
    if route == 'bank_reconciliation_no_link_candidate_review':
        return 'Revue expert-comptable ciblée : flux GoCardless/PublicApi internes 517/580 sans TransactionId natif ; note agent déjà prête, aucun lien bancaire exact à proposer.'
    if route == 'bank_reconciliation_review':
        return 'Paquets de rapprochement bancaire/intercompany ambigus déjà préparés ; décision expert-comptable requise avant tout futur préflight.'
    if route == 'closing_balance_review':
        return 'Revue de clôture interne : contrôle préparatoire uniquement, aucun mouvement comptable.'
    if route == 'doctrine_question':
        return 'Questions de doctrine regroupées : comptes d’attente Aolénia/Cindy/Wafuu et arbitrage TVA déductible.'
    if route == 'fixed_assets_expert_review':
        return 'Dossiers immobilisations, clôture et règles review-only déjà préparés ; validation experte uniquement.'
    if route == 'manual_only':
        return 'Dossiers nécessitant une intervention manuelle ou une décision experte ; aucune écriture, télédéclaration ou paiement automatique.'
    if route == 'unrevised_revision_expert_gate':
        return 'Marquage révisé natif interdit tant que les familles de lignes non révisées ne sont pas validées par expert.'
    return f'Route résiduelle {route}: familles={families}, statuts={statuses}'


def residual_route_owner_valid(action: dict, route_records: list[dict]) -> bool:
    route = str((action.get('data') or {}).get('route') or '')
    expected_owner = 'agent_then_expert_accountant' if route == 'source_quality_review' else 'expert_accountant'
    if route not in EXPECTED_EXPERT_ROUTES or action.get('owner') != expected_owner or not route_records:
        return False
    if has_mutating_permission(action):
        return False
    for row in route_records:
        if (row.get('readinessStatus') not in {'requires_human_doctrine','requires_expert_decision','manual_only'}
            or isinstance(row.get('autonomousResolution'), dict)
            or row.get('mutationAllowedCurrent') is not False
            or row.get('canEnterApprovalOnlyPreflight') is not False):
            return False
        if route == 'source_quality_review' and (
            row.get('family') != 'source_quality' or row.get('readinessStatus') != 'requires_expert_decision'):
            return False
    return True


def responsible_handoff_contract(router_counts: dict, status_counts: dict, queue: list[dict], records: list[dict]) -> bool:
    protected = [r for r in records if r.get('readinessStatus') in {'requires_human_doctrine','requires_expert_decision','manual_only'}]
    by_id = {r.get('registryId'): r for r in protected}
    seen = []
    if not by_id or len(by_id) != len(protected): return False
    for action in queue:
        ids = route_record_ids(action)
        if not ids or any(i not in by_id for i in ids): return False
        if not residual_route_owner_valid(action, [by_id[i] for i in ids]): return False
        seen.extend(ids)
    agent = sum(a.get('owner') == 'agent_then_expert_accountant' for a in queue)
    expert = sum(a.get('owner') == 'expert_accountant' for a in queue)
    return (
        len(seen) == len(set(seen)) == len(by_id) and set(seen) == set(by_id)
        and router_counts.get('queue') == len(queue)
        and router_counts.get('agentRoutes') == agent
        and router_counts.get('expertRoutes') == expert
        and agent + expert == len(queue) and router_counts.get('engineeringRoutes') == 0
        and all(status_counts.get(k) == 0 for k in ['ready_for_autonomous_preflight','blocked_by_live_drift','blocked_by_missing_native_tool'])
    )


def make_handoff_action(route_item: dict[str, Any], route: str, route_records: list[dict[str, Any]], source_reports: list[dict[str, Any]]) -> dict[str, Any]:
    data = route_item.get('data') if isinstance(route_item.get('data'), dict) else {}
    families = sorted({str(r.get('family') or '') for r in route_records if r.get('family')})
    statuses = Counter(str(r.get('readinessStatus') or '') for r in route_records)
    return {
        'owner': 'agent_then_expert_accountant' if route == 'source_quality_review' else 'expert_accountant',
        'actionType': 'prepare_residual_evidence_request' if route == 'source_quality_review' else 'expert_residual_handoff_review_only',
        'priority': 'high' if route in {'expert_review', 'doctrine_question', 'manual_only', 'unrevised_revision_expert_gate'} else 'medium',
        'actionableNow': True,
        'target': f'inqom:residual-expert-handoff:{route}',
        'title': f'Recherche de pièces — {route}' if route == 'source_quality_review' else f'Passage expert — {route}',
        'summary': coverage_label(route, families, dict(statuses)),
        'blockingReason': 'expert_or_doctrine_decision_required_no_agent_mutation',
        'doneCondition': 'Pièce et justification retrouvées, doublons vérifiés, transmission au dossier Inqom exact selon les consignes opérateur ; toute écriture reste soumise au préflight et à une autorisation séparée.' if route == 'source_quality_review' else 'Décision expert-comptable/doctrine ou action portail manuel réalisée hors agent ; toute mutation future nécessite préflight exact et approbation active séparée.',
        'data': {
            'route': route,
            'sourceRouteActionId': route_item.get('id'),
            'recordCount': len(route_records),
            'families': families,
            'statuses': dict(statuses),
            'registryIds': [r.get('registryId') for r in route_records],
            'sourceReports': source_reports,
            'mutationAllowed': False,
            'externalSendAllowed': False,
            'nativeReconciliationAllowed': False,
            'nativeLetteringAllowed': False,
            'nativeRevisionMarkingAllowed': False,
            'taxSubmissionAllowed': False,
            'taxPaymentAllowed': False,
        },
        'dedupeKey': f'{ORIGIN}:{route}:{len(route_records)}:{stable_hash([r.get("registryId") for r in route_records])}',
        'mutationAllowed': False,
        'externalSendAllowed': False,
    }


def main() -> None:
    gen = now_iso()
    validation: list[dict[str, Any]] = []
    router = read_json(ROUTER_JSON, {})
    router_queue = read_json(ROUTER_QUEUE_JSON, [])
    registry = read_json(REGISTRY_JSON, {})
    records = read_jsonl(REGISTRY_JSONL)
    accountant_pack = read_json(ACCOUNTANT_PACK_JSON, {})
    accountant_intake = read_json(ACCOUNTANT_INTAKE_JSON, {})
    if not isinstance(router_queue, list):
        router_queue = []
    if not isinstance(router, dict) or router.get('ok') is not True:
        validation.append({'code': 'router_not_ok', 'detail': router.get('blockingReasons') if isinstance(router, dict) else None})
    if not isinstance(registry, dict) or registry.get('ok') is not True:
        validation.append({'code': 'registry_not_ok', 'detail': registry.get('blockingReasons') if isinstance(registry, dict) else None})
    if not records:
        validation.append({'code': 'registry_records_missing', 'detail': str(REGISTRY_JSONL)})
    if ACTIVE_APPROVAL.exists():
        validation.append({'code': 'active_approval_path_exists', 'detail': str(ACTIVE_APPROVAL)})

    records_by_id = {str(r.get('registryId')): r for r in records if r.get('registryId')}
    route_items: list[dict[str, Any]] = []
    action_queue: list[dict[str, Any]] = []
    uncovered_records: list[dict[str, Any]] = []
    unexpected_routes: list[str] = []
    mutating_route_items: list[str] = []
    non_expert_route_items: list[str] = []
    source_report_failures: list[dict[str, Any]] = []

    for action in router_queue:
        if not isinstance(action, dict):
            continue
        data = action.get('data') if isinstance(action.get('data'), dict) else {}
        route = str(data.get('route') or action.get('target', '').split(':')[-1])
        ids = route_record_ids(action)
        route_records = [records_by_id[rid] for rid in ids if rid in records_by_id]
        missing_ids = [rid for rid in ids if rid not in records_by_id]
        if route not in EXPECTED_EXPERT_ROUTES:
            unexpected_routes.append(route)
        if not residual_route_owner_valid(action, route_records):
            non_expert_route_items.append(route)
        if has_mutating_permission(action):
            mutating_route_items.append(route)
        if missing_ids or len(route_records) != int(data.get('recordCount') or len(route_records)):
            uncovered_records.append({'route': route, 'missingRegistryIds': missing_ids, 'expectedCount': data.get('recordCount'), 'foundCount': len(route_records)})

        report_paths = sorted({str(r.get('sourceReport')) for r in route_records if r.get('sourceReport')})
        source_reports = [report_summary(path) for path in report_paths]
        for rep in source_reports:
            if not rep.get('exists') or rep.get('ok') is False or rep.get('blockingReasons'):
                source_report_failures.append({'route': route, 'sourceReport': rep})

        readiness_statuses = Counter(str(r.get('readinessStatus') or '') for r in route_records)
        families = sorted({str(r.get('family') or '') for r in route_records if r.get('family')})
        route_items.append({
            'route': route,
            'owner': action.get('owner'),
            'recordCount': len(route_records),
            'expectedRecordCount': data.get('recordCount'),
            'families': families,
            'readinessStatuses': dict(readiness_statuses),
            'registryIds': [r.get('registryId') for r in route_records],
            'sourceReports': source_reports,
            'coverage': coverage_label(route, families, dict(readiness_statuses)),
            'sample': [compact_record(r) for r in route_records[:8]],
            'mutationAllowed': False,
            'externalSendAllowed': False,
        })
        action_queue.append(make_handoff_action(action, route, route_records, source_reports))

    action_queue = normalize_action_list(action_queue, origin_automation=ORIGIN)
    queue_validation = []
    for item in action_queue:
        issues = validate_action_item(item)
        if issues:
            queue_validation.append({'id': item.get('id'), 'issues': issues})
    if queue_validation:
        validation.append({'code': 'handoff_queue_validation_failed', 'detail': queue_validation})
    if unexpected_routes:
        validation.append({'code': 'unexpected_residual_routes', 'detail': sorted(set(unexpected_routes))})
    if non_expert_route_items:
        validation.append({'code': 'non_expert_residual_route_owner', 'detail': non_expert_route_items})
    if mutating_route_items:
        validation.append({'code': 'residual_route_mutating_permission_detected', 'detail': mutating_route_items})
    if uncovered_records:
        validation.append({'code': 'route_registry_record_coverage_mismatch', 'detail': uncovered_records})
    if source_report_failures:
        validation.append({'code': 'source_report_failure_for_residual_route', 'detail': source_report_failures[:10]})

    route_counts = Counter(item['route'] for item in route_items)
    status_counts = registry.get('statusCounts') if isinstance(registry.get('statusCounts'), dict) else {}
    router_counts = router.get('counts') if isinstance(router.get('counts'), dict) else {}
    accountant_counts = accountant_pack.get('counts') if isinstance(accountant_pack.get('counts'), dict) else {}
    intake_counts = accountant_intake.get('counts') if isinstance(accountant_intake.get('counts'), dict) else {}
    all_terminal_handoff = responsible_handoff_contract(router_counts, status_counts, router_queue, records)
    if not all_terminal_handoff:
        validation.append({'code': 'router_or_registry_not_terminal_expert_handoff', 'detail': {'routerCounts': router_counts, 'statusCounts': status_counts}})

    counts = {
        'activeApprovalWritten': 0,
        'activeApprovalPathExists': 1 if ACTIVE_APPROVAL.exists() else 0,
        'routerQueue': len(router_queue),
        'coveredRoutes': len(route_items),
        'expectedExpertRoutes': len(EXPECTED_EXPERT_ROUTES),
        'expertRouteActions': sum(1 for action in router_queue if isinstance(action, dict) and action.get('owner') == 'expert_accountant'),
        'agentRouteActions': sum(1 for action in router_queue if isinstance(action, dict) and action.get('owner') in {'agent', 'agent_then_expert_accountant'}),
        'engineeringRouteActions': sum(1 for action in router_queue if isinstance(action, dict) and action.get('owner') == 'engineering'),
        'registryReady': int(status_counts.get('ready_for_autonomous_preflight') or 0),
        'registryExpert': int(status_counts.get('requires_expert_decision') or 0),
        'registryDoctrine': int(status_counts.get('requires_human_doctrine') or 0),
        'registryManualOnly': int(status_counts.get('manual_only') or 0),
        'registryCompletedNoAction': int(status_counts.get('completed_no_action_required') or 0),
        'registryDrift': int(status_counts.get('blocked_by_live_drift') or 0),
        'registryMissingTool': int(status_counts.get('blocked_by_missing_native_tool') or 0),
        'handoffQueue': len(action_queue),
        'sourceReportFailures': len(source_report_failures),
        'uncoveredRecords': len(uncovered_records),
        'unexpectedRoutes': len(set(unexpected_routes)),
        'mutatingRouteItems': len(mutating_route_items),
        'mutationAttempted': 0,
        'nativeMutationAttempted': 0,
        'externalSendAttempted': 0,
        'accountantPackQuestions': int(accountant_counts.get('questions') or 0),
        'accountantResponseActions': int(intake_counts.get('actionQueue') or 0),
        'validationIssues': 0,
    }
    counts['validationIssues'] = len(validation)
    ok = not validation
    payload = {
        'generatedAt': gen,
        'contractVersion': 'standard-v2-inqom-residual-expert-handoff-coverage-entry-corrections',
        'capabilityId': ORIGIN,
        'ok': ok,
        'status': 'expert_handoff_ready' if ok else 'blocked',
        'summary': f"inqom_residual_expert_handoff_coverage: routes={counts['coveredRoutes']}/{counts['expectedExpertRoutes']} handoff_queue={counts['handoffQueue']} expert_actions={counts['expertRouteActions']} agent_actions={counts['agentRouteActions']} engineering={counts['engineeringRouteActions']} ready={counts['registryReady']} drift={counts['registryDrift']} missing_tool={counts['registryMissingTool']} mutation_attempted=0 validation_issues={counts['validationIssues']}",
        'counts': counts,
        'routeCounts': dict(route_counts),
        'blockingReasons': [issue['code'] for issue in validation],
        'mutationPolicy': {
            'inqomMutations': 'blocked',
            'nativeLettering': 'blocked',
            'nativeBankReconciliation': 'blocked',
            'nativeRevisionMarking': 'blocked',
            'taxSubmission': 'blocked',
            'taxPayment': 'blocked',
            'externalSend': 'blocked',
            'approvalFileMayAuthorizeExecution': False,
            'activeApprovalPathExists': ACTIVE_APPROVAL.exists(),
        },
        'expertHandoff': route_items,
        'actionQueue': action_queue,
        'validationIssues': validation,
        'inputReports': {
            'routerJson': str(ROUTER_JSON),
            'routerQueueJson': str(ROUTER_QUEUE_JSON),
            'registryJson': str(REGISTRY_JSON),
            'registryJsonl': str(REGISTRY_JSONL),
            'accountantPackJson': str(ACCOUNTANT_PACK_JSON),
            'accountantIntakeJson': str(ACCOUNTANT_INTAKE_JSON),
        },
        'artifacts': {'reportJson': str(OUT_JSON), 'reportMd': str(OUT_MD), 'queueJson': str(OUT_QUEUE)},
        'updatedBy': ORIGIN + '-v2-entry-corrections',
    }
    write_json(OUT_JSON, payload)
    write_json(OUT_QUEUE, action_queue)

    lines = [
        f'# Inqom residual expert handoff coverage — {gen}',
        '',
        f"- Summary: {payload['summary']}",
        '- Mutations Inqom: **blocked**',
        '- Active approval file: **absent**' if not ACTIVE_APPROVAL.exists() else '- Active approval file: **present — BLOCKER**',
        '',
        '## Routes restantes',
    ]
    for item in sorted(route_items, key=lambda x: x['route']):
        lines.append(f"- **{item['route']}** — {item['recordCount']} record(s), familles {', '.join(item['families'])}: {item['coverage']}")
    if validation:
        lines += ['', '## Validation issues']
        for issue in validation:
            lines.append(f"- {issue.get('code')}: {issue.get('detail')}")
    OUT_MD.write_text('\n'.join(lines) + '\n', encoding='utf-8')
    print(json.dumps({'generatedAt': gen, 'ok': ok, 'summary': payload['summary'], 'blockingReasons': payload['blockingReasons'], 'reportJson': str(OUT_JSON)}, ensure_ascii=False))
    if not ok:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
