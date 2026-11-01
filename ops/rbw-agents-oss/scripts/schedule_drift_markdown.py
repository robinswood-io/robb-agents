from pydantic import JsonValue, TypeAdapter
from schedule_drift_types import BurstWarning, DriftRow


def render_markdown(report: dict[str, JsonValue]) -> str:
    counts = TypeAdapter(dict[str, JsonValue]).validate_python(report['counts'])
    rows = TypeAdapter(list[DriftRow]).validate_python(report['rows'])
    bursts = TypeAdapter(list[BurstWarning]).validate_python(report.get('burstWarnings', []))
    lines = [
        '# Surveillance de dérive des schedules Temporal',
        '',
        f"- Generated at (UTC): **{report['generatedAt']}**",
        f"- Status: **{report['status']}**",
        f"- Summary: **{report['summary']}**",
        f"- Total schedules: **{counts['totalSchedules']}**",
        f"- Drift count: **{counts['driftCount']}**",
        f"- Freshness stale count: **{counts['freshnessStaleCount']}**",
        f"- Admin queue drift count: **{counts['adminQueueDriftCount']}**",
        f"- Critical mail missing count: **{counts['criticalMailMissingCount']}**",
        f"- Burst warning count: **{counts['burstWarningCount']}**",
        f"- Ignored by migration status: **{counts['ignoredByMigrationStatus']}**",
        '',
    ]
    if report['status'] == 'processed':
        lines.append('✅ Aucun drift bloquant détecté sur le périmètre actif.')
        lines.append('')
    else:
        lines.append('⚠️ Drift ou dette opérationnelle détectée.')
        lines.append('')

    active_issues = [
        row for row in rows
        if row.get('includedInChecks') and (row.get('driftReasons') or (row.get('freshness') or {}).get('stale') or row.get('queuePolicyReasons'))
    ]
    if active_issues:
        lines += ['## Écarts actifs', '', '| Schedule ID | Détail |', '|---|---|']
        for row in active_issues:
            reasons = list(row.get('driftReasons', []))
            reasons.extend(row.get('queuePolicyReasons', []))
            freshness = row.get('freshness', {})
            reasons.extend(freshness.get('reasons', []))
            detail = '; '.join(reasons).replace('|', '\\|')
            lines.append(f"| {row['schedule_id']} | {detail} |")
        lines.append('')

    if bursts:
        lines += ['## Warnings de congestion potentielle', '', '| Slot cron | Count | Watchdog | Sample |', '|---|---:|---:|---|']
        for row in bursts[:20]:
            sample = ', '.join(str(x.get('legacy_id') or x.get('schedule_id')) for x in row.get('sample', [])[:8]).replace('|', '\\|')
            lines.append(f"| {row['slot']} | {row['count']} | {row['watchdogCount']} | {sample} |")
        lines.append('')

    ignored = [row for row in rows if not row.get('includedInChecks')]
    if ignored:
        lines += ['## Schedules ignorés volontairement', '', '| Legacy ID | Statut migration |', '|---|---|']
        for row in ignored:
            lines.append(f"| {row['freshness'].get('legacyId') or row['schedule_id']} | {row.get('migrationStatus')} |")
        lines.append('')

    return '\n'.join(lines)
