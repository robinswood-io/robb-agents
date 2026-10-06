#!/usr/bin/env python3
"""Keep named private refs and their descendants out of unverified destinations.

This local pre-push control supplements server permissions. It does not make
already published code secret and cannot identify rebased/cherry-picked copies.
"""

from __future__ import annotations

import fnmatch
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import urlsplit


MANIFEST = Path(__file__).with_name("robinswood-private-boundary.json")
OBJECT_ID = re.compile(r"(?:[0-9a-f]{40}|[0-9a-f]{64})\Z")
REPOSITORY = re.compile(r"github\.com/[a-z0-9_.-]+/[a-z0-9_.-]+\Z")


class GuardError(Exception):
    pass


def command(args: list[str], *, cwd: Path, timeout: int = 30) -> str:
    env = {**os.environ, "GIT_NO_REPLACE_OBJECTS": "1"}
    try:
        result = subprocess.run(
            args, cwd=cwd, env=env, text=True, capture_output=True,
            check=False, timeout=timeout,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise GuardError(f"Impossible de vérifier {args[0]} ; push refusé.") from exc
    if result.returncode:
        # Do not echo subprocess output: a remote URL may contain credentials.
        raise GuardError(f"Échec du contrôle {args[0]} ; push refusé.")
    return result.stdout.strip()


def load_boundary(path: Path) -> dict:
    try:
        value = json.loads(path.read_text())
        if not isinstance(value, dict) or value.get("version") != 1:
            raise ValueError("version")
        repository = value["privateRepository"]
        patterns = value["privateRefPatterns"]
        roots = value["privateCommitRoots"]
        if not isinstance(repository, str) or not REPOSITORY.fullmatch(repository):
            raise ValueError("repository")
        if not isinstance(patterns, list) or not patterns or not all(
            isinstance(pattern, str) and pattern.startswith("refs/") for pattern in patterns
        ):
            raise ValueError("patterns")
        if not isinstance(roots, list) or not roots or not all(
            isinstance(root, str) and OBJECT_ID.fullmatch(root) for root in roots
        ):
            raise ValueError("roots")
        return value
    except (OSError, ValueError, KeyError, TypeError) as exc:
        raise GuardError("Manifeste de frontière absent ou invalide ; push refusé.") from exc


def github_repository(location: str) -> str | None:
    """Accept canonical HTTPS/SSH GitHub URLs, never host/path lookalikes."""
    scp = re.fullmatch(r"git@github\.com:([^?#]+)", location)
    if scp:
        path = scp.group(1)
    else:
        try:
            url = urlsplit(location)
            if url.hostname != "github.com" or url.query or url.fragment:
                return None
            if url.scheme == "https" and url.port in (None, 443):
                if url.username or url.password:
                    return None
            elif url.scheme == "ssh" and url.port in (None, 22):
                if url.username != "git" or url.password:
                    return None
            else:
                return None
            path = url.path.removeprefix("/")
        except ValueError:
            return None
    path = path.rstrip("/").removesuffix(".git").lower()
    repository = f"github.com/{path}"
    return repository if REPOSITORY.fullmatch(repository) else None


def verify_private_repository(repository: str, *, cwd: Path) -> None:
    slug = repository.removeprefix("github.com/")
    output = command(["gh", "api", "--hostname", "github.com", f"repos/{slug}"], cwd=cwd)
    try:
        data = json.loads(output)
        if (
            data.get("private") is not True
            or data.get("visibility") != "private"
            or str(data.get("full_name", "")).lower() != slug
        ):
            raise ValueError("not private")
    except (ValueError, AttributeError) as exc:
        raise GuardError("Destination privée non confirmée par GitHub ; push refusé.") from exc


def validate_push(location: str, records: str, *, cwd: Path, boundary: dict) -> None:
    updates: list[tuple[str, str, str]] = []
    for line in records.splitlines():
        fields = line.split()
        if len(fields) != 4 or not OBJECT_ID.fullmatch(fields[1]) or not OBJECT_ID.fullmatch(fields[3]):
            raise GuardError("Protocole pre-push invalide ; push refusé.")
        local_ref, local_sha, remote_ref, _remote_sha = fields
        if set(local_sha) == {"0"}:  # Deletion sends no content.
            continue
        updates.append((local_ref, local_sha, remote_ref))
    if not updates:
        return

    # Shallow/grafted histories can hide private parents. Replace refs are
    # disabled in command(), including for annotated tag peeling.
    if command(["git", "rev-parse", "--is-shallow-repository"], cwd=cwd) != "false":
        raise GuardError("Historique incomplet ; impossible de vérifier les ancêtres privés.")
    grafts = Path(command(["git", "rev-parse", "--git-path", "info/grafts"], cwd=cwd))
    if not grafts.is_absolute():
        grafts = cwd / grafts
    if grafts.exists() and grafts.stat().st_size:
        raise GuardError("Historique réécrit par grafts ; push refusé.")

    private = False
    checked: dict[str, bool] = {}
    for local_ref, local_sha, remote_ref in updates:
        private |= any(
            fnmatch.fnmatchcase(ref, pattern)
            for ref in (local_ref, remote_ref)
            for pattern in boundary["privateRefPatterns"]
        )
        if local_sha not in checked:
            # rev-list walks the entire, non-shallow ancestry and fails if a
            # parent is unavailable. A private root need not exist in a public
            # clone: its absence from this complete list proves non-ancestry.
            commit = command(["git", "rev-parse", "--verify", f"{local_sha}^{{commit}}"], cwd=cwd)
            ancestors = set(command(["git", "rev-list", commit], cwd=cwd).splitlines())
            checked[local_sha] = bool(ancestors.intersection(boundary["privateCommitRoots"]))
        private |= checked[local_sha]

    if not private:
        return
    if github_repository(location) != boundary["privateRepository"]:
        raise GuardError("Ref ou ancêtre privé détecté : seul le dépôt privé autorisé peut recevoir ce push.")
    verify_private_repository(boundary["privateRepository"], cwd=cwd)


def main() -> int:
    try:
        if len(sys.argv) != 3:
            raise GuardError("Usage : garde pre-push <remote> <destination>.")
        validate_push(sys.argv[2], sys.stdin.read(), cwd=Path.cwd(), boundary=load_boundary(MANIFEST))
        return 0
    except GuardError as exc:
        print(f"Robinswood : {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
