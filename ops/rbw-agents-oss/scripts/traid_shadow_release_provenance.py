from __future__ import annotations
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
from datetime import datetime, timedelta, timezone

REGISTRY = Path('/opt/traid-onchain-shadow/release-manifests')
RELEASES = Path('/opt/traid-onchain-shadow/releases')
FINANCE = ('transaction_attempt_count', 'signature_attempt_count', 'capital_movement_count', 'chain_mutation_count')

class ProvenanceValidationError(ValueError):
    pass

SAFE_ERROR_CODES = frozenset(['file_changed_during_read', 'live_proof_clock_invalid', 'live_proof_counter_invalid', 'live_proof_financial_counters_invalid', 'live_proof_first_cycle_not_after_activation_baseline', 'live_proof_future_observation', 'live_proof_guard_not_passed', 'live_proof_identity_invalid', 'live_proof_memory_pressure_invalid', 'live_proof_no_historical_progress', 'live_proof_no_stable_progress', 'live_proof_observations_invalid', 'live_proof_report_time_invalid', 'live_proof_resources_invalid', 'live_proof_status_invalid', 'live_proof_times_invalid', 'live_proof_timestamp_invalid', 'live_proof_timestamp_not_aware', 'manifest_entries_invalid', 'manifest_identity_invalid', 'manifest_path_invalid', 'manifest_policy_invalid', 'non_regular_file', 'registry_directory_not_trusted', 'registry_file_not_trusted', 'registry_file_replaced', 'registry_file_too_large', 'registry_json_not_object', 'release_content_invalid', 'release_git_identity_invalid', 'release_hardlinks_invalid', 'release_kind_invalid', 'release_metadata_invalid', 'release_path_invalid', 'release_tree_or_external_hardlink_invalid'])

def proof_time(value):
    try:
        if type(value) is not str:
            raise TypeError()
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    except (ValueError, TypeError):
        raise ProvenanceValidationError('live_proof_timestamp_invalid') from None
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ProvenanceValidationError('live_proof_timestamp_not_aware')
    return parsed

def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()

def file_digest(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as stream:
        before = os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode):
            raise ProvenanceValidationError('non_regular_file')
        result = hashlib.file_digest(stream, 'sha256').hexdigest()
        after = os.fstat(stream.fileno())
        if (before.st_ino, before.st_size, before.st_mtime_ns) != (after.st_ino, after.st_size, after.st_mtime_ns):
            raise ProvenanceValidationError('file_changed_during_read')
        return result

def trusted_json(path, authority_uid):
    metadata = path.lstat()
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != authority_uid or metadata.st_mode & 0o022 or metadata.st_nlink != 1:
        raise ProvenanceValidationError('registry_file_not_trusted')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as stream:
        actual = os.fstat(stream.fileno())
        if (actual.st_ino, actual.st_dev) != (metadata.st_ino, metadata.st_dev):
            raise ProvenanceValidationError('registry_file_replaced')
        payload = stream.read(5_000_001)
    if len(payload) > 5_000_000:
        raise ProvenanceValidationError('registry_file_too_large')
    value = json.loads(payload)
    if not isinstance(value, dict):
        raise ProvenanceValidationError('registry_json_not_object')
    return value

