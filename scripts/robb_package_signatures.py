"""Native macOS package signature validation."""
from __future__ import annotations

import pathlib
import sys


def fail(message: str) -> None:
    print(f"::error::{message}", file=sys.stderr)
    raise SystemExit(1)



def validate_codesign_inspection(
    returncode: int,
    code_text: str,
    *,
    require_release_signing: bool,
) -> str:
    """Validate codesign metadata and return the observed signing mode.

    Cross-architecture macOS test builds can be genuinely unsigned instead of
    receiving electron-builder's host-architecture ad-hoc signature. That is
    acceptable only for the explicitly unsigned smoke-build path. Stable
    release validation remains fail-closed and requires Developer ID metadata.
    """
    if returncode != 0:
        is_unsigned = "code object is not signed at all" in code_text
        if is_unsigned and not require_release_signing:
            return "unsigned"
        fail(f"codesign inspection failed: {code_text}")

    is_adhoc = "Signature=adhoc" in code_text or "TeamIdentifier=not set" in code_text
    if is_adhoc:
        if require_release_signing:
            fail("Release validation requires a Developer ID signature, but the packaged app is ad-hoc signed")
        return "adhoc"

    if "Identifier=io.robinswood.robbagents" not in code_text:
        fail("Packaged app signature does not expose io.robinswood.robbagents identifier")

    has_developer_id = "Authority=Developer ID Application:" in code_text
    if require_release_signing and not has_developer_id:
        fail("Release validation requires an Apple Developer ID Application signature")

    return "developer-id" if has_developer_id else "signed"



def codesign_inspection_command(app_dir: pathlib.Path) -> list[str]:
    """Request the full certificate chain used by release validation."""
    return ["codesign", "-dv", "--verbose=4", str(app_dir)]



def validate_release_verification_results(
    codesign_returncode: int,
    codesign_text: str,
    gatekeeper_returncode: int,
    gatekeeper_text: str,
    stapler_returncode: int,
    stapler_text: str,
) -> None:
    """Validate release command results without requiring a real certificate in tests."""
    if codesign_returncode != 0:
        fail(f"Developer ID signature verification failed: {codesign_text}")
    if gatekeeper_returncode != 0 or "Notarized Developer ID" not in gatekeeper_text:
        fail(f"Notarization assessment failed: {gatekeeper_text}")
    if stapler_returncode != 0:
        fail(f"Notarization ticket validation failed: {stapler_text}")
