#!/usr/bin/env python3
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path("/srv/rbw-agents-oss")
sys.path.insert(0, str(ROOT / "packages"))
sys.path.insert(0, str(ROOT / "scripts"))

from lib.agent_runtime import OPS, run_context, stage, standard_report, write_report_and_history
from rbw_agent_runtime.catalog import CatalogCompiler

OUT_JSON = OPS / "oss-architecture-v2-catalog-last.json"
OUT_MD = OPS / "oss-architecture-v2-catalog-last.md"
HISTORY = OPS / "oss-architecture-v2-catalog-history.jsonl"


def main() -> None:
    with run_context("oss-architecture-v2-catalog", budget_seconds=120) as ctx:
        compiler = CatalogCompiler(ROOT)
        with stage(ctx, "compile"):
            built = compiler.build(write_fragments=True)
        with stage(ctx, "validate"):
            validation = compiler.validate()
        ok = bool(built.get("ok")) and bool(validation.get("ok"))
        counts = {
            **(built.get("counts") or {}),
            "validationErrors": (validation.get("counts") or {}).get("errors", 0),
        }
        blocking = list(validation.get("errors") or [])
        report = standard_report(
            capability_id="oss-architecture-v2-catalog",
            ok=ok,
            status="processed" if ok else "blocked",
            summary=f"architecture_v2_catalog: agents={counts.get('agents', 0)} cards={counts.get('cards', 0)} argv={counts.get('argv', 0)} legacy={counts.get('legacyShell', 0)} errors={counts.get('validationErrors', 0)}",
            counts=counts,
            blocking_reasons=blocking,
            warning_reasons=[],
            artifacts={**(built.get("artifacts") or {}), "reportJson": str(OUT_JSON), "reportMd": str(OUT_MD), "historyJsonl": str(HISTORY)},
            checks={"stageTimings": ctx["stageTimings"], "validation": validation},
            data={"build": built},
            updated_by="oss-architecture-v2-catalog",
        )
        write_report_and_history(OUT_JSON, HISTORY, report)
        OUT_MD.write_text(
            "# OSS Architecture v2 Catalog\n\n"
            f"- status: {report['status']}\n"
            f"- agents: {counts.get('agents', 0)}\n"
            f"- cards: {counts.get('cards', 0)}\n"
            f"- argv / legacy: {counts.get('argv', 0)} / {counts.get('legacyShell', 0)}\n"
            f"- validation errors: {counts.get('validationErrors', 0)}\n",
            encoding="utf-8",
        )
        print(json.dumps({"ok": report["ok"], "status": report["status"], "summary": report["summary"], "counts": counts, "reportJson": str(OUT_JSON)}, ensure_ascii=False))
        raise SystemExit(0 if ok else 1)


if __name__ == "__main__":
    main()
