from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .catalog import CatalogCompiler, CatalogRepository, ROOT
from .execution import execute_argv
from .policy import PolicyEngine


def emit(payload: object) -> None:
    print(json.dumps(payload, ensure_ascii=False, indent=2))


def command_build(args: argparse.Namespace) -> int:
    result = CatalogCompiler(Path(args.root)).build(write_fragments=not args.no_fragments)
    emit(result)
    return 0 if result.get("ok") else 1


def command_validate(args: argparse.Namespace) -> int:
    result = CatalogCompiler(Path(args.root)).validate()
    emit(result)
    return 0 if result.get("ok") else 1


def command_describe(args: argparse.Namespace) -> int:
    repo = CatalogRepository(Path(args.root))
    spec = repo.spec(args.agent_id)
    if spec is None:
        emit({"ok": False, "error": "unknown_agent", "agentId": args.agent_id})
        return 2
    emit({"ok": True, "specHash": repo.spec_hash(args.agent_id), "agent": spec.model_dump(mode="json")})
    return 0


def command_doctor(args: argparse.Namespace) -> int:
    root = Path(args.root)
    compiler = CatalogCompiler(root)
    validation = compiler.validate()
    repo = CatalogRepository(root)
    entries = repo.manifest_entries()
    specs = repo.specs()
    result = {
        "ok": validation.get("ok") and len(entries) == len(specs),
        "status": "healthy" if validation.get("ok") and len(entries) == len(specs) else "degraded",
        "summary": f"ossctl doctor: manifest={len(entries)} specs={len(specs)} errors={validation.get('counts', {}).get('errors', 0)}",
        "counts": {"manifest": len(entries), "specs": len(specs), **validation.get("counts", {})},
        "validation": validation,
        "cache": repo.cache_state(),
    }
    emit(result)
    return 0 if result["ok"] else 1


def command_canary(args: argparse.Namespace) -> int:
    repo = CatalogRepository(Path(args.root))
    entry = repo.manifest_entries().get(args.agent_id)
    spec = repo.spec(args.agent_id)
    decision = PolicyEngine(args.policy_mode).evaluate(
        {"legacy_id": args.agent_id}, entry, spec, spec_hash=repo.spec_hash(args.agent_id)
    )
    payload = {"decision": decision.model_dump(mode="json")}
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
    parser.add_argument("--root", default=str(ROOT))
    sub = parser.add_subparsers(dest="command", required=True)

    catalog = sub.add_parser("catalog")
    catalog_sub = catalog.add_subparsers(dest="catalog_command", required=True)
    build = catalog_sub.add_parser("build")
    build.add_argument("--no-fragments", action="store_true")
    build.set_defaults(func=command_build)
    validate = catalog_sub.add_parser("validate")
    validate.set_defaults(func=command_validate)

    describe = sub.add_parser("describe")
    describe.add_argument("agent_id")
    describe.set_defaults(func=command_describe)

    doctor = sub.add_parser("doctor")
    doctor.set_defaults(func=command_doctor)

    canary = sub.add_parser("canary")
    canary.add_argument("agent_id")
    canary.add_argument("--execute", action="store_true")
    canary.add_argument("--policy-mode", choices=["shadow", "enforce"], default="shadow")
    canary.set_defaults(func=command_canary)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
