#!/usr/bin/env python3
"""Robinswood fork lightweight validation.

This intentionally avoids installing the full JS workspace so the private fork
has a stable baseline even when upstream's heavier CI is temporarily broken.
"""
from __future__ import annotations

import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]


def fail(message: str) -> None:
    print(f"::error::{message}")
    raise SystemExit(1)


def check_windows_filenames() -> None:
    illegal = re.compile(r'[<>:"|?*]')
    bad: list[str] = []
    for path in ROOT.rglob("*"):
        if ".git" in path.parts:
            continue
        rel = path.relative_to(ROOT).as_posix()
        if any(illegal.search(part) for part in path.relative_to(ROOT).parts):
            bad.append(rel)
    if bad:
        fail("Windows-illegal filenames found:\n" + "\n".join(bad[:50]))
    print("✓ Windows filename check")


def load_json(path: pathlib.Path) -> dict[str, str]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001 - validation script
        fail(f"Failed to read JSON {path.relative_to(ROOT)}: {exc}")
    if not isinstance(data, dict):
        fail(f"Expected object in {path.relative_to(ROOT)}")
    invalid = [key for key, value in data.items() if not isinstance(key, str) or not isinstance(value, str)]
    if invalid:
        fail(f"Invalid i18n entries in {path.relative_to(ROOT)}: {invalid[:10]}")
    return data


def check_french_locale() -> None:
    locales = ROOT / "packages" / "shared" / "src" / "i18n" / "locales"
    en = load_json(locales / "en.json")
    fr = load_json(locales / "fr.json")
    missing = sorted(set(en) - set(fr))
    extra = sorted(set(fr) - set(en))
    if missing or extra:
        details = []
        if missing:
            details.append("missing: " + ", ".join(missing[:20]))
        if extra:
            details.append("extra: " + ", ".join(extra[:20]))
        fail("French locale key parity failed — " + " | ".join(details))

    registry = (ROOT / "packages" / "shared" / "src" / "i18n" / "registry.ts").read_text(encoding="utf-8")
    required = ["frMessages", "frDateLocale", 'fr: { nativeName: "Français"']
    missing_registry = [token for token in required if token not in registry]
    if missing_registry:
        fail("French locale registry tokens missing: " + ", ".join(missing_registry))
    print(f"✓ French locale parity ({len(fr)} keys)")


def check_french_default() -> None:
    setup_path = ROOT / "packages" / "shared" / "src" / "i18n" / "setupI18n.ts"
    setup = setup_path.read_text(encoding="utf-8")
    required = [
        'export const DEFAULT_UI_LANGUAGE = "fr"',
        'fallbackLng: DEFAULT_UI_LANGUAGE',
        'order: ["localStorage"]',
    ]
    missing = [token for token in required if token not in setup]
    if missing:
        fail("French-first i18n defaults missing from setupI18n.ts: " + ", ".join(missing))
    print("✓ French-first UI default")


def check_robinswood_docs() -> None:
    required = [
        ROOT / "docs" / "robinswood" / "README.md",
        ROOT / "docs" / "robinswood" / "technical-spike-router.md",
        ROOT / "docs" / "robinswood" / "rebrand-inventory.md",
        ROOT / "docs" / "robinswood" / "provider-playbook.md",
        ROOT / "docs" / "robinswood" / "routing-policy.example.json",
    ]
    missing = [path.relative_to(ROOT).as_posix() for path in required if not path.exists()]
    if missing:
        fail("Missing Robinswood documentation files: " + ", ".join(missing))
    try:
        example = json.loads((ROOT / "docs" / "robinswood" / "routing-policy.example.json").read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001 - validation script
        fail(f"Failed to read routing-policy.example.json: {exc}")
    if example.get("version") != 1 or not isinstance(example.get("rules"), list):
        fail("routing-policy.example.json must include version: 1 and a rules array")
    print("✓ Robinswood memory docs")


def main() -> None:
    check_windows_filenames()
    check_french_locale()
    check_french_default()
    check_robinswood_docs()
    print("Robinswood lightweight validation passed")


if __name__ == "__main__":
    main()
