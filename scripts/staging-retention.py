#!/usr/bin/env python3
"""Create verified local rollback bundles and retain the two newest checkpoints."""
import argparse
import datetime
import fcntl
import hashlib
import importlib.util
import json
import os
import plistlib
from pathlib import Path
import re
import shutil
import stat
import subprocess
import tempfile

DEFAULT_ROOT = Path.home() / 'Library/Application Support/Robb Agents/Staging Backups'
DEFAULT_WORKSPACES_ROOT = Path.home() / '.craft-agent/workspaces'
KEEP = 2
APP_ID = 'io.robinswood.robbagents'
APP_NAME = 'Robb Agents.app'
LEGACY_PREFIXES = ('Robb Agents.app.previous-', 'Robb Agents.app.replaced-',
                   '.Robb Agents.app.rollback-', '.Robb Agents.app.pre-staging-')
CHECKPOINT_NAME_RE = re.compile(
    r'^(?P<date>\d{8})-(?P<time>\d{6})-(?P<suffix>\d{6}|legacy-[A-Za-z0-9_-]+)$'
)
STRONG_VALIDATION_CONTRACT = 'robb-local-staging.validate_bundle.v1'
FINGERPRINT_KEYS = {
    'bundleIdentifier', 'executable', 'version', 'buildCommit', 'buildChannel',
    'buildDirty', 'architecture', 'signatureKind', 'asarSha256',
    'executableSha256', 'infoPlistSha256', 'bundleTreeSha256',
}


def resolve_managed_root(root):
    """Resolve a root only after rejecting symlinks below a trusted OS anchor."""
    expanded = Path(os.path.abspath(os.path.expanduser(str(root))))
    trusted_anchors = (Path.home().absolute(), Path(tempfile.gettempdir()).absolute())
    applicable = [
        anchor for anchor in trusted_anchors
        if expanded == anchor or anchor in expanded.parents
    ]
    stop = max(applicable, key=lambda path: len(path.parts)) if applicable else Path(expanded.anchor)
    current = expanded
    while True:
        if current.is_symlink():
            raise ValueError(f'Staging backup path component must not be a symlink: {current}')
        if current == stop or current.parent == current:
            break
        current = current.parent
    return expanded.resolve()


