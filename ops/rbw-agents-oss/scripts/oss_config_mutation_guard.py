#!/usr/bin/env python3
from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from lib.wrapper_sdk import now_iso, write_report

ROOT = Path('/srv/rbw-agents-oss')
CONFIG = ROOT / 'config'
SCRIPTS = ROOT / 'scripts'
POLICY = CONFIG / 'registry/config-mutation-policy.json'
SLUG = 'oss-config-mutation-guard'

PROTECTED_BASENAMES = {
    'command-manifest.json', 'automation-mapping.json', 'schedules.json', 'ready-schedules.json',
    'event-triggers.json', 'manifest-only-policy.json', 'script-coverage-policy.json',
    'schedule-readiness-policy.json', 'side-effects-policy.json', 'runtime-status-policy.json',
    'config-mutation-policy.json', 'report-contract-coverage-policy.json', 'temporal-execution-slo-policy.json',
}
WRITE_PATTERNS = [
    re.compile(r'write_text\s*\('),
    re.compile(r'write_bytes\s*\('),
    re.compile(r'json\.dump\s*\('),
    re.compile(r'open\s*\([^\n]*(?:["\']w|["\']a|["\']x)'),
    re.compile(r'shutil\.copy2\s*\('),
    re.compile(r'with_suffix\s*\([^\n]*bak'),
]


def load_json(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except Exception:
        return default


def is_active_backup(path: Path) -> bool:
    if not path.is_file() or '/archive/' in path.as_posix():
        return False
    name = path.name
    return '.bak' in name or name.endswith('~') or name.endswith('.old')


def rel(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def scan_active_backups() -> list[str]:
    roots = [CONFIG, SCRIPTS, ROOT / 'apps/orchestrator-temporal']
    out: list[str] = []
    for root in roots:
        if root.exists():
            out.extend(rel(p) for p in root.rglob('*') if is_active_backup(p))
    return sorted(set(out))


def script_text(path: Path) -> str:
    try:
        return path.read_text(encoding='utf-8', errors='ignore')
    except Exception:
        return ''


def scan_config_writers() -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []
    for path in sorted(SCRIPTS.rglob('*.py')):
        if '/archive/' in path.as_posix() or '/__pycache__/' in path.as_posix():
            continue
        r = rel(path)
        if r in {'scripts/lib/config_mutation.py', 'scripts/oss_config_mutation_guard.py'}:
            continue
        text = script_text(path)
        touched = sorted([name for name in PROTECTED_BASENAMES if name in text])
        if not touched:
            continue
        write_hits = sorted({pat.pattern for pat in WRITE_PATTERNS if pat.search(text)})
        if not write_hits:
            continue
        uses_helper = 'lib.config_mutation' in text or 'from config_mutation' in text or 'ConfigMutation' in text
        candidates.append({'path': r, 'protectedNames': touched[:20], 'writePatterns': write_hits, 'usesConfigMutationHelper': uses_helper})
    return candidates


def main() -> dict[str, Any]:
    policy = load_json(POLICY, {})
    accepted = set(policy.get('acceptedLegacyConfigWriters', [])) if isinstance(policy, dict) else set()
    accepted_read_only = set(policy.get('acceptedReadOnlyProtectedConfigConsumers', [])) if isinstance(policy, dict) else set()
    accepted_backups = set(policy.get('acceptedLegacyBackupPatternScripts', [])) if isinstance(policy, dict) else set()
    active_backups = scan_active_backups()
    writers = scan_config_writers()
    unclassified = [
        w for w in writers
        if not w.get('usesConfigMutationHelper')
        and w['path'] not in accepted
        and w['path'] not in accepted_read_only
    ]
    helper_missing = not (SCRIPTS / 'lib/config_mutation.py').exists()
    errors: list[dict[str, Any]] = []
    warnings: list[dict[str, Any]] = []
    if helper_missing:
        errors.append({'code': 'config_mutation_helper_missing', 'path': 'scripts/lib/config_mutation.py'})
    if active_backups:
        errors.append({'code': 'active_backup_files', 'count': len(active_backups), 'sample': active_backups[:50]})
    if unclassified:
        errors.append({'code': 'unclassified_config_writers', 'count': len(unclassified), 'sample': unclassified[:30]})
    accepted_legacy = [w for w in writers if w['path'] in accepted]
    read_only_consumers = [w for w in writers if w['path'] in accepted_read_only]
    if accepted_legacy:
        warnings.append({'code': 'accepted_legacy_config_writers', 'count': len(accepted_legacy), 'sample': accepted_legacy[:20]})
    helper_users = [w for w in writers if w.get('usesConfigMutationHelper')]
    ok = not errors
    payload = {
        'ok': ok,
        'status': 'passed' if ok and not warnings else 'warning' if ok else 'failed',
        'generatedAt': now_iso(),
        'summary': 'Config mutation guard enforces archive-backed locked config edits and blocks new active-tree backups/new unclassified config writers.',
        'policy': {
            'path': str(POLICY),
            'loaded': isinstance(policy, dict) and bool(policy),
            'version': policy.get('schemaVersion') or policy.get('version') if isinstance(policy, dict) else None,
        },
        'counts': {
            'activeBackupFiles': len(active_backups),
            'configWriterCandidates': len(writers),
            'acceptedLegacyConfigWriters': len(accepted_legacy),
            'helperBasedConfigWriters': len(helper_users),
            'classifiedReadOnlyConsumers': len(read_only_consumers),
            'unclassifiedConfigWriters': len(unclassified),
            'errors': len(errors),
            'warnings': len(warnings),
        },
        'errors': errors,
        'warnings': warnings,
        'samples': {
            'activeBackupFiles': active_backups[:100],
            'configWriters': writers[:120],
            'classifiedReadOnlyConsumers': read_only_consumers[:30],
        },
        'artifacts': {},
    }
    artifacts = write_report(SLUG, payload, title='OSS Config Mutation Guard')
    payload['artifacts'] = artifacts
    write_report(SLUG, payload, title='OSS Config Mutation Guard')
    print(json.dumps({'ok': payload['ok'], 'status': payload['status'], 'counts': payload['counts'], 'artifacts': artifacts}, ensure_ascii=False))
    return payload


if __name__ == '__main__':
    main()