def live_baselines(proof, sha, digest, *, now=None):
    if proof.get('schema') != 'traid.onchain-observer-live-verification.v1' or proof.get('candidateSha') != sha or proof.get('manifestSha256') != digest or proof.get('scope') != 'observe_only_shadow_deployment':
        raise ProvenanceValidationError('live_proof_identity_invalid')
    rows = proof.get('observations')
    if not isinstance(rows, list) or len(rows) != 2:
        raise ProvenanceValidationError('live_proof_observations_invalid')
    activated = proof_time(proof['activatedAt'])
    times = [proof_time(row['observedAt']) for row in rows]
    checked_at = datetime.now(timezone.utc) if now is None else now
    if not isinstance(checked_at, datetime) or checked_at.tzinfo is None:
        raise ProvenanceValidationError('live_proof_clock_invalid')
    # At most five seconds of host clock skew; no future-dated recovery.
    limit = checked_at + timedelta(seconds=5)
    if activated > limit or any(t > limit for t in times):
        raise ProvenanceValidationError('live_proof_future_observation')
    if activated.tzinfo is None or any(t.tzinfo is None for t in times) or times[0] < activated or times[1] <= times[0]:
        raise ProvenanceValidationError('live_proof_times_invalid')
    baselines = {}
    for kind in ('primary', 'sidecar'):
        first, second = [row[kind] for row in rows]
        baseline = proof.get('activationBaseline', {}).get(kind, {})
        required = ('cycles', 'checkpoint', 'historicalNext') if kind == 'sidecar' else ('cycles', 'checkpoint')
        if any(type(baseline.get(key)) is not int or baseline[key] < 0 or type(first.get(key)) is not int or first[key] <= baseline[key] for key in required):
            raise ProvenanceValidationError('live_proof_first_cycle_not_after_activation_baseline')
        for row, observed_at in zip((first, second), times):
            reported = proof_time(row['reportAt'])
            if reported.tzinfo is None or not activated <= reported <= observed_at:
                raise ProvenanceValidationError('live_proof_report_time_invalid')
            if kind == 'primary' and row.get('guardPass') is not True:
                raise ProvenanceValidationError('live_proof_guard_not_passed')
            for key in ('mainPid', 'startMonotonic', 'restartCount', 'cycles', 'checkpoint', 'memoryCurrent', 'memoryHigh', 'memoryMax'):
                if type(row.get(key)) is not int or row[key] < 0:
                    raise ProvenanceValidationError('live_proof_counter_invalid')
            if row['mainPid'] == 0 or row['startMonotonic'] == 0 or not 0 < row['memoryCurrent'] < row['memoryHigh'] < row['memoryMax']:
                raise ProvenanceValidationError('live_proof_resources_invalid')
            if row.get('status') != ('healthy' if kind == 'primary' else 'ok'):
                raise ProvenanceValidationError('live_proof_status_invalid')
            finance = row.get('financialCounters', {})
            if set(finance) != set(FINANCE) or any(type(finance[key]) is not int or finance[key] != 0 for key in FINANCE):
                raise ProvenanceValidationError('live_proof_financial_counters_invalid')
            pressure = row.get('memoryPressureEvents', {})
            if set(pressure) != {'high', 'max', 'oom', 'oom_kill'} or any(type(v) is not int or v != 0 for v in pressure.values()):
                raise ProvenanceValidationError('live_proof_memory_pressure_invalid')
        stable = ('mainPid', 'startMonotonic', 'restartCount')
        if any(first[key] != second[key] for key in stable) or second['cycles'] <= first['cycles'] or second['checkpoint'] <= first['checkpoint']:
            raise ProvenanceValidationError('live_proof_no_stable_progress')
        if kind == 'sidecar' and (type(first.get('historicalNext')) is not int or type(second.get('historicalNext')) is not int or second['historicalNext'] <= first['historicalNext']):
            raise ProvenanceValidationError('live_proof_no_historical_progress')
        baselines[kind] = {key: second[key] for key in stable}
    return baselines

