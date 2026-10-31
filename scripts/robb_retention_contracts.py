"""Static contracts for the standalone retention CLI; no installed runtime dependency."""
from argparse import Namespace
from pathlib import Path
from typing import TypedDict


class Checkpoint(TypedDict):
    path: Path
    created: float
    identity: tuple[int, int]
class ValidationManifest(TypedDict):
    contract: str
    fingerprint: dict[str, str]
class PruneResult(TypedDict):
    kept: list[str]
    removed: list[str]
    apply: bool
class ScratchItem(TypedDict):
    session: str
    name: str
    sizeMb: int
    ageDays: int
class ScratchResult(TypedDict):
    scannedSessions: int
    prunedCount: int
    freedBytes: int
    freedMb: int
    apply: bool
    items: list[ScratchItem]
class RetentionArguments(Namespace):
    apply: bool = False
    backup_app: bool = False
    no_prune: bool = False
    hold_created: bool = False
    defer_strong_validation: bool = False
    import_legacy: bool = False
    prune_session_scratch: bool = False
    scratch_min_size_mb: int = 0
    scratch_max_age_days: int = 0
    workspaces_root: Path = Path()
    root: Path = Path()
