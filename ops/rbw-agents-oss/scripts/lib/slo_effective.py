from __future__ import annotations

GOVERNANCE_TARGETS = {'oss-agent-control-plane', 'oss-industrialization-dashboard'}
CONTROL_PLANE_ALLOWED_REASONS = {'wrapper_failure_rate_warn', 'wrapper_failure_rate_breach', 'current:canaryPlanner', 'current:canaryOutcome'}
DASHBOARD_ALLOWED_REASONS = {
    'wrapper_failure_rate_breach',
    'current:agent_control_plane_blocked',
    'current:canary_remediation_planner_invalid',
    'current:canary_outcome_regressions',
}
GOVERNANCE_BLOCKERS = {
    'agent_control_plane_blocked',
    'canary_remediation_planner_invalid',
    'canary_outcome_regressions',
    'canaryPlanner',
    'canaryOutcome',
}

def _counts(report):
    return report.get('counts') if isinstance(report, dict) and isinstance(report.get('counts'), dict) else {}

def _int(value, default=0):
    try:
        return int(value or default)
    except Exception:
        return int(default)

def _reasons(item):
    return [str(r) for r in (item.get('reasons') or [])]

def _current_blockers(item):
    metrics = item.get('metrics') if isinstance(item.get('metrics'), dict) else {}
    health = metrics.get('currentHealth') if isinstance(metrics.get('currentHealth'), dict) else {}
    return [str(r) for r in (health.get('blockingReasons') or [])]

def is_governance_self_cycle_item(item):
    """True only for P7 governance deadlock SLO items.

    This deliberately does *not* ignore business, finance, domain, mail, or external
    provider SLO issues. It only breaks the self-referential chain where canary
    wrappers block because SLO has actions, while SLO actions exist only because
    canary/control-plane/dashboard wrappers block on that same condition.
    """
    if not isinstance(item, dict):
        return False
    target = item.get('target')
    reasons = set(_reasons(item))
    blockers = set(_current_blockers(item))
    metrics = item.get('metrics') if isinstance(item.get('metrics'), dict) else {}
    health = metrics.get('currentHealth') if isinstance(metrics.get('currentHealth'), dict) else {}

    if target == 'oss-agent-control-plane':
        if health.get('ok') is True and not blockers:
            return True
        return bool(reasons) and reasons.issubset(CONTROL_PLANE_ALLOWED_REASONS) and blockers.issubset(GOVERNANCE_BLOCKERS)

    if target == 'oss-industrialization-dashboard':
        return bool(reasons) and reasons.issubset(DASHBOARD_ALLOWED_REASONS) and blockers.issubset(GOVERNANCE_BLOCKERS)

    return False

def is_recovered_watch_item(item):
    """True for non-blocking SLO actions already recovered by current artifact.

    These items must remain visible as watch/action queue evidence, but they should
    not block canary planning, dashboard refresh, or release gate. This is distinct
    from governance self-cycle ignores: it only applies when SLO itself has already
    demoted the item to non-blocking and the latest health artifact is ok/recovered.
    """
    if not isinstance(item, dict):
        return False
    if str(item.get('severity') or '').lower() == 'blocking':
        return False
    metrics = item.get('metrics') if isinstance(item.get('metrics'), dict) else {}
    health = metrics.get('currentHealth') if isinstance(metrics.get('currentHealth'), dict) else {}
    return bool(metrics.get('recoveredByCurrentArtifact') is True or health.get('ok') is True)

def effective_slo_state(slo_report, action_queue):
    sc = _counts(slo_report)
    raw = _int(sc.get('actions') or len(slo_report.get('actions') or []))
    raw_blocking = _int(sc.get('blockingIssues'))
    items = action_queue.get('items') if isinstance(action_queue, dict) and isinstance(action_queue.get('items'), list) else []
    governance_ignored = [i for i in items if is_governance_self_cycle_item(i)]
    recovered_watch_ignored = [i for i in items if not is_governance_self_cycle_item(i) and is_recovered_watch_item(i)]
    ignored = governance_ignored + recovered_watch_ignored
    effective_items = [i for i in items if not is_governance_self_cycle_item(i) and not is_recovered_watch_item(i)]
    effective = len(effective_items) if items else raw
    effective_blocking = sum(1 for i in effective_items if str(i.get('severity') or '').lower() == 'blocking') if items else raw_blocking
    return {
        'rawActions': raw,
        'effectiveActions': effective,
        'rawBlockingIssues': raw_blocking,
        'effectiveBlockingIssues': effective_blocking,
        'ignoredGovernanceSelfCycleActions': len(governance_ignored),
        'ignoredRecoveredWatchActions': len(recovered_watch_ignored),
        'queueItems': len(items),
        'ignoredTargets': [i.get('target') for i in ignored],
        'ignoredGovernanceTargets': [i.get('target') for i in governance_ignored],
        'ignoredRecoveredWatchTargets': [i.get('target') for i in recovered_watch_ignored],
        'effectiveTargets': [i.get('target') for i in effective_items],
    }
