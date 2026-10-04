#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import re
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from action_queue_contract import normalize_action_list, validate_action_item

ROOT = Path('/srv/rbw-agents-oss')
CONFIG = ROOT / 'config'
WS = Path('/home/craft/.craft-agent/workspaces/my-workspace-2')
OPS = WS / 'campaigns' / 'ops'
WORKBENCH_JSON = OPS / 'inqom-quality-autonomy-workbench.json'
POLICY_JSON = CONFIG / 'finance-inqom-human-replicated-lettering-policy.json'
THIRD_PARTY_EVIDENCE_JSON = CONFIG / 'finance-inqom-third-party-evidence.json'
OUT_JSON = OPS / 'inqom-lettering-autonomy-batcher.json'
OUT_MD = OPS / 'inqom-lettering-autonomy-batcher.md'
QUEUE_JSON = OPS / 'inqom-lettering-autonomy-batcher-queue.json'
EXEC_QUEUE_JSON = OPS / 'inqom-human-replicated-lettering-executable-queue.json'
ORIGIN = 'inqom-lettering-autonomy-batcher'


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


def read_json(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except Exception:
        return default


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def stable_hash(obj: Any) -> str:
    raw = json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
    return hashlib.sha1(raw.encode('utf-8')).hexdigest()[:16]


def set_digest(values: list[str]) -> str:
    raw = json.dumps(sorted(values), ensure_ascii=False, separators=(',', ':'))
    return hashlib.sha256(raw.encode('utf-8')).hexdigest()


def line_fingerprint(line: dict[str, Any]) -> str:
    return stable_hash({k: line.get(k) for k in ('date', 'account', 'label', 'amount', 'docRef', 'entryId', 'lineId')})


def candidate_identity(candidate: dict[str, Any]) -> str:
    line_ids: list[int] = []
    for side in ('positive', 'negative'):
        try:
            line_ids.append(int((candidate.get(side) or {}).get('lineId')))
        except Exception:
            pass
    if len(line_ids) == 2:
        return '|'.join(str(value) for value in sorted(line_ids))
    return 'fallback:' + stable_hash({
        'thirdPartyKey': candidate.get('thirdPartyKey'),
        'positive': line_fingerprint(candidate.get('positive') or {}),
        'negative': line_fingerprint(candidate.get('negative') or {}),
    })


def amount_abs(candidate: dict[str, Any]) -> float:
    try:
        return abs(float((candidate.get('positive') or {}).get('amount') or (candidate.get('negative') or {}).get('amount') or 0))
    except Exception:
        return 0.0


def reference_token(line: dict[str, Any]) -> str:
    raw = f"{line.get('docRef') or ''} {line.get('label') or ''}".upper()
    patterns = [r'\bF[- ]?\d{4,}[- ]?\d*\b', r'\bFACT[- ]?\d{4,}[- ]?\d*\b', r'\bF\d{8,}\b', r'\bFC[- ]?\d{3,}\b', r'\bFA[- ]?\d{3,}\b', r'\bBQ\d{6,}\b', r'\bPAY[-_A-Z0-9]{6,}\b']
    for pattern in patterns:
        m = re.search(pattern, raw)
        if m:
            return re.sub(r'\s+', '', m.group(0))
    return ''


def line_identifier(line: dict[str, Any]) -> dict[str, Any]:
    return {
        'entryId': line.get('entryId') or line.get('EntryId'),
        'lineId': line.get('lineId') or line.get('LineId'),
        'docRef': line.get('docRef'),
        'date': line.get('date'),
        'amount': line.get('amount'),
    }


def has_identifier(line: dict[str, Any]) -> bool:
    ident = line_identifier(line)
    return bool(ident.get('entryId') or ident.get('lineId'))


def norm_list(values: Any) -> list[str]:
    return [str(x).upper() for x in (values or [])]


def model_matches(candidate: dict[str, Any], kind: str, policy: dict[str, Any], model_key: str, status: str) -> tuple[bool, str | None, list[str]]:
    reasons: list[str] = []
    third = str(candidate.get('thirdPartyKey') or '').upper()
    amount = round(amount_abs(candidate), 2)
    shared_token = str(candidate.get('sharedReferenceToken') or '').strip()
    for model in policy.get(model_key) or []:
        model_id = str(model.get('modelId') or model.get('ruleId') or '')
        if str(model.get('status') or '') != status:
            continue
        if model.get('referenceTokenRequired') and not shared_token:
            reasons.append(f'{model_id}:missing_shared_reference_token')
            continue
        contains = norm_list(model.get('thirdPartyKeyContainsAny'))
        if contains and not any(x in third for x in contains):
            reasons.append(f'{model_id}:third_party_contains_no_match')
            continue
        prefixes = norm_list(model.get('thirdPartyKeyPrefixAny'))
        if prefixes and not any(third.startswith(x) for x in prefixes):
            reasons.append(f'{model_id}:third_party_prefix_no_match')
            continue
        amounts = model.get('amountAbsAny') or []
        if amounts and not any(abs(float(x) - amount) <= 0.01 for x in amounts):
            reasons.append(f'{model_id}:amount_no_match')
            continue
        account_type = str(model.get('accountType') or '')
        if account_type == 'supplier' and kind != 'supplier':
            reasons.append(f'{model_id}:kind_not_supplier')
            continue
        if account_type == 'client' and kind != 'client':
            reasons.append(f'{model_id}:kind_not_client')
            continue
        trusted_sources = norm_list(model.get('trustedSourceAny'))
        if trusted_sources:
            psrc = str((candidate.get('positive') or {}).get('source') or (candidate.get('positive') or {}).get('sourceType') or '').upper()
            nsrc = str((candidate.get('negative') or {}).get('source') or (candidate.get('negative') or {}).get('sourceType') or '').upper()
            if not any(x in psrc or x in nsrc for x in trusted_sources):
                reasons.append(f'{model_id}:trusted_source_no_match')
                continue
        return True, model_id, []
    return False, None, reasons[:8]


def public_evidence_for(candidate: dict[str, Any], evidence: dict[str, Any]) -> dict[str, Any] | None:
    third = str(candidate.get('thirdPartyKey') or '').upper()
    public = evidence.get('publicEvidenceByThirdParty') or {}
    row = public.get(third) or public.get(third.lower())
    if isinstance(row, dict) and str(row.get('status') or 'active') in {'active', 'verified'}:
        return row
    return None


def evidence_rule_matches(candidate: dict[str, Any], evidence: dict[str, Any]) -> list[dict[str, Any]]:
    third = str(candidate.get('thirdPartyKey') or '').upper()
    amount = round(amount_abs(candidate), 2)
    out: list[dict[str, Any]] = []
    for rule in evidence.get('rules') or []:
        if str(rule.get('status') or '') != 'active':
            continue
        contains = norm_list(rule.get('thirdPartyKeyContainsAny'))
        if contains and not any(x in third for x in contains):
            continue
        amounts = rule.get('amountAbsAny') or []
        if amounts and not any(abs(float(x) - amount) <= 0.01 for x in amounts):
            continue
        if rule.get('referenceTokenRequired') and not candidate.get('sharedReferenceToken'):
            continue
        out.append(rule)
    return out


def base_checks(candidate: dict[str, Any], pos_counts: Counter, neg_counts: Counter) -> dict[str, Any]:
    p = candidate.get('positive') or {}
    n = candidate.get('negative') or {}
    pfp = line_fingerprint(p)
    nfp = line_fingerprint(n)
    try:
        residual = abs(float(candidate.get('residual') or 0))
    except Exception:
        residual = 999999.0
    positive_token = str(candidate.get('positiveReferenceToken') or reference_token(p))
    negative_token = str(candidate.get('negativeReferenceToken') or reference_token(n))
    shared_token = str(candidate.get('sharedReferenceToken') or (positive_token if positive_token and positive_token == negative_token else ''))
    return {
        'positive': p,
        'negative': n,
        'positiveFingerprint': pfp,
        'negativeFingerprint': nfp,
        'positiveReferenceToken': positive_token,
        'negativeReferenceToken': negative_token,
        'sharedReferenceToken': shared_token,
        'checks': {
            'pairExactOffset': candidate.get('type') == 'pair_exact_offset',
            'residualOk': residual <= 0.01,
            'uniquePositiveFingerprint': pos_counts[pfp] == 1,
            'uniqueNegativeFingerprint': neg_counts[nfp] == 1,
            'hasPositiveIdentifier': has_identifier(p),
            'hasNegativeIdentifier': has_identifier(n),
            'hasSharedReferenceToken': bool(shared_token),
        },
        'residualAbs': residual,
    }


def replica_eligibility(candidate: dict[str, Any], kind: str, pos_counts: Counter, neg_counts: Counter, policy: dict[str, Any]) -> dict[str, Any]:
    base = base_checks(candidate, pos_counts, neg_counts)
    tmp = {**candidate, 'sharedReferenceToken': base['sharedReferenceToken']}
    model_ok, model_id, model_reasons = model_matches(tmp, kind, policy, 'humanReplicaModels', 'authorized_replica')
    checks = dict(base['checks'])
    checks['authorizedHumanReplicaModel'] = model_ok
    eligible = all(checks.values())
    reasons = [k for k, ok in checks.items() if not ok] + model_reasons
    return {
        'eligible': eligible,
        'modelId': model_id,
        'checks': checks,
        'reasons': reasons,
        'positiveReferenceToken': base['positiveReferenceToken'],
        'negativeReferenceToken': base['negativeReferenceToken'],
        'sharedReferenceToken': base['sharedReferenceToken'],
        'positiveFingerprint': base['positiveFingerprint'],
        'negativeFingerprint': base['negativeFingerprint'],
    }


def confidence_assessment(candidate: dict[str, Any], kind: str, pos_counts: Counter, neg_counts: Counter, policy: dict[str, Any], evidence: dict[str, Any], replica: dict[str, Any]) -> dict[str, Any]:
    base = base_checks(candidate, pos_counts, neg_counts)
    tmp = {**candidate, 'sharedReferenceToken': base['sharedReferenceToken']}
    rule_ok, rule_id, rule_reasons = model_matches(tmp, kind, policy, 'highConfidenceRuleModels', 'authorized_high_confidence_rule')
    public_row = public_evidence_for(tmp, evidence)
    evidence_rules = evidence_rule_matches(tmp, evidence)
    p = candidate.get('positive') or {}
    n = candidate.get('negative') or {}
    revised_or_trusted = any(str(x.get('revision') or '').lower() == 'revised' for x in (p, n)) or any(str(x.get('source') or '').lower() in {'publicapi', 'bank', 'qonto', 'sellsy', 'gocardless', 'stripe'} for x in (p, n))
    amount_only_recurring = kind == 'supplier' and not base['sharedReferenceToken'] and amount_abs(candidate) in {75.0, 199.0, 253.25, 606.0}
    components: list[dict[str, Any]] = []
    score = 0.0

    def add(name: str, value: float, evidence_ref: str) -> None:
        nonlocal score
        if value > 0:
            components.append({'component': name, 'score': round(value, 4), 'evidence': evidence_ref})
            score += value

    if base['checks']['pairExactOffset'] and base['checks']['residualOk'] and base['checks']['uniquePositiveFingerprint'] and base['checks']['uniqueNegativeFingerprint']:
        add('exactOneToOneOffset', 0.30, 'exact offset, residual <= 0.01, unique fingerprints')
    if base['checks']['hasPositiveIdentifier'] and base['checks']['hasNegativeIdentifier']:
        add('stableMutationIdentifiers', 0.15, 'entryId/lineId present on both sides')
    if base['sharedReferenceToken']:
        add('sharedInvoiceOrPaymentReferenceToken', 0.25, base['sharedReferenceToken'])
    if revised_or_trusted:
        add('revisedOrTrustedSourceEvidence', 0.05, 'Revised status or trusted source')
    if replica.get('eligible'):
        add('authorizedHumanReplicaModel', 0.15, str(replica.get('modelId')))
    elif replica.get('modelId'):
        add('authorizedHumanReplicaModel', 0.10, str(replica.get('modelId')))
    if rule_ok:
        add('authorizedRuleBaseModel', 0.15, str(rule_id))
    elif evidence_rules:
        add('authorizedRuleBaseModel', max(float(r.get('confidenceBoost') or 0.0) for r in evidence_rules), ','.join(str(r.get('ruleId')) for r in evidence_rules))
    if public_row:
        add('publicThirdPartyEvidence', min(float(public_row.get('confidenceBoost') or 0.05), 0.05), str(public_row.get('sourceUrlOrInternalRule') or public_row.get('summary') or 'publicEvidence'))
    # conservative cadence signal: same reference + same recurring amount rule evidence
    if evidence_rules and base['sharedReferenceToken']:
        add('recurringCadenceEvidence', 0.05, 'rule/evidence recurring cadence with reference token')

    # Caps / hard scoring limits.
    caps: list[str] = []
    if not base['sharedReferenceToken']:
        score = min(score, 0.74); caps.append('noSharedReferenceTokenMaxScore')
    if not (base['checks']['hasPositiveIdentifier'] and base['checks']['hasNegativeIdentifier']):
        score = 0.0; caps.append('missingIdentifiersMaxScore')
    if not (base['checks']['uniquePositiveFingerprint'] and base['checks']['uniqueNegativeFingerprint']):
        score = min(score, 0.79); caps.append('competingFingerprintMaxScore')
    if amount_only_recurring:
        score = min(score, 0.79); caps.append('amountOnlyRecurringSupplierMaxScore')

    threshold = float(policy.get('confidenceThreshold') or 0.90)
    evidence_requirements = ((policy.get('confidenceCriteria') or {}).get('evidenceRequirements') or {})
    minimum_evidence_sources = int(evidence_requirements.get('minimumEvidenceSourcesForHighConfidence') or 2)
    allowed_anchor_sources = set(evidence_requirements.get('oneEvidenceSourceMustBe') or ['authorizedRuleBaseModel', 'authorizedHumanReplicaModel', 'publicThirdPartyEvidence'])
    evidence_sources = {c['component'] for c in components if c['component'] in {'authorizedHumanReplicaModel', 'authorizedRuleBaseModel', 'publicThirdPartyEvidence', 'sharedInvoiceOrPaymentReferenceToken', 'recurringCadenceEvidence'}}
    required_anchor = bool(allowed_anchor_sources & evidence_sources)
    enough_independent_evidence = len(evidence_sources) >= minimum_evidence_sources
    eligible = bool(score >= threshold and all(base['checks'][k] for k in ('pairExactOffset', 'residualOk', 'uniquePositiveFingerprint', 'uniqueNegativeFingerprint', 'hasPositiveIdentifier', 'hasNegativeIdentifier')) and required_anchor and enough_independent_evidence)
    reasons = []
    if score < threshold: reasons.append('confidence_below_threshold')
    if not enough_independent_evidence: reasons.append('insufficient_independent_evidence_sources')
    if not required_anchor: reasons.append('missing_required_history_rule_or_public_evidence')
    reasons += [k for k, ok in base['checks'].items() if k != 'hasSharedReferenceToken' and not ok]
    reasons += rule_reasons[:4]
    reasons += caps
    return {
        'eligible': eligible,
        'score': round(min(score, 1.0), 4),
        'threshold': threshold,
        'components': components,
        'evidenceSources': sorted(evidence_sources),
        'evidenceSourceCount': len(evidence_sources),
        'minimumEvidenceSources': minimum_evidence_sources,
        'evidenceSourceRequirementMet': enough_independent_evidence,
        'requiredAnchorSourceMet': required_anchor,
        'ruleId': rule_id,
        'publicEvidence': public_row,
        'evidenceRuleIds': [r.get('ruleId') for r in evidence_rules],
        'checks': base['checks'],
        'reasons': reasons,
        'capsApplied': caps,
        'positiveReferenceToken': base['positiveReferenceToken'],
        'negativeReferenceToken': base['negativeReferenceToken'],
        'sharedReferenceToken': base['sharedReferenceToken'],
    }


def batch(kind: str, candidates: list[dict[str, Any]], policy: dict[str, Any], evidence: dict[str, Any]) -> dict[str, Any]:
    pos_counts = Counter(line_fingerprint(c.get('positive') or {}) for c in candidates)
    neg_counts = Counter(line_fingerprint(c.get('negative') or {}) for c in candidates)
    safe: list[dict[str, Any]] = []
    human_executable: list[dict[str, Any]] = []
    confidence_executable: list[dict[str, Any]] = []
    ambiguous: list[dict[str, Any]] = []
    by_third: dict[str, dict[str, Any]] = defaultdict(lambda: {
        'candidateCount': 0,
        'safeOneToOne': 0,
        'humanReplicatedExecutable': 0,
        'highConfidenceExecutable': 0,
        'ambiguous': 0,
        'amountAbs': 0.0,
        'sample': [],
    })
    for c in candidates:
        pfp = line_fingerprint(c.get('positive') or {})
        nfp = line_fingerprint(c.get('negative') or {})
        third = str(c.get('thirdPartyKey') or 'unknown')
        try:
            residual = abs(float(c.get('residual') or 0))
        except Exception:
            residual = 999999.0
        is_exact = residual <= 0.01 and c.get('type') == 'pair_exact_offset'
        base_safe = is_exact and pos_counts[pfp] == 1 and neg_counts[nfp] == 1
        replica = replica_eligibility(c, kind, pos_counts, neg_counts, policy) if base_safe else {'eligible': False, 'reasons': ['not_safe_one_to_one']}
        confidence = confidence_assessment(c, kind, pos_counts, neg_counts, policy, evidence, replica) if base_safe else {'eligible': False, 'score': 0.0, 'reasons': ['not_safe_one_to_one']}
        if replica.get('eligible'):
            classification = 'human_replicated_executable'
        elif confidence.get('eligible'):
            classification = 'high_confidence_executable'
        elif base_safe:
            classification = 'safe_one_to_one_readonly'
        else:
            classification = 'ambiguous_many_to_many'
        executable = classification in {'human_replicated_executable', 'high_confidence_executable'}
        item = {
            **c,
            'classification': classification,
            'positiveFingerprint': pfp,
            'negativeFingerprint': nfp,
            'positiveReferenceToken': replica.get('positiveReferenceToken') or confidence.get('positiveReferenceToken') or c.get('positiveReferenceToken'),
            'negativeReferenceToken': replica.get('negativeReferenceToken') or confidence.get('negativeReferenceToken') or c.get('negativeReferenceToken'),
            'sharedReferenceToken': replica.get('sharedReferenceToken') or confidence.get('sharedReferenceToken') or c.get('sharedReferenceToken'),
            'humanReplicaModelId': replica.get('modelId'),
            'humanReplicaChecks': replica.get('checks'),
            'humanReplicaBlockReasons': replica.get('reasons'),
            'confidenceScore': confidence.get('score'),
            'confidenceThreshold': confidence.get('threshold'),
            'confidenceComponents': confidence.get('components'),
            'confidenceRuleId': confidence.get('ruleId'),
            'confidenceEvidenceRuleIds': confidence.get('evidenceRuleIds'),
            'confidencePublicEvidence': confidence.get('publicEvidence'),
            'confidenceChecks': confidence.get('checks'),
            'confidenceBlockReasons': confidence.get('reasons'),
            'mutationAllowed': executable,
            'mutationType': 'native_lettering' if executable else None,
        }
        if classification == 'human_replicated_executable':
            human_executable.append(item)
        elif classification == 'high_confidence_executable':
            confidence_executable.append(item)
        elif classification == 'safe_one_to_one_readonly':
            safe.append(item)
        else:
            ambiguous.append(item)
        b = by_third[third]
        b['candidateCount'] += 1
        b['amountAbs'] += amount_abs(c)
        b['safeOneToOne'] += 1 if base_safe else 0
        b['humanReplicatedExecutable'] += 1 if classification == 'human_replicated_executable' else 0
        b['highConfidenceExecutable'] += 1 if classification == 'high_confidence_executable' else 0
        b['ambiguous'] += 1 if classification == 'ambiguous_many_to_many' else 0
        if len(b['sample']) < 15:
            b['sample'].append(item)
    third_rows = []
    for third, payload in by_third.items():
        payload['thirdPartyKey'] = third
        payload['amountAbs'] = round(float(payload.get('amountAbs') or 0), 2)
        third_rows.append(dict(payload))
    third_rows.sort(key=lambda x: (-int(x.get('humanReplicatedExecutable') or 0), -int(x.get('highConfidenceExecutable') or 0), -int(x.get('ambiguous') or 0), -float(x.get('amountAbs') or 0), str(x.get('thirdPartyKey'))))
    return {
        'kind': kind,
        'candidateCount': len(candidates),
        'safeOneToOneReadOnlyCount': len(safe),
        'humanReplicatedExecutableCount': len(human_executable),
        'highConfidenceExecutableCount': len(confidence_executable),
        'ambiguousCount': len(ambiguous),
        'safeOneToOneReadOnly': safe[:200],
        'humanReplicatedExecutable': human_executable[:200],
        'highConfidenceExecutable': confidence_executable[:200],
        'ambiguous': ambiguous[:200],
        'byThirdParty': third_rows,
    }


def build_action_queues(client: dict[str, Any], supplier: dict[str, Any], policy: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    actions: list[dict[str, Any]] = []
    executable_actions: list[dict[str, Any]] = []
    allowed_exec = set((policy.get('executionPolicy') or {}).get('allowedExecutionClasses') or ['human_replicated_executable', 'high_confidence_executable'])
    for pack in (client, supplier):
        kind = pack['kind']
        specs = [
            ('human_replicated_executable', pack['humanReplicatedExecutableCount'], 'execute_human_replicated_native_lettering', 'human_replicated_lettering_ready', 'high', pack['humanReplicatedExecutable']),
            ('high_confidence_executable', pack['highConfidenceExecutableCount'], 'execute_high_confidence_native_lettering', 'high_confidence_lettering_ready', 'high', pack['highConfidenceExecutable']),
            ('safe_one_to_one_readonly', pack['safeOneToOneReadOnlyCount'], 'prepare_readonly_lettering_safe_batch', 'lettering_candidates_safe_readonly', 'medium', pack['safeOneToOneReadOnly']),
            ('ambiguous_many_to_many', pack['ambiguousCount'], 'prepare_readonly_lettering_ambiguous_review', 'lettering_candidates_ambiguous', 'high', pack['ambiguous']),
        ]
        for classification, count, action_type, reason, priority, rows in specs:
            if not count:
                continue
            executable = classification in allowed_exec
            canonical_rows = rows if executable else []
            canonical_keys = [candidate_identity(row) for row in canonical_rows]
            data = {
                'kind': kind,
                'classification': classification,
                'count': count,
                'byThirdParty': pack['byThirdParty'][:50],
                'candidateSample': rows[:50],
                'canonicalCandidates': canonical_rows,
                'canonicalCandidateKeys': canonical_keys,
                'canonicalCandidateCount': len(canonical_rows),
                'canonicalCandidateSetDigest': set_digest(canonical_keys),
                'blockedEffects': [] if executable else ['native_lettering', 'inqom_update', 'mark_revised'],
                'allowedEffects': ['native_lettering'] if executable else ['writes_reports', 'writes_action_queue', 'prepare_readonly_batch'],
                'requiresEnv': (policy.get('executionPolicy') or {}).get('requiresMutationEnv') if executable else None,
                'confidenceThreshold': policy.get('confidenceThreshold'),
            }
            action = {
                'owner': 'agent',
                'actionType': action_type,
                'priority': priority,
                'actionableNow': True,
                'target': f'quality:411-401-lettering:{kind}:{classification}',
                'blockingReason': reason,
                'doneCondition': 'Les lots de lettrage exécutables sont exécutés uniquement si endpoint natif disponible, env autorisation présent, et classe autorisée (human_replicated ou confidence >=90%); les autres restent en lecture seule.',
                'title': f'Lettrage {kind} — {classification}',
                'summary': f'{count} candidats {kind} / {classification}',
                'data': data,
                'dedupeKey': f'{ORIGIN}:{kind}:{classification}:{count}:{set_digest(canonical_keys) if executable else stable_hash(rows[:50])}',
            }
            actions.append(action)
            if executable:
                executable_actions.append(action)
    return normalize_action_list(actions, origin_automation=ORIGIN), normalize_action_list(executable_actions, origin_automation=ORIGIN)


def main() -> None:
    generated_at = now_iso()
    workbench = read_json(WORKBENCH_JSON, {})
    policy = read_json(POLICY_JSON, {})
    evidence = read_json(THIRD_PARTY_EVIDENCE_JSON, {})
    raw = workbench.get('rawOutputs') or {}
    client = batch('client', (raw.get('clientLettering') or {}).get('candidates') or [], policy, evidence)
    supplier = batch('supplier', (raw.get('supplierLettering') or {}).get('candidates') or [], policy, evidence)
    queue, executable_queue = build_action_queues(client, supplier, policy)
    validation = []
    for item in queue:
        issues = validate_action_item(item)
        if issues:
            validation.append({'id': item.get('id'), 'issues': issues})
    counts = {
        'clientCandidates': client['candidateCount'],
        'supplierCandidates': supplier['candidateCount'],
        'humanReplicatedExecutable': client['humanReplicatedExecutableCount'] + supplier['humanReplicatedExecutableCount'],
        'highConfidenceExecutable': client['highConfidenceExecutableCount'] + supplier['highConfidenceExecutableCount'],
        'safeOneToOneReadOnly': client['safeOneToOneReadOnlyCount'] + supplier['safeOneToOneReadOnlyCount'],
        'safeOneToOne': client['safeOneToOneReadOnlyCount'] + supplier['safeOneToOneReadOnlyCount'],
        'ambiguous': client['ambiguousCount'] + supplier['ambiguousCount'],
        'queue': len(queue),
        'executableQueue': len(executable_queue),
        'validationIssues': len(validation),
    }
    payload = {
        'generatedAt': generated_at,
        'contractVersion': 'standard-v3-confidence-lettering',
        'capabilityId': ORIGIN,
        'ok': not validation,
        'status': 'processed' if not validation else 'partial',
        'summary': f"inqom_lettering_batcher: client={client['candidateCount']} supplier={supplier['candidateCount']} human_replicated={counts['humanReplicatedExecutable']} high_confidence={counts['highConfidenceExecutable']} safe_readonly={counts['safeOneToOneReadOnly']} ambiguous={counts['ambiguous']} queue={len(queue)} validation_issues={len(validation)}",
        'counts': counts,
        'blockingReasons': ['queue_contract_validation_failed'] if validation else [],
        'mutationPolicy': {
            'inqomMutations': 'conditionally_allowed',
            'nativeLettering': 'allowed_for_human_replicated_or_confidence_score_gte_90_only',
            'confidenceThreshold': policy.get('confidenceThreshold'),
            'requiresEnv': (policy.get('executionPolicy') or {}).get('requiresMutationEnv'),
            'policyPath': str(POLICY_JSON),
            'thirdPartyEvidencePath': str(THIRD_PARTY_EVIDENCE_JSON),
        },
        'client': client,
        'supplier': supplier,
        'queue': queue,
        'executableQueue': executable_queue,
        'validationIssues': validation,
        'artifacts': {
            'reportJson': str(OUT_JSON),
            'reportMd': str(OUT_MD),
            'queueJson': str(QUEUE_JSON),
            'executableQueueJson': str(EXEC_QUEUE_JSON),
            'workbenchJson': str(WORKBENCH_JSON),
            'policyJson': str(POLICY_JSON),
            'thirdPartyEvidenceJson': str(THIRD_PARTY_EVIDENCE_JSON),
        },
        'updatedBy': ORIGIN,
    }
    write_json(OUT_JSON, payload)
    write_json(QUEUE_JSON, queue)
    write_json(EXEC_QUEUE_JSON, executable_queue)
    lines = [
        f'# Inqom lettering autonomy batcher — {generated_at}',
        '',
        f"- Summary: {payload['summary']}",
        f"- Native lettering: **{payload['mutationPolicy']['nativeLettering']}**",
        f"- Requires env: `{payload['mutationPolicy']['requiresEnv']}`",
        f"- Confidence threshold: `{payload['mutationPolicy']['confidenceThreshold']}`",
        '',
        f"- Client: human={client['humanReplicatedExecutableCount']} high_confidence={client['highConfidenceExecutableCount']} safe_readonly={client['safeOneToOneReadOnlyCount']} ambiguous={client['ambiguousCount']}",
        f"- Supplier: human={supplier['humanReplicatedExecutableCount']} high_confidence={supplier['highConfidenceExecutableCount']} safe_readonly={supplier['safeOneToOneReadOnlyCount']} ambiguous={supplier['ambiguousCount']}",
    ]
    OUT_MD.write_text('\n'.join(lines) + '\n', encoding='utf-8')
    print(json.dumps({'generatedAt': generated_at, 'ok': payload['ok'], 'summary': payload['summary'], 'executableQueue': len(executable_queue), 'reportJson': str(OUT_JSON)}, ensure_ascii=False))
    if validation:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