def inspect_reviewed_release(current, *, registry=REGISTRY, releases=RELEASES, authority_uid=0, release_uid=1000):
    current = Path(current)
    result = {'valid': False, 'kind': 'invalid', 'restartBaselines': {}, 'liveProofVerified': False}
    try:
        if current.parent != releases or re.fullmatch('[0-9a-f]{40}', current.name) is None or current.is_symlink():
            raise ProvenanceValidationError('release_path_invalid')
        parent = registry.lstat()
        if not stat.S_ISDIR(parent.st_mode) or parent.st_uid != authority_uid or parent.st_mode & 0o022:
            raise ProvenanceValidationError('registry_directory_not_trusted')
        path = registry / (current.name + '.json')
        if not os.path.lexists(path):
            return {**result, 'kind': 'absent'}
        m = trusted_json(path, authority_uid)
        declared = m.pop('manifest_sha256', None)
        if declared != hashlib.sha256(canonical(m)).hexdigest() or m.get('schema') != 'traid.onchain-release-content-manifest.v3' or m.get('release_sha') != current.name or m.get('release_path') != str(current):
            raise ProvenanceValidationError('manifest_identity_invalid')
        if m.get('owner_policy') != 'ubuntu_owned_static_runtime_read_only_release_v1' or m.get('runtime_check') != 'TRAID_STATIC_RUNTIME_OK':
            raise ProvenanceValidationError('manifest_policy_invalid')
        entries = m.get('entries')
        if not isinstance(entries, list) or not 1 <= len(entries) <= 20_000 or m.get('tree_sha256') != hashlib.sha256(canonical(entries)).hexdigest():
            raise ProvenanceValidationError('manifest_entries_invalid')
        paths, links = set(), {}
        for entry in entries:
            relative = entry['path']
            part = PurePosixPath(relative)
            if not isinstance(relative, str) or part.is_absolute() or '..' in part.parts or relative in paths or part.as_posix() != relative:
                raise ProvenanceValidationError('manifest_path_invalid')
            paths.add(relative)
            p = current / relative
            s = p.lstat()
            if stat.S_ISLNK(s.st_mode) or s.st_uid != entry['uid'] or s.st_uid != release_uid or s.st_gid != entry['gid'] or oct(stat.S_IMODE(s.st_mode)) != entry['mode'] or s.st_mode & 0o222:
                raise ProvenanceValidationError('release_metadata_invalid')
            if entry['kind'] == 'directory':
                if not stat.S_ISDIR(s.st_mode):
                    raise ProvenanceValidationError('release_kind_invalid')
            elif entry['kind'] == 'file':
                if not stat.S_ISREG(s.st_mode) or s.st_size != entry['size'] or file_digest(p) != entry['sha256']:
                    raise ProvenanceValidationError('release_content_invalid')
                if s.st_nlink > 1:
                    links.setdefault((s.st_dev, s.st_ino), [s.st_nlink, []])[1].append(relative)
            else:
                raise ProvenanceValidationError('release_kind_invalid')
        actual = {p.relative_to(current).as_posix() for p in [current, *current.rglob('*')]}
        if paths != actual or any(count != len(names) for count, names in links.values()):
            raise ProvenanceValidationError('release_tree_or_external_hardlink_invalid')
        if sorted(sorted(names) for _, names in links.values()) != sorted(sorted(names) for names in m.get('hardlink_groups', [])):
            raise ProvenanceValidationError('release_hardlinks_invalid')
        environment = {'PATH': '/usr/bin:/bin', 'HOME': '/nonexistent', 'LC_ALL': 'C.UTF-8'}
        git = lambda ref: subprocess.check_output(['git', '-c', 'core.hooksPath=/dev/null', '-C', str(current), 'rev-parse', ref], text=True, env=environment, timeout=10).strip()
        if git('HEAD') != current.name or git('HEAD^{tree}') != m.get('git_tree'):
            raise ProvenanceValidationError('release_git_identity_invalid')
        result.update({'valid': True, 'kind': 'reviewed_manifest', 'manifestSha256': declared, 'entryCount': len(entries)})
        proof_path = registry / (current.name + '.live-verification.json')
        if os.path.lexists(proof_path):
            result['restartBaselines'] = live_baselines(trusted_json(proof_path, authority_uid), current.name, declared)
            result['liveProofVerified'] = True
        return result
    except Exception as error:
        return {**result, 'valid': False, 'kind': 'invalid', 'restartBaselines': {}, 'liveProofVerified': False, 'error': str(error) if isinstance(error, ProvenanceValidationError) and str(error) in SAFE_ERROR_CODES else 'provenance_validation_failed'}

def restart_count_ok(service, baseline):
    count = service.get('restartCount')
    if type(count) is not int or count < 0:
        return False
    if any(type(service.get(key)) is not int or service[key] <= 0 for key in ('mainPid', 'startMonotonic')):
        return False
    if baseline is not None:
        return isinstance(baseline, dict) and all(type(baseline.get(key)) is int and baseline[key] == service.get(key) for key in ('mainPid', 'startMonotonic', 'restartCount')) and baseline.get('mainPid', 0) > 0 and baseline.get('startMonotonic', 0) > 0
    return count == 0
