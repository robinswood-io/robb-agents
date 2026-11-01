"""Validate TOML, offline SQLite datasets and static Make syntax without running recipes."""
from __future__ import annotations

import os
import re
import sqlite3
import subprocess
import tomllib
from pathlib import Path


def validate_toml(content: str) -> None:
    """The standard parser rejects duplicate definitions and invalid TOML types."""
    _ = tomllib.loads(content)


def authorize_sql(action: int, first: str | None, second: str | None,
                  _database: str | None, _trigger: str | None) -> int:
    if action in {sqlite3.SQLITE_ATTACH, sqlite3.SQLITE_DETACH, sqlite3.SQLITE_PRAGMA}:
        return sqlite3.SQLITE_DENY
    if action == sqlite3.SQLITE_FUNCTION and (second or first or '').lower() in {
        'load_extension', 'readfile', 'writefile',
    }:
        return sqlite3.SQLITE_DENY
    return sqlite3.SQLITE_OK


def validate_sql(content: str) -> None:
    """Resolve SQL tables, columns and expressions only in a bounded in-memory database."""
    connection = sqlite3.connect(':memory:')
    try:
        connection.set_authorizer(authorize_sql)
        # A report dataset must complete within this instruction budget.
        connection.set_progress_handler(lambda: 1, 1_000_000)
        _ = connection.executescript(content)
    finally:
        connection.close()


def validate_make(path: Path, content: str) -> None:
    """Ask GNU make to parse the repository's static dialect, never execute its recipes."""
    # Expansions/includes can execute code while parsing, even under --question.
    # New dynamic Make constructs therefore require an explicit validation design.
    if '$' in content or '\\\n' in content or re.search(
        r'^\s*(?:-?include|sinclude)\s', content, re.MULTILINE,
    ):
        raise ValueError('Make validation requires static content without expansions or includes')
    target = '__robb_quality_static__'
    if target in content:
        raise ValueError('Makefile uses the reserved validation target')
    result = subprocess.run(
        ['make', '-rRq', '--file', '-', '--eval', f'{target}: ;', target],
        input=content, cwd=path.parent, capture_output=True, text=True, check=False, timeout=10,
        env={'PATH': os.defpath},
    )
    if result.returncode not in {0, 1} or result.stderr.strip():
        raise ValueError(result.stderr.strip() or f'make exited with {result.returncode}')


def static_files(repo: Path) -> list[Path]:
    result = subprocess.run(
        ['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
        cwd=repo, capture_output=True, text=True, check=True,
    )
    return sorted({repo / name for name in result.stdout.split('\0') if name
                   and (Path(name).suffix in {'.toml', '.sql'} or Path(name).name == 'Makefile')
                   and (repo / name).is_file()})


def main() -> int:
    repo = Path(__file__).resolve().parent.parent
    files = static_files(repo)
    errors = 0
    for path in files:
        try:
            content = path.read_text(encoding='utf-8')
            if path.suffix == '.toml':
                validate_toml(content)
            elif path.suffix == '.sql':
                validate_sql(content)
            else:
                validate_make(path, content)
        except (OSError, ValueError, sqlite3.Error, subprocess.SubprocessError) as error:
            print(f'{path.relative_to(repo)}: {error}')
            errors += 1
    print(f'{len(files)} TOML/SQL/Make files; {errors} diagnostics')
    return int(errors > 0)


if __name__ == '__main__':
    raise SystemExit(main())
