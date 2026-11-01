from __future__ import annotations

import argparse
import json
from collections.abc import Callable
from pathlib import Path
from typing import Literal

from pydantic import JsonValue

from .catalog import ROOT, CatalogCompiler, CatalogRepository
from .execution import execute_argv
from .json_support import JSON_VALUE_ADAPTER, _is_json_object
from .policy import PolicyEngine


class CLIArguments(argparse.Namespace):
    def __init__(self) -> None:
        super().__init__()
        self.root: str = str(ROOT)
        self.command: str = ""
        self.catalog_command: str | None = None
        self.no_fragments: bool = False
        self.agent_id: str = ""
        self.execute: bool = False
        self.policy_mode: Literal["shadow", "enforce"] = "shadow"
        self.func: Callable[[CLIArguments], int] | None = None


def emit(payload: object) -> None:
    print(json.dumps(payload, ensure_ascii=False, indent=2))


def command_build(args: CLIArguments) -> int:
    result = CatalogCompiler(Path(args.root)).build(write_fragments=not args.no_fragments)
    emit(result)
    return 0 if result.get("ok") else 1


def command_validate(args: CLIArguments) -> int:
    result = CatalogCompiler(Path(args.root)).validate()
    emit(result)
    return 0 if result.get("ok") else 1


def command_describe(args: CLIArguments) -> int:
    repo = CatalogRepository(Path(args.root))
    spec = repo.spec(args.agent_id)
    if spec is None:
        emit({"ok": False, "error": "unknown_agent", "agentId": args.agent_id})
        return 2
    emit({"ok": True, "specHash": repo.spec_hash(args.agent_id), "agent": spec.model_dump(mode="json")})
    return 0


def command_doctor(args: CLIArguments) -> int:
    root = Path(args.root)
    compiler = CatalogCompiler(root)
    validation = compiler.validate()
    repo = CatalogRepository(root)
    entries = repo.manifest_entries()
    specs = repo.specs()
    validation_counts = validation.get("counts", {})
    counts = validation_counts if _is_json_object(validation_counts) else {}
    validation_ok = bool(validation.get("ok"))
    result: dict[str, JsonValue] = {
        "ok": validation_ok and len(entries) == len(specs),
        "status": "healthy" if validation_ok and len(entries) == len(specs) else "degraded",
        "summary": f"ossctl doctor: manifest={len(entries)} specs={len(specs)} errors={counts.get('errors', 0)}",
        "counts": {"manifest": len(entries), "specs": len(specs), **counts},
        "validation": validation,
        "cache": repo.cache_state(),
    }
    emit(result)
    return 0 if result["ok"] else 1


def command_canary(args: CLIArguments) -> int:
    repo = CatalogRepository(Path(args.root))
    entry = repo.manifest_entries().get(args.agent_id)
    spec = repo.spec(args.agent_id)
    decision = PolicyEngine(args.policy_mode).evaluate(
        {"legacy_id": args.agent_id}, entry, spec, spec_hash=repo.spec_hash(args.agent_id)
    )
    payload: dict[str, JsonValue] = {"decision": JSON_VALUE_ADAPTER.validate_json(decision.model_dump_json())}
    if args.execute:
        if spec is None or spec.execution.backend.value != "argv":
            payload.update({"ok": False, "error": "canary_execute_requires_argv_agent"})
            emit(payload)
            return 2
        if spec.risk_class.lower().startswith("high") or any("external" in effect or "financial" in effect or "crm" in effect for effect in spec.side_effects):
            payload.update({"ok": False, "error": "canary_execute_forbidden_for_risky_agent"})
            emit(payload)
            return 3
        result = execute_argv(decision)
        payload.update({"ok": bool(result.get("ok")), "execution": result})
        emit(payload)
        return 0 if result.get("ok") else 1
    payload.update({"ok": decision.allowed, "dryRun": True})
    emit(payload)
    return 0 if decision.allowed else 1


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="ossctl", description="RBW OSS Agent Runtime v2 control CLI")
    _ = parser.add_argument("--root", default=str(ROOT))
    sub = parser.add_subparsers(dest="command", required=True)

    catalog = sub.add_parser("catalog")
    catalog_sub = catalog.add_subparsers(dest="catalog_command", required=True)
    build = catalog_sub.add_parser("build")
    _ = build.add_argument("--no-fragments", action="store_true")
    build.set_defaults(func=command_build)
    validate = catalog_sub.add_parser("validate")
    validate.set_defaults(func=command_validate)

    describe = sub.add_parser("describe")
    _ = describe.add_argument("agent_id")
    describe.set_defaults(func=command_describe)

    doctor = sub.add_parser("doctor")
    doctor.set_defaults(func=command_doctor)

    canary = sub.add_parser("canary")
    _ = canary.add_argument("agent_id")
    _ = canary.add_argument("--execute", action="store_true")
    _ = canary.add_argument("--policy-mode", choices=["shadow", "enforce"], default="shadow")
    canary.set_defaults(func=command_canary)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv, namespace=CLIArguments())
    if args.func is None:
        parser.error("a command is required")
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