def sha256_file(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def sha256_tree(root):
    """Hash every bundle entry without following symlinks."""
    digest = hashlib.sha256()

    def visit(directory, relative_parent):
        entries = sorted(os.scandir(directory), key=lambda entry: entry.name)
        for entry in entries:
            relative = relative_parent / entry.name
            info = entry.stat(follow_symlinks=False)
            digest.update(
                os.fsencode(str(relative))
                + b'\0'
                + f'{stat.S_IMODE(info.st_mode):o}'.encode()
                + b'\0'
            )
            path = Path(entry.path)
            if stat.S_ISLNK(info.st_mode):
                digest.update(b'L\0' + os.fsencode(os.readlink(path)) + b'\0')
            elif stat.S_ISDIR(info.st_mode):
                digest.update(b'D\0')
                visit(path, relative)
            elif stat.S_ISREG(info.st_mode):
                digest.update(b'F\0' + sha256_file(path).encode() + b'\0')
            else:
                raise ValueError(f'Unsupported special file in application bundle: {path}')

    visit(root, Path())
    return digest.hexdigest()


def strong_validation_manifest(fingerprint):
    if (
        not isinstance(fingerprint, dict)
        or set(fingerprint) != FINGERPRINT_KEYS
        or any(not isinstance(value, str) or not value for value in fingerprint.values())
    ):
        raise ValueError('Strong bundle validation returned an incomplete fingerprint')
    return {
        'contract': STRONG_VALIDATION_CONTRACT,
        'fingerprint': dict(fingerprint),
    }


def validate_bundle_strongly(bundle):
    """Use the transactional installer's complete ASAR/fuse/provenance contract."""
    helper = Path(__file__).resolve().with_name('robb-local-staging.py')
    if not helper.is_file():
        raise ValueError(
            'Strong backup validation helper is unavailable; run --backup-app from the repository script'
        )
    spec = importlib.util.spec_from_file_location('robb_local_staging_retention', helper)
    if spec is None or spec.loader is None:
        raise ValueError(f'Cannot load strong backup validator: {helper}')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.validate_bundle(
        helper.parents[1],
        bundle,
        expected_commit=None,
    )


def open_lock(path):
    flags = os.O_RDWR | os.O_CREAT
    if hasattr(os, 'O_NOFOLLOW'):
        flags |= os.O_NOFOLLOW
    elif path.is_symlink():
        raise ValueError(f'Retention lock must not be a symlink: {path}')
    descriptor = os.open(path, flags, 0o600)
    lock = os.fdopen(descriptor, 'r+')
    if not stat.S_ISREG(os.fstat(lock.fileno()).st_mode):
        lock.close()
        raise ValueError(f'Retention lock is not a regular file: {path}')
    return lock


def verify_checkpoint_signature(bundle):
    result = subprocess.run(
        ['/usr/bin/codesign', '--verify', '--deep', '--strict', str(bundle)],
        check=False,
        capture_output=True,
        text=True,
    )
    return result.returncode == 0


def managed_checkpoint(path, signature_verifier=verify_checkpoint_signature):
    """Return immutable cleanup evidence, or None for anything not managed."""
    match = CHECKPOINT_NAME_RE.fullmatch(path.name)
    if match is None or path.is_symlink() or not path.is_dir():
        return None
    try:
        path_info = path.stat(follow_symlinks=False)
        manifest_path = path / 'backup.json'
        if manifest_path.is_symlink() or not manifest_path.is_file():
            return None
        manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
        if not isinstance(manifest, dict) or manifest.get('version') != 2:
            return None
        created_at = manifest.get('createdAt')
        source = manifest.get('source')
        if not isinstance(created_at, str) or not isinstance(source, str):
            return None
        validation = manifest.get('validation')
        if not isinstance(validation, dict) or validation.get('contract') != STRONG_VALIDATION_CONTRACT:
            return None
        fingerprint = validation.get('fingerprint')
        if (
            not isinstance(fingerprint, dict)
            or set(fingerprint) != FINGERPRINT_KEYS
            or any(not isinstance(value, str) or not value for value in fingerprint.values())
        ):
            return None
        created = datetime.datetime.fromisoformat(created_at)
        if created.tzinfo is None:
            return None
        created_utc = created.astimezone(datetime.timezone.utc)
        if created_utc.strftime('%Y%m%d-%H%M%S') != f"{match.group('date')}-{match.group('time')}":
            return None
        suffix = match.group('suffix')
        if suffix.isdigit() and suffix != f'{created_utc.microsecond:06d}':
            return None
        source_path = Path(source)
        if source_path.parent != Path('/Applications') or not (
            source_path.name == APP_NAME or source_path.name.startswith(LEGACY_PREFIXES)
        ):
            return None

        bundle = path / APP_NAME
        contents = bundle / 'Contents'
        macos = contents / 'MacOS'
        resources = contents / 'Resources'
        plist_path = contents / 'Info.plist'
        executable = macos / 'Robb Agents'
        archive = resources / 'app.asar'
        required_paths = (bundle, contents, macos, resources, plist_path, executable, archive)
        if any(required.is_symlink() for required in required_paths):
            return None
        if not bundle.is_dir() or not contents.is_dir() or not macos.is_dir() or not resources.is_dir():
            return None
        if not plist_path.is_file() or not executable.is_file() or not archive.is_file():
            return None
        info = plistlib.loads(plist_path.read_bytes())
        if (
            info.get('CFBundleIdentifier') != APP_ID
            or info.get('CFBundleExecutable') != 'Robb Agents'
        ):
            return None
        if (
            fingerprint['bundleIdentifier'] != APP_ID
            or fingerprint['executable'] != 'Robb Agents'
            or fingerprint['version'] != str(info.get('CFBundleShortVersionString', ''))
            or not re.fullmatch(r'[0-9a-f]{40}', fingerprint['buildCommit'])
            or fingerprint['buildChannel'] != 'production'
            or fingerprint['buildDirty'] != 'false'
            or 'arm64' not in fingerprint['architecture']
            or fingerprint['signatureKind'] not in ('adhoc', 'developer-id')
            or fingerprint['asarSha256'] != sha256_file(archive)
            or fingerprint['executableSha256'] != sha256_file(executable)
            or fingerprint['infoPlistSha256'] != sha256_file(plist_path)
            or fingerprint['bundleTreeSha256'] != sha256_tree(bundle)
        ):
            return None
        if not signature_verifier(bundle):
            return None
        final_info = path.stat(follow_symlinks=False)
        if (final_info.st_dev, final_info.st_ino) != (path_info.st_dev, path_info.st_ino):
            return None
    except (OSError, ValueError, json.JSONDecodeError, plistlib.InvalidFileException):
        return None
    return {
        'path': path,
        'created': created.timestamp(),
        'identity': (path_info.st_dev, path_info.st_ino),
    }


def managed_candidates(root, signature_verifier=verify_checkpoint_signature):
    root = resolve_managed_root(root)
    if not root.exists():
        return []
    records = []
    for path in root.iterdir():
        record = managed_checkpoint(path, signature_verifier)
        if record is not None:
            records.append(record)
    return sorted(records, key=lambda item: (item['created'], item['path'].name), reverse=True)


def candidates(root, signature_verifier=verify_checkpoint_signature):
    return [record['path'] for record in managed_candidates(root, signature_verifier)]


def next_checkpoint_time(root, now, signature_verifier=verify_checkpoint_signature):
    """Return a timestamp newer than every prunable checkpoint despite clock rollback."""
    newest = now.astimezone(datetime.timezone.utc)
    for record in managed_candidates(root, signature_verifier):
        candidate = datetime.datetime.fromtimestamp(record['created'], datetime.timezone.utc)
        if candidate >= newest:
            newest = candidate + datetime.timedelta(microseconds=1)
    return newest


def import_legacy(root, fingerprint_validator=validate_bundle_strongly):
    root = resolve_managed_root(root)
    imported = []
    for source in Path('/Applications').iterdir():
        if not source.name.startswith(LEGACY_PREFIXES) or source.is_symlink() or not source.is_dir():
            continue
        info = plistlib.loads((source / 'Contents/Info.plist').read_bytes())
        if info.get('CFBundleIdentifier') != APP_ID:
            raise ValueError(f'Unexpected bundle identity: {source}')
        fingerprint = fingerprint_validator(source)
        stat = source.stat()
        created = datetime.datetime.fromtimestamp(getattr(stat, 'st_birthtime', stat.st_mtime), datetime.timezone.utc)
        partial = Path(tempfile.mkdtemp(prefix='.partial-legacy-', dir=root))
        (partial / 'backup.json').write_text(json.dumps({
            'version': 2,
            'createdAt': created.isoformat(),
            'source': str(source),
            'validation': strong_validation_manifest(fingerprint),
        }))
        source.rename(partial / 'Robb Agents.app')
        final = root / (created.strftime('%Y%m%d-%H%M%S-') + partial.name.removeprefix('.partial-'))
        partial.rename(final)
        imported.append(str(source))
    return imported


def prune(root, apply=False, signature_verifier=verify_checkpoint_signature):
    root = resolve_managed_root(root)
    if not root.exists():
        return {'kept': [], 'removed': [], 'apply': apply}
    ordered = managed_candidates(root, signature_verifier)
    removed = ordered[KEEP:]
    if apply:
        for record in removed:
            path = record['path']
            if path.is_symlink() or path.parent.resolve() != root.resolve():
                raise ValueError('Backup path changed during cleanup')
            current = managed_checkpoint(path, signature_verifier)
            if current is None or current['identity'] != record['identity']:
                raise ValueError(f'Backup changed after validation: {path}')
            shutil.rmtree(path)
            if path.exists():
                raise RuntimeError(f'Backup removal failed: {path}')
    return {
        'kept': [record['path'].name for record in ordered[:KEEP]],
        'removed': [record['path'].name for record in removed],
        'apply': apply,
    }


def backup(
    root,
    hold_created=False,
    fingerprint_validator=validate_bundle_strongly,
    source=Path('/Applications') / APP_NAME,
    clock=lambda: datetime.datetime.now(datetime.timezone.utc),
    signature_verifier=verify_checkpoint_signature,
):
    root = resolve_managed_root(root)
    if source.is_symlink() or not source.is_dir():
        raise ValueError('Expected the installed production/staging bundle')
    subprocess.run(['/usr/bin/codesign', '--verify', '--deep', '--strict', str(source)], check=True)
    source_fingerprint = fingerprint_validator(source) if fingerprint_validator is not None else None
    partial = Path(tempfile.mkdtemp(prefix='.partial-', dir=root))
    bundle = partial / APP_NAME
    # Keep an interrupted copy identifiable; it can never displace a valid checkpoint.
    subprocess.run(['/usr/bin/ditto', str(source), str(bundle)], check=True)
    subprocess.run(['/usr/bin/codesign', '--verify', '--deep', '--strict', str(bundle)], check=True)
    copy_fingerprint = fingerprint_validator(bundle) if fingerprint_validator is not None else None
    if fingerprint_validator is not None and copy_fingerprint != source_fingerprint:
        raise ValueError('Strong bundle fingerprint changed while creating the staging backup')
    now = next_checkpoint_time(root, clock(), signature_verifier)
    manifest = {
        'version': 2 if copy_fingerprint is not None else 1,
        'createdAt': now.isoformat(),
        'source': str(source),
    }
    if copy_fingerprint is not None:
        manifest['validation'] = strong_validation_manifest(copy_fingerprint)
    (partial / 'backup.json').write_text(json.dumps(manifest))
    if hold_created:
        final = root / f'.rollback-held-backup-{now:%Y%m%d-%H%M%S-%f}-{os.getpid()}'
    else:
        final = root / now.strftime('%Y%m%d-%H%M%S-%f')
    partial.rename(final)
    return final


def prune_session_scratch(
    workspaces_root=DEFAULT_WORKSPACES_ROOT,
    min_size_bytes=100 * 1024 * 1024,
    max_age_days=15,
    apply=False,
    now=None,
):
    """Safely clean temporary scratch artifacts from session data directories."""
    workspaces_root = Path(workspaces_root).expanduser()
    if not workspaces_root.is_dir() or workspaces_root.is_symlink():
        return {
            'scannedSessions': 0,
            'prunedCount': 0,
            'freedBytes': 0,
            'freedMb': 0,
            'apply': apply,
            'items': [],
        }

    now_ts = (now or datetime.datetime.now(datetime.timezone.utc)).timestamp()
    max_age_seconds = max_age_days * 86400
    scanned_sessions = 0
    freed_bytes = 0
    pruned_items = []

    for workspace in sorted(workspaces_root.iterdir()):
        if not workspace.is_dir() or workspace.is_symlink():
            continue
        sessions_dir = workspace / 'sessions'
        if not sessions_dir.is_dir() or sessions_dir.is_symlink():
            continue
        for session in sorted(sessions_dir.iterdir()):
            if not session.is_dir() or session.is_symlink():
                continue
            session_jsonl = session / 'session.jsonl'
            if not session_jsonl.is_file() or session_jsonl.is_symlink():
                continue
            scanned_sessions += 1
            data_dir = session / 'data'
            if not data_dir.is_dir() or data_dir.is_symlink():
                continue

            for entry in sorted(data_dir.iterdir()):
                if entry.is_symlink():
                    continue
                size = 0
                newest_mtime = 0
                if entry.is_dir():
                    for root, _dirs, files in os.walk(entry):
                        for f in files:
                            fp = Path(root) / f
                            if not fp.is_symlink():
                                try:
                                    st = fp.stat()
                                    size += st.st_size
                                    if st.st_mtime > newest_mtime:
                                        newest_mtime = st.st_mtime
                                except OSError:
                                    pass
                elif entry.is_file():
                    try:
                        st = entry.stat()
                        size = st.st_size
                        newest_mtime = st.st_mtime
                    except OSError:
                        pass

                age_seconds = max(0.0, now_ts - newest_mtime)
                if size >= min_size_bytes and age_seconds >= max_age_seconds:
                    if apply:
                        if entry.is_dir():
                            shutil.rmtree(entry)
                        else:
                            entry.unlink()
                    freed_bytes += size
                    pruned_items.append({
                        'session': session.name,
                        'name': entry.name,
                        'sizeMb': size // (1024 * 1024),
                        'ageDays': int(age_seconds // 86400),
                    })

    return {
        'scannedSessions': scanned_sessions,
        'prunedCount': len(pruned_items),
        'freedBytes': freed_bytes,
        'freedMb': freed_bytes // (1024 * 1024),
        'apply': apply,
        'items': pruned_items,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true', help='Actually remove backups beyond the newest two')
    parser.add_argument('--backup-app', action='store_true', help='Copy and verify the installed bundle, then prune')
    parser.add_argument('--no-prune', action='store_true', help='With --backup-app, defer pruning until stronger caller validation succeeds')
    parser.add_argument('--hold-created', action='store_true', help='With --backup-app, publish the new checkpoint outside the prunable inventory')
    parser.add_argument('--defer-strong-validation', action='store_true', help='With held/no-prune backup, let the in-memory transaction validator publish the v2 proof')
    parser.add_argument('--import-legacy', action='store_true', help='Move historical /Applications rollback bundles into the managed root (requires --apply)')
    parser.add_argument('--prune-session-scratch', action='store_true', help='Clean temporary scratch artifacts from session data folders')
    parser.add_argument('--scratch-min-size-mb', type=int, default=100, help='Minimum size in MB for scratch cleanup (default: 100)')
    parser.add_argument('--scratch-max-age-days', type=int, default=15, help='Minimum age in days for scratch cleanup (default: 15)')
    parser.add_argument('--workspaces-root', type=Path, default=DEFAULT_WORKSPACES_ROOT, help='Path to Craft workspaces root')
    parser.add_argument('--root', type=Path, default=DEFAULT_ROOT)
    args = parser.parse_args()
    if args.import_legacy and not args.apply:
        parser.error('--import-legacy requires --apply')
    if args.no_prune and not args.backup_app:
        parser.error('--no-prune requires --backup-app')
    if args.hold_created and not args.backup_app:
        parser.error('--hold-created requires --backup-app')
    if args.hold_created and not args.no_prune:
        parser.error('--hold-created requires --no-prune')
    if args.defer_strong_validation and not (
        args.backup_app and args.hold_created and args.no_prune
    ):
        parser.error('--defer-strong-validation requires --backup-app --hold-created --no-prune')
    args.root = resolve_managed_root(args.root)
    args.root.mkdir(parents=True, exist_ok=True)
    # Keep the lock outside WatchPaths, otherwise opening it can retrigger launchd.
    with open_lock(args.root.parent / f'.{args.root.name}.retention.lock') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if args.import_legacy:
            print(json.dumps({'imported': import_legacy(args.root)}), flush=True)
        if args.backup_app:
            if args.defer_strong_validation:
                created = backup(args.root, args.hold_created, None)
            else:
                created = backup(args.root, args.hold_created)
            print(json.dumps({'created': str(created)}))
        if args.prune_session_scratch:
            scratch_result = prune_session_scratch(
                workspaces_root=args.workspaces_root,
                min_size_bytes=args.scratch_min_size_mb * 1024 * 1024,
                max_age_days=args.scratch_max_age_days,
                apply=args.apply,
            )
            print(json.dumps({'sessionScratch': scratch_result}))
        print(json.dumps(prune(args.root, args.apply or (args.backup_app and not args.no_prune))))


if __name__ == '__main__':
    main()
