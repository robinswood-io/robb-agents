#!/usr/bin/env python3
"""Install/update only this user's Robb staging retention LaunchAgent."""
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import tempfile

LABEL = 'io.robinswood.robbagents.staging-retention'
LAUNCHCTL = Path('/bin/launchctl')


def require_darwin():
    if sys.platform != 'darwin':
        raise RuntimeError('Staging retention installation is only supported on macOS')


def atomic_copy(source, destination, mode):
    descriptor, temporary_name = tempfile.mkstemp(prefix=f'.{destination.name}.partial-', dir=destination.parent)
    os.close(descriptor)
    temporary = Path(temporary_name)
    try:
        shutil.copyfile(source, temporary)
        temporary.chmod(mode)
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)


def atomic_write_plist(configuration, destination):
    descriptor, temporary_name = tempfile.mkstemp(prefix=f'.{destination.name}.partial-', dir=destination.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, 'wb') as stream:
            plistlib.dump(configuration, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)


def install():
    require_darwin()
    support = Path.home() / 'Library/Application Support/Robb Agents/Maintenance'
    support.mkdir(parents=True, exist_ok=True)
    script = support / 'staging-retention.py'
    atomic_copy(Path(__file__).with_name('staging-retention.py'), script, 0o700)
    root = support.parent / 'Staging Backups'
    root.mkdir(parents=True, exist_ok=True)
    agents = Path.home() / 'Library/LaunchAgents'
    agents.mkdir(parents=True, exist_ok=True)
    plist = agents / f'{LABEL}.plist'
    configuration = {
        'Label': LABEL,
        'ProgramArguments': [sys.executable, str(script), '--apply'],
        'RunAtLoad': True,
        'StartInterval': 3600,
        'WatchPaths': [str(root)],
        'StandardOutPath': str(support / 'staging-retention.log'),
        'StandardErrorPath': str(support / 'staging-retention.err.log'),
    }
    atomic_write_plist(configuration, plist)
    target = f'gui/{os.getuid()}/{LABEL}'
    if subprocess.run([str(LAUNCHCTL), 'print', target], capture_output=True).returncode == 0:
        subprocess.run([str(LAUNCHCTL), 'bootout', target], check=True)
    subprocess.run([str(LAUNCHCTL), 'bootstrap', f'gui/{os.getuid()}', str(plist)], check=True)
    subprocess.run([str(LAUNCHCTL), 'print', target], check=True)


if __name__ == '__main__':
    install()
