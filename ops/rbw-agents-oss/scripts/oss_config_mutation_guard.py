from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

from lib.wrapper_sdk import now_iso, write_report
from pydantic import JsonValue, TypeAdapter

JSON_OBJECT = TypeAdapter(dict[str, JsonValue])

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


def load_json(path: Path, default: JsonValue) -> JsonValue:
    try:
        return TypeAdapter(JsonValue).validate_json(path.read_bytes())
    except (OSError, ValueError):
        return default


def is_active_backup(path: Path) -> bool:
    if not path.is_file() or '/archive/' in path.as_posix():
        return False
    name = path.name
    return '.bak' in name or name.endswith(('~', '.old'))


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
    except OSError:
        return ''


def scan_config_writers() -> list[dict[str, JsonValue]]:
    candidates: list[dict[str, JsonValue]] = []
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
        candidates.append({'path': r, 'protectedNames': list(touched[:20]), 'writePatterns': list(write_hits), 'usesConfigMutationHelper': uses_helper})
    return candidates


def approved_read_only_consumers(policy: dict[str, JsonValue], root: Path) -> tuple[set[str], list[dict[str, JsonValue]]]:
    accepted = set(TypeAdapter(list[str]).validate_python(policy.get('acceptedReadOnlyProtectedConfigConsumers', [])))
    reviewed: dict[str, set[str]] = {}
    rows = TypeAdapter(list[JsonValue]).validate_python(policy.get('reviewedReadOnlyProtectedConfigConsumers', []))
    for row in rows:
        if isinstance(row, dict):
            path, digest = row.get('path'), row.get('sha256')
            if isinstance(path, str) and path and isinstance(digest, str) and digest:
                reviewed.setdefault(path, set()).add(digest)
    errors: list[dict[str, JsonValue]] = []
    for path in sorted(accepted):
        if path not in reviewed:
            accepted.discard(path)
            errors.append({'code': 'read_only_consumer_review_missing', 'path': path})
            continue
        try:
            digest = hashlib.sha256((root / path).read_bytes()).hexdigest()
        except OSError:
            digest = None
        if digest not in reviewed[path]:
            accepted.discard(path)
            errors.append({'code': 'read_only_consumer_review_hash_mismatch', 'path': path})
    return accepted, errors


def main() -> dict[str, JsonValue]:
    policy = JSON_OBJECT.validate_python(load_json(POLICY, {}))
    accepted = set(TypeAdapter(list[str]).validate_python(policy.get('acceptedLegacyConfigWriters', [])))
    accepted_read_only, read_only_errors = approved_read_only_consumers(policy, ROOT)
    active_backups = scan_active_backups()
    writers = scan_config_writers()
    unclassified = [
        w for w in writers
        if not w.get('usesConfigMutationHelper')
        and str(w['path']) not in accepted
        and str(w['path']) not in accepted_read_only
    ]
    helper_missing = not (SCRIPTS / 'lib/config_mutation.py').exists()
    errors: list[dict[str, JsonValue]] = list(read_only_errors)
    warnings: list[dict[str, JsonValue]] = []
    if helper_missing:
        errors.append({'code': 'config_mutation_helper_missing', 'path': 'scripts/lib/config_mutation.py'})
    if active_backups:
        errors.append({'code': 'active_backup_files', 'count': len(active_backups), 'sample': list(active_backups[:50])})
    if unclassified:
        errors.append({'code': 'unclassified_config_writers', 'count': len(unclassified), 'sample': list(unclassified[:30])})
    accepted_legacy = [w for w in writers if str(w['path']) in accepted]
    read_only_consumers = [w for w in writers if str(w['path']) in accepted_read_only]
    if accepted_legacy:
        warnings.append({'code': 'accepted_legacy_config_writers', 'count': len(accepted_legacy), 'sample': list(accepted_legacy[:20])})
    helper_users = [w for w in writers if w.get('usesConfigMutationHelper')]
    ok = not errors
    payload = JSON_OBJECT.validate_python({
        'ok': ok,
        'status': 'passed' if ok and not warnings else 'warning' if ok else 'failed',
        'generatedAt': now_iso(),
        'summary': 'Config mutation guard enforces archive-backed locked config edits and blocks new active-tree backups/new unclassified config writers.',
        'policy': {
            'path': str(POLICY),
            'loaded': bool(policy),
            'version': policy.get('schemaVersion') or policy.get('version'),
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
    })
    artifacts = write_report(SLUG, payload, title='OSS Config Mutation Guard')
    payload['artifacts'] = dict(artifacts)
    _ = write_report(SLUG, payload, title='OSS Config Mutation Guard')
    print(json.dumps({'ok': payload['ok'], 'status': payload['status'], 'counts': payload['counts'], 'artifacts': artifacts}, ensure_ascii=False))
    return payload


if __name__ == '__main__':
    _ = main()
