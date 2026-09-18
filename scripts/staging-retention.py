#!/usr/bin/env python3
"""Create verified local rollback bundles and retain the two newest checkpoints."""
import argparse
import datetime
import json
import os
import plistlib
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

try:
    import fcntl
except ImportError:  # pragma: no cover - exercised by import on non-POSIX hosts
    fcntl = None

DEFAULT_ROOT = Path.home() / 'Library/Application Support/Robb Agents/Staging Backups'
KEEP = 2
PRODUCTION_BUNDLE_IDENTIFIER = 'io.robinswood.robbagents'
SOURCE_BUNDLE = Path('/Applications/Robb Agents.app')
LEGACY_APPLICATIONS_ROOT = Path('/Applications')
CODESIGN = Path('/usr/bin/codesign')
DITTO = Path('/usr/bin/ditto')


def require_posix(operation):
    if os.name != 'posix' or fcntl is None:
        raise RuntimeError(f'{operation} is only supported on POSIX systems')


def verify_production_identity(bundle):
    info_path = bundle / 'Contents/Info.plist'
    if bundle.is_symlink() or not bundle.is_dir() or info_path.is_symlink() or not info_path.is_file():
        raise ValueError(f'Expected a production Robb Agents bundle: {bundle}')
    try:
        info = plistlib.loads(info_path.read_bytes())
    except (OSError, plistlib.InvalidFileException) as error:
        raise ValueError(f'Invalid bundle metadata: {bundle}') from error
    if info.get('CFBundleIdentifier') != PRODUCTION_BUNDLE_IDENTIFIER:
        raise ValueError(f'Unexpected bundle identity: {bundle}')


def candidates(root):
    result = []
    for path in root.iterdir():
        if path.is_symlink() or not path.is_dir() or not re.match(r'^\d{8}-', path.name):
            continue
        # Checkpoints are published atomically; staging work stays in .partial-*.
        result.append(path)
    def created(path):
        manifest = path / 'backup.json'
        if manifest.exists():
            return datetime.datetime.fromisoformat(json.loads(manifest.read_text())['createdAt']).timestamp()
        info = path.stat()
        return getattr(info, 'st_birthtime', info.st_mtime)
    return sorted(result, key=lambda p: (created(p), p.name), reverse=True)


def import_legacy(root):
    require_posix('Legacy application import')
    prefixes = ('Robb Agents.app.previous-', 'Robb Agents.app.replaced-',
                '.Robb Agents.app.rollback-', '.Robb Agents.app.pre-staging-')
    imported = []
    for source in LEGACY_APPLICATIONS_ROOT.iterdir():
        if not source.name.startswith(prefixes) or source.is_symlink() or not source.is_dir():
            continue
        verify_production_identity(source)
        subprocess.run([str(CODESIGN), '--verify', '--deep', '--strict', str(source)], check=True)
        stat = source.stat()
        created = datetime.datetime.fromtimestamp(getattr(stat, 'st_birthtime', stat.st_mtime), datetime.timezone.utc)
        partial = Path(tempfile.mkdtemp(prefix='.partial-legacy-', dir=root))
        (partial / 'backup.json').write_text(json.dumps({'version': 1, 'createdAt': created.isoformat(), 'source': str(source)}))
        source.rename(partial / 'Robb Agents.app')
        final = root / (created.strftime('%Y%m%d-%H%M%S-') + partial.name.removeprefix('.partial-'))
        partial.rename(final)
        imported.append(str(source))
    return imported


def prune(root, apply=False):
    if root.is_symlink():
        raise ValueError('The staging backup root must not be a symlink')
    if not root.exists():
        return {'kept': [], 'removed': [], 'apply': apply}
    ordered = candidates(root)
    removed = ordered[KEEP:]
    if apply:
        for path in removed:
            if path.is_symlink() or path.parent.resolve() != root.resolve():
                raise ValueError('Backup path changed during cleanup')
            shutil.rmtree(path)
            if path.exists():
                raise RuntimeError(f'Backup removal failed: {path}')
    return {'kept': [p.name for p in ordered[:KEEP]], 'removed': [p.name for p in removed], 'apply': apply}


def backup(root):
    require_posix('Application backup')
    source = SOURCE_BUNDLE
    verify_production_identity(source)
    subprocess.run([str(CODESIGN), '--verify', '--deep', '--strict', str(source)], check=True)
    partial = Path(tempfile.mkdtemp(prefix='.partial-', dir=root))
    bundle = partial / 'Robb Agents.app'
    try:
        subprocess.run([str(DITTO), str(source), str(bundle)], check=True)
        verify_production_identity(bundle)
        subprocess.run([str(CODESIGN), '--verify', '--deep', '--strict', str(bundle)], check=True)
        now = datetime.datetime.now(datetime.timezone.utc)
        (partial / 'backup.json').write_text(json.dumps({'version': 1, 'createdAt': now.isoformat(), 'source': str(source)}))
        final = root / now.strftime('%Y%m%d-%H%M%S-%f')
        partial.rename(final)
        return final
    except BaseException:
        # Invalid or interrupted copies are never published as checkpoints.
        shutil.rmtree(partial, ignore_errors=True)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true', help='Actually remove backups beyond the newest two')
    parser.add_argument('--backup-app', action='store_true', help='Copy and verify the installed bundle, then prune')
    parser.add_argument('--import-legacy', action='store_true', help='Move historical /Applications rollback bundles into the managed root (requires --apply)')
    parser.add_argument('--root', type=Path, default=DEFAULT_ROOT)
    args = parser.parse_args()
    if args.import_legacy and not args.apply:
        parser.error('--import-legacy requires --apply')
    if args.root.is_symlink():
        raise ValueError('The staging backup root must not be a symlink')
    args.root.mkdir(parents=True, exist_ok=True)
    require_posix('Staging retention locking')
    # Keep the lock outside WatchPaths, otherwise opening it can retrigger launchd.
    with (args.root.parent / f'.{args.root.name}.retention.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if args.import_legacy:
            print(json.dumps({'imported': import_legacy(args.root)}), flush=True)
        if args.backup_app:
            print(json.dumps({'created': str(backup(args.root))}))
        print(json.dumps(prune(args.root, args.apply or args.backup_app)))


if __name__ == '__main__':
    main()
