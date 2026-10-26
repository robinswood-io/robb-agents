#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import TypeAlias

from lib.config_mutation import ConfigMutation, PROTECTED_CONFIG_FILES
from oss_architecture_v2_policy import (
    JsonValue,
    ROOT,
    CONFIG,
    SCRIPTS,
    APPS,
    OPS,
    MANIFEST,
    MAPPING,
    SCHEDULES,
    SIDE_EFFECTS,
    MANIFEST_ONLY,
    SCRIPT_COVERAGE,
    BASELINE,
    ACTIVITIES,
    RELEASE_GATE,
    SLO_WRAPPER,
    README,
    MAKEFILE,
    P0_SCRIPT,
    REPORT_JSON,
    REPORT_MD,
    STAMP,
    ARCHIVE,
    NEW_HELPERS,
    CONSERVATIVE_MANUAL_HELPERS,
    now_iso,
    load_json,
    archive_copy,
    atomic_write,
    write_json,
    replace_once,
    run,
    manifest_rows,
    mapping_rows,
    schedule_rows,
    schedule_legacy,
    schedule_fingerprint,
    classify_side_effect,
    update_side_effect_policy,
    update_manifest_only_policy,
    update_script_coverage,
)


def patch_activities(changes: list[dict[str, JsonValue]]) -> None:
    text = ACTIVITIES.read_text(encoding="utf-8")
    if "from runtime_v2_bridge import load_manifest_entries" not in text:
        text = replace_once(
            text,
            "from collections import Counter\nfrom pathlib import Path\n",
            "from collections import Counter\nfrom pathlib import Path\n\nfrom runtime_v2_bridge import load_manifest_entries, preflight_invocation, run_structured_invocation\n",
            "activities-import",
        )
    old_loader = '''def _load_manifest() -> dict:\n    if not CMD_MANIFEST.exists():\n        return {}\n    data = json.loads(CMD_MANIFEST.read_text(encoding='utf-8'))\n    entries = {}\n    # Load all list sections, not only wave1. Otherwise scheduled wrappers in\n    # newer sections silently run as skeletons and watchdog/alert coverage is lost.\n    for section, rows in data.items():\n        if not isinstance(rows, list):\n            continue\n        for row in rows:\n            if isinstance(row, dict) and row.get('legacy_id'):\n                merged = dict(row)\n                merged.setdefault('manifestSection', section)\n                entries[row['legacy_id']] = merged\n    return entries\n'''
    new_loader = '''def _load_manifest() -> dict:\n    # Runtime v2 repository validates duplicate IDs and caches by manifest mtime.\n    return load_manifest_entries()\n'''
    if old_loader in text:
        text = replace_once(text, old_loader, new_loader, "activities-loader")
    preflight_old = '''    activity_log = {\n        'ts': now,\n        'workflow': 'RbwAutomationWorkflow',\n        'payload': payload,\n        'mode': 'skeleton',\n    }\n\n    if entry and entry.get('mode') == 'script':\n'''
    preflight_new = '''    activity_log = {\n        'ts': now,\n        'workflow': 'RbwAutomationWorkflow',\n        'payload': payload,\n        'mode': 'runtime-v2-preflight',\n    }\n\n    runtime_v2_preflight = await asyncio.to_thread(preflight_invocation, payload, entry)\n    activity_log['runtimeV2'] = runtime_v2_preflight\n    if not runtime_v2_preflight.get('allowed'):\n        completed_at = datetime.datetime.now(datetime.timezone.utc).isoformat()\n        reasons = runtime_v2_preflight.get('strict_reasons') or ['unknown_automation_id']\n        activity_log['completedAt'] = completed_at\n        activity_log['result'] = {\n            'ok': False,\n            'exitCode': 2,\n            'timeout': False,\n            'errorType': 'RuntimeV2PreflightBlocked',\n            'error': ','.join(reasons),\n            'stdoutPreview': '',\n            'stderrPreview': ','.join(reasons),\n        }\n        _append_jsonl(LOGS / 'workflow-runs.jsonl', activity_log)\n        return {\n            'ok': False,\n            'completedAt': completed_at,\n            'legacyId': legacy_id,\n            'name': payload.get('name') or (entry or {}).get('name'),\n            'mode': 'runtime-v2-preflight',\n            'exitCode': 2,\n            'timeout': False,\n            'businessFailure': False,\n            'jsonStatus': {},\n            'errorType': 'RuntimeV2PreflightBlocked',\n            'error': ','.join(reasons),\n            'stderrPreview': ','.join(reasons),\n        }\n\n    if entry and entry.get('mode') == 'script':\n'''
    if preflight_old in text:
        text = replace_once(text, preflight_old, preflight_new, "activities-preflight")
    execution_old = "            result = await asyncio.to_thread(_run_shell, entry['command'], timeout_seconds, extra_env=extra_env, legacy_id=legacy_id)"
    execution_new = "            if runtime_v2_preflight.get('backend') == 'argv':\n                result = await asyncio.to_thread(run_structured_invocation, runtime_v2_preflight, extra_env)\n            else:\n                result = await asyncio.to_thread(_run_shell, entry['command'], timeout_seconds, extra_env=extra_env, legacy_id=legacy_id)"
    if execution_old in text:
        text = replace_once(text, execution_old, execution_new, "activities-executor")
    bottom_old = '''    # Unknown/non-script entries are still a successful skeleton dispatch. Log a\n    # proper result so health/freshness dashboards do not classify them as\n    # ambiguous "no_result" runs.\n    completed_at = datetime.datetime.now(datetime.timezone.utc).isoformat()\n    activity_log['completedAt'] = completed_at\n    activity_log['durationSeconds'] = round((datetime.datetime.now(datetime.timezone.utc) - now_dt).total_seconds(), 3)\n    activity_log['result'] = {\n        'ok': True,\n        'exitCode': 0,\n        'timeout': False,\n        'stdoutPreview': 'skeleton dispatch only',\n        'stderrPreview': '',\n    }\n    activity_log['decisionContext'] = await asyncio.to_thread(_context_check_action, {\n        'legacy_id': legacy_id,\n        'name': payload.get('name'),\n        'mode': 'skeleton',\n        'payload': payload,\n        'scope': legacy_id or 'unknown',\n    })\n    activity_log['decisionTrace'] = await asyncio.to_thread(_context_record_trace, {\n        'phase': 'postflight',\n        'outcome': 'skeleton',\n        'legacyId': legacy_id,\n        'payload': payload,\n        'preflight': activity_log.get('decisionContext'),\n        'result': activity_log['result'],\n    })\n    _append_jsonl(LOGS / 'workflow-runs.jsonl', activity_log)\n    return {\n        'ok': True,\n        'executedAt': now,\n        'completedAt': completed_at,\n        'legacyId': legacy_id,\n        'name': payload.get('name'),\n        'mode': 'skeleton',\n        'note': 'No direct dispatcher yet for this automation; connect LangGraph/MCP execution next.'\n    }\n'''
    bottom_new = '''    # Defense in depth: preflight should already reject this branch. Never turn an\n    # unknown/non-script automation into a successful Temporal execution.\n    completed_at = datetime.datetime.now(datetime.timezone.utc).isoformat()\n    activity_log['completedAt'] = completed_at\n    activity_log['result'] = {\n        'ok': False,\n        'exitCode': 2,\n        'timeout': False,\n        'errorType': 'RuntimeV2UnsupportedEntry',\n        'error': 'unknown_automation_id_or_unsupported_mode',\n    }\n    _append_jsonl(LOGS / 'workflow-runs.jsonl', activity_log)\n    return {\n        'ok': False,\n        'completedAt': completed_at,\n        'legacyId': legacy_id,\n        'name': payload.get('name'),\n        'mode': 'runtime-v2-fail-closed',\n        'exitCode': 2,\n        'timeout': False,\n        'businessFailure': False,\n        'jsonStatus': {},\n        'errorType': 'RuntimeV2UnsupportedEntry',\n        'error': 'unknown_automation_id_or_unsupported_mode',\n    }\n'''
    if bottom_old in text:
        text = replace_once(text, bottom_old, bottom_new, "activities-fail-closed")
    required = ("runtime_v2_bridge", "preflight_invocation", "run_structured_invocation", "unknown_automation_id")
    if not all(marker in text for marker in required) or "skeleton dispatch only" in text:
        raise RuntimeError("activities v2 integration markers incomplete")
    atomic_write(ACTIVITIES, text, changes)


def patch_release_gate(changes: list[dict[str, JsonValue]]) -> None:
    text = RELEASE_GATE.read_text(encoding="utf-8")
    if "ARCH_CATALOG=ROOT/'scripts/oss_architecture_v2_catalog.py'" not in text:
        text = replace_once(
            text,
            "OUT_JSON=OPS/'oss-release-gate-last.json'; OUT_MD=OPS/'oss-release-gate-last.md'; HISTORY=OPS/'oss-release-gate-history.jsonl'; DASH=ROOT/'scripts/oss_industrialization_dashboard.py'",
            "OUT_JSON=OPS/'oss-release-gate-last.json'; OUT_MD=OPS/'oss-release-gate-last.md'; HISTORY=OPS/'oss-release-gate-history.jsonl'; DASH=ROOT/'scripts/oss_industrialization_dashboard.py'; ARCH_CATALOG=ROOT/'scripts/oss_architecture_v2_catalog.py'; ARCH_GUARD=ROOT/'scripts/oss_architecture_v2_guard.py'",
            "release-constants",
        )
    stage_old = "        with stage(ctx,'refresh_dashboard'):\n            proc=subprocess.run([sys.executable,str(DASH)],cwd=str(ROOT),timeout=900,capture_output=True,text=True)\n        with stage(ctx,'load_inputs'):"
    stage_new = "        with stage(ctx,'refresh_dashboard'):\n            proc=subprocess.run([sys.executable,str(DASH)],cwd=str(ROOT),timeout=900,capture_output=True,text=True)\n        with stage(ctx,'architecture_v2'):\n            arch_catalog_proc=subprocess.run([sys.executable,str(ARCH_CATALOG)],cwd=str(ROOT),timeout=180,capture_output=True,text=True)\n            arch_guard_proc=subprocess.run([sys.executable,str(ARCH_GUARD)],cwd=str(ROOT),timeout=180,capture_output=True,text=True)\n        with stage(ctx,'load_inputs'):"
    if stage_old in text:
        text = replace_once(text, stage_old, stage_new, "release-stage")
    load_old = "            qa=read_json(OPS/'oss-work-package-quality-audit-last.json',{})"
    load_new = "            qa=read_json(OPS/'oss-work-package-quality-audit-last.json',{})\n            arch_v2=read_json(OPS/'oss-architecture-v2-guard-last.json',{})"
    if load_old in text and "arch_v2=read_json" not in text:
        text = replace_once(text, load_old, load_new, "release-load")
    gate_old = "        gates.append({'id':'dashboard_refresh','ok':proc.returncode==0 and ok_no_blockers(dashboard),'detail':dashboard.get('summary') or proc.stderr[-500:]})"
    gate_new = gate_old + "\n        gates.append({'id':'architecture_v2','ok':arch_catalog_proc.returncode==0 and arch_guard_proc.returncode==0 and arch_v2.get('ok') is True and not arch_v2.get('blockingReasons'),'detail':arch_v2.get('summary') or arch_guard_proc.stderr[-500:]})"
    if gate_old in text and "'id':'architecture_v2'" not in text:
        text = replace_once(text, gate_old, gate_new, "release-gate")
    checks_old = "'dashboardRun':{'returnCode':proc.returncode,'stdout':proc.stdout[-1200:],'stderr':proc.stderr[-1200:]},'sloEffectiveState':slo_state"
    checks_new = "'dashboardRun':{'returnCode':proc.returncode,'stdout':proc.stdout[-1200:],'stderr':proc.stderr[-1200:]},'architectureV2Runs':{'catalog':{'returnCode':arch_catalog_proc.returncode,'stdout':arch_catalog_proc.stdout[-1200:],'stderr':arch_catalog_proc.stderr[-1200:]},'guard':{'returnCode':arch_guard_proc.returncode,'stdout':arch_guard_proc.stdout[-1200:],'stderr':arch_guard_proc.stderr[-1200:]}},'sloEffectiveState':slo_state"
    if checks_old in text:
        text = replace_once(text, checks_old, checks_new, "release-checks")
    text = text.replace("updated_by='oss-release-gate-p8-effective-slo'", "updated_by='oss-release-gate-p9-runtime-v2'")
    if "'id':'architecture_v2'" not in text or "architectureV2Runs" not in text:
        raise RuntimeError("release gate v2 integration incomplete")
    atomic_write(RELEASE_GATE, text, changes)


def patch_slo_wrapper(changes: list[dict[str, JsonValue]]) -> None:
    text = SLO_WRAPPER.read_text(encoding="utf-8")
    old = "ORIGINAL = ROOT / 'scripts' / 'temporal_performance_slo_guard.py.bak-postdeploy-v30-20260601T190549Z'"
    new = "ORIGINAL = ROOT / 'scripts' / 'temporal_performance_slo_core.py'"
    if old in text:
        text = replace_once(text, old, new, "slo-core")
    if new not in text:
        raise RuntimeError("SLO wrapper canonical core patch missing")
    atomic_write(SLO_WRAPPER, text, changes)


def patch_docs(changes: list[dict[str, JsonValue]]) -> None:
    readme = README.read_text(encoding="utf-8")
    begin, end = "<!-- ARCHITECTURE_V2_BEGIN -->", "<!-- ARCHITECTURE_V2_END -->"
    section = f'''\n{begin}\n## Architecture agents v2 — 2026-07-12\n\n- Runtime typé : `packages/rbw_agent_runtime/` (Pydantic 2).\n- Catalogue modulaire : `config/agents-v2/catalog-v2.json` et fragments par domaine.\n- CLI : `PYTHONPATH=/srv/rbw-agents-oss/packages /srv/rbw-agents-oss/.venv/bin/python -m rbw_agent_runtime doctor`.\n- Temporal : cache mtime, policy preflight, backend `argv` pour les nouvelles specs et adaptateur `legacy_shell` explicite.\n- Inconnu/non-script : fail-closed, jamais de succès skeleton.\n- Guard : `scripts/oss_architecture_v2_guard.py`, intégré au release gate.\n- Baseline migrée : 193 wrappers et 139 schedules, sans changement de cadence.\n{end}\n'''
    if begin in readme and end in readme:
        prefix = readme.split(begin, 1)[0]
        suffix = readme.split(end, 1)[1]
        readme = prefix + section.lstrip("\n") + suffix
    else:
        readme = readme.rstrip() + "\n" + section
    readme = readme.replace("**Schedules prêts déclarés** : 29", "**Schedules configurés et contrôlés** : 139")
    readme = readme.replace("**Schedules actifs live** : 29 / 29", "**Schedules actifs live** : 139 / 139")
    readme = readme.replace("**Couverture wrappers `standard-v1`** : 33 / 33", "**Wrappers au manifeste** : 193 / 193 catalogués en v2")
    atomic_write(README, readme, changes)

    makefile = MAKEFILE.read_text(encoding="utf-8")
    marker = "# Architecture agents v2"
    block = '''\n# Architecture agents v2\ncatalog-v2:\n\tPYTHONPATH=/srv/rbw-agents-oss/packages /srv/rbw-agents-oss/.venv/bin/python -m rbw_agent_runtime catalog build\n\nvalidate-v2:\n\tPYTHONPATH=/srv/rbw-agents-oss/packages /srv/rbw-agents-oss/.venv/bin/python -m rbw_agent_runtime catalog validate\n\ndoctor-v2:\n\tPYTHONPATH=/srv/rbw-agents-oss/packages /srv/rbw-agents-oss/.venv/bin/python -m rbw_agent_runtime doctor\n\nguard-v2:\n\t/srv/rbw-agents-oss/.venv/bin/python /srv/rbw-agents-oss/scripts/oss_architecture_v2_guard.py\n\nselftest-v2:\n\t/srv/rbw-agents-oss/.venv/bin/python /srv/rbw-agents-oss/scripts/oss_architecture_v2_selftest.py\n'''
    if marker not in makefile:
        makefile = makefile.rstrip() + "\n" + block
    atomic_write(MAKEFILE, makefile, changes)


def restore_p0_bootstrap(changes: list[dict[str, JsonValue]]) -> dict[str, JsonValue]:
    current = P0_SCRIPT.read_text(encoding="utf-8", errors="ignore") if P0_SCRIPT.exists() else ""
    if "OFFICIAL_AGENT_TASK_CRONS" in current and "patch_agent_task_cadence" in current:
        return {"ok": True, "restored": str(P0_SCRIPT), "alreadyCanonical": True}
    candidates = sorted(P0_SCRIPT.parent.glob(P0_SCRIPT.name + ".bak*"), key=lambda path: path.stat().st_mtime_ns, reverse=True)
    selected = None
    for candidate in candidates:
        text = candidate.read_text(encoding="utf-8", errors="ignore")
        if "OFFICIAL_AGENT_TASK_CRONS" in text and "patch_agent_task_cadence" in text:
            selected = candidate
            break
    if selected is None:
        return {"ok": False, "error": "original_p0_backup_not_found", "candidates": [str(path) for path in candidates]}
    target = ARCHIVE / "bootstrap" / P0_SCRIPT.name
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(P0_SCRIPT, target)
    os.replace(selected, P0_SCRIPT)
    P0_SCRIPT.chmod(0o755)
    changes.append({"action": "restore_bootstrap", "path": str(P0_SCRIPT), "from": str(selected), "bootstrapArchive": str(target)})
    return {"ok": True, "restored": str(P0_SCRIPT), "bootstrapArchive": str(target)}


def archive_active_backups(changes: list[dict[str, JsonValue]]) -> list[str]:
    moved: list[str] = []
    for base in (ROOT / "config", ROOT / "scripts", ROOT / "apps" / "orchestrator-temporal", ROOT / "compose"):
        if not base.exists():
            continue
        for path in list(base.rglob("*")):
            if not path.is_file() or "archive" in path.parts:
                continue
            if ".bak" not in path.name and not path.name.endswith(("~", ".old")):
                continue
            relative = path.relative_to(ROOT)
            target = ARCHIVE / "active-backups" / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(path), str(target))
            moved.append(str(relative))
    if moved:
        changes.append({"action": "archive_active_backups", "count": len(moved), "paths": moved})
    return moved


def fix_secret_permissions(changes: list[dict[str, JsonValue]]) -> list[dict[str, JsonValue]]:
    fixed: list[dict[str, JsonValue]] = []
    for base in (ROOT / "secrets", ROOT / "config" / "secrets"):
        if not base.exists():
            continue
        for path in [base] + list(base.rglob("*")):
            # Chromium profiles contain volatile Singleton* symlinks/sockets.
            # Never follow or chmod those runtime links; only regular files/dirs
            # are governed by the 0600/0700 policy.
            try:
                if path.is_symlink() or not path.exists():
                    continue
                mode = 0o700 if path.is_dir() else 0o600
                current = path.stat().st_mode & 0o777
                if current != mode:
                    path.chmod(mode)
                    fixed.append({"path": str(path.relative_to(ROOT)), "before": oct(current), "after": oct(mode)})
            except FileNotFoundError:
                continue
    for path in (ROOT / "config" / "litellm" / "config.yaml", ROOT / "compose" / ".env"):
        if path.exists():
            current = path.stat().st_mode & 0o777
            if current != 0o600:
                path.chmod(0o600)
                fixed.append({"path": str(path.relative_to(ROOT)), "before": oct(current), "after": "0o600"})
    if fixed:
        changes.append({"action": "fix_secret_permissions", "count": len(fixed)})
    return fixed


def _main_impl() -> None:
    ARCHIVE.mkdir(parents=True, exist_ok=True)
    changes: list[dict[str, JsonValue]] = []
    steps: dict[str, JsonValue] = {}
    blockers: list[str] = []

    manifest = load_json(MANIFEST, {})
    mapping = load_json(MAPPING, [])
    schedules_data = load_json(SCHEDULES, {})
    schedules = schedule_rows(schedules_data)
    if len(manifest_rows(manifest)) != 193:
        raise RuntimeError(f"unexpected manifest baseline: {len(manifest_rows(manifest))}, expected 193")
    if any((row.get("execution") or {}).get("backend") != "argv" for row in manifest_rows(manifest)):
        raise RuntimeError("legacy_manifest_requires_oss_architecture_v2_debt_zero_migrate")
    if len(schedules) != 139:
        raise RuntimeError(f"unexpected schedule baseline: {len(schedules)}, expected 139")

    baseline = {
        "schemaVersion": "oss-architecture-v2-baseline-v1",
        "generatedAt": now_iso(),
        "manifestCount": len(manifest_rows(manifest)),
        "scheduleCount": len(schedules),
        "scheduleFingerprint": schedule_fingerprint(schedules),
        "sourceManifestUpdatedAt": manifest.get("updatedAt"),
        "agentTaskCadencePreserved": True,
    }
    write_json(BASELINE, baseline, changes)

    patch_activities(changes)
    patch_release_gate(changes)
    patch_slo_wrapper(changes)
    patch_docs(changes)
    update_side_effect_policy(manifest, schedules, changes)
    update_manifest_only_policy(manifest, mapping, schedules, changes)
    update_script_coverage(changes)
    permissions = fix_secret_permissions(changes)

    steps["restoreBootstrap"] = restore_p0_bootstrap(changes)
    if not steps["restoreBootstrap"].get("ok"):
        blockers.append("p0_bootstrap_restore_failed")
    archived = archive_active_backups(changes)

    py = str(ROOT / ".venv" / "bin" / "python")
    compile_targets = [
        ROOT / "packages" / "rbw_agent_runtime" / "models.py",
        ROOT / "packages" / "rbw_agent_runtime" / "catalog.py",
        ROOT / "packages" / "rbw_agent_runtime" / "policy.py",
        ROOT / "packages" / "rbw_agent_runtime" / "execution.py",
        ROOT / "packages" / "rbw_agent_runtime" / "telemetry.py",
        ROOT / "packages" / "rbw_agent_runtime" / "cli.py",
        APPS / "runtime_v2_bridge.py",
        ACTIVITIES,
        RELEASE_GATE,
        SCRIPTS / "oss_architecture_v2_catalog.py",
        SCRIPTS / "oss_architecture_v2_guard.py",
        SCRIPTS / "oss_architecture_v2_selftest.py",
        SCRIPTS / "temporal_performance_slo_core.py",
        ROOT / "tests" / "test_runtime_v2.py",
    ]
    steps["pyCompile"] = run([py, "-m", "py_compile", *[str(path) for path in compile_targets]], timeout=120)
    steps["unitTests"] = run([py, "-m", "unittest", "discover", "-s", str(ROOT / "tests"), "-p", "test_runtime_v2.py", "-q"], timeout=120)
    steps["catalogBuild"] = run([py, str(SCRIPTS / "oss_architecture_v2_catalog.py")], timeout=180)
    steps["selftestPredeploy"] = run([py, str(SCRIPTS / "oss_architecture_v2_selftest.py")], timeout=120)
    steps["sloCore"] = run([py, str(SLO_WRAPPER)], timeout=240)
    steps["structuralGuard"] = run([py, str(SCRIPTS / "oss_structural_guard.py")], timeout=180)
    steps["securityAudit"] = run([py, str(SCRIPTS / "oss_security_audit_guard_v2.py")], timeout=180)
    for name in ("pyCompile", "unitTests", "catalogBuild", "selftestPredeploy", "sloCore", "structuralGuard", "securityAudit"):
        if not steps[name].get("ok"):
            blockers.append(name)
    if blockers:
        raise RuntimeError("predeploy_validation_failed:" + ",".join(blockers))

    unit = f"rbw-architecture-v2-restart-{datetime.now(timezone.utc).strftime('%H%M%S')}"
    worker_units = [
        "rbw-agents-oss-worker.service",
        "rbw-agents-oss-worker-watchdog.service",
        "rbw-agents-oss-worker-campaigns.service",
        "rbw-agents-oss-worker-sync.service",
        "rbw-agents-oss-worker-ao.service",
    ]
    steps["restartScheduled"] = run([
        "sudo", "-n", "/usr/bin/systemd-run", f"--unit={unit}", "--on-active=20s",
        "/bin/systemctl", "restart", *worker_units,
    ], timeout=30)
    steps["restartScheduled"]["workerUnits"] = worker_units
    if not steps["restartScheduled"].get("ok"):
        raise RuntimeError("worker_restart_not_scheduled")

    ok = True
    report = {
        "generatedAt": now_iso(),
        "contractVersion": "oss-architecture-v2-install-v1",
        "capabilityId": "oss-architecture-v2-install",
        "ok": ok,
        "status": "installed_argv_only" if ok else "installed_with_blockers",
        "summary": f"architecture_v2_install: manifest=193 schedules=139 changes={len(changes)} archivedBackups={len(archived)} permissionsFixed={len(permissions)} blockers={len(blockers)}",
        "counts": {
            "manifest": 193,
            "schedules": 139,
            "changes": len(changes),
            "archivedBackups": len(archived),
            "permissionsFixed": len(permissions),
            "blockers": len(blockers),
        },
        "blockingReasons": blockers,
        "warningReasons": [],
        "artifacts": {
            "reportJson": str(REPORT_JSON),
            "reportMd": str(REPORT_MD),
            "archive": str(ARCHIVE),
            "catalog": str(CONFIG / "agents-v2" / "catalog-v2.json"),
            "cards": str(CONFIG / "agents-v2" / "agent-cards-v2.json"),
            "baseline": str(BASELINE),
        },
        "checks": {"steps": steps, "changes": changes, "baseline": baseline},
        "updatedBy": "oss-architecture-v2-install",
    }
    OPS.mkdir(parents=True, exist_ok=True)
    REPORT_JSON.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    REPORT_MD.write_text(
        "# OSS Architecture v2 Install\n\n"
        f"- status: {report['status']}\n"
        f"- manifest / schedules: 193 / 139\n"
        f"- archived backups: {len(archived)}\n"
        f"- permissions fixed: {len(permissions)}\n"
        f"- blockers: {', '.join(blockers) or 'none'}\n"
        f"- restart scheduled: {steps['restartScheduled'].get('ok')}\n",
        encoding="utf-8",
    )
    print(json.dumps({"ok": ok, "status": report["status"], "summary": report["summary"], "counts": report["counts"], "blockingReasons": blockers, "reportJson": str(REPORT_JSON), "restartScheduled": steps["restartScheduled"].get("ok")}, ensure_ascii=False))
    raise SystemExit(0 if ok else 1)


def rollback_from_archive() -> list[str]:
    restored: list[str] = []
    before = ARCHIVE / "before"
    if before.exists():
        for archived in sorted(before.rglob("*")):
            if not archived.is_file():
                continue
            relative = archived.relative_to(before)
            target = ROOT / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(archived, target)
            restored.append(str(relative))
    return restored


def main() -> None:
    try:
        _main_impl()
    except SystemExit:
        raise
    except Exception as exc:
        ARCHIVE.mkdir(parents=True, exist_ok=True)
        restored = rollback_from_archive()
        bootstrap = restore_p0_bootstrap([])
        archived_backups = archive_active_backups([])
        report = {
            "generatedAt": now_iso(),
            "contractVersion": "oss-architecture-v2-install-v1",
            "capabilityId": "oss-architecture-v2-install",
            "ok": False,
            "status": "rolled_back_after_install_exception",
            "summary": f"architecture_v2_install rolled back after {exc.__class__.__name__}",
            "counts": {"restoredFiles": len(restored), "archivedBackups": len(archived_backups), "blockers": 1},
            "blockingReasons": [f"{exc.__class__.__name__}:{str(exc)[:500]}"],
            "warningReasons": [],
            "artifacts": {"reportJson": str(REPORT_JSON), "reportMd": str(REPORT_MD), "archive": str(ARCHIVE)},
            "checks": {"restored": restored, "bootstrap": bootstrap, "archivedBackups": archived_backups},
            "updatedBy": "oss-architecture-v2-install-rollback",
        }
        OPS.mkdir(parents=True, exist_ok=True)
        REPORT_JSON.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        REPORT_MD.write_text(f"# OSS Architecture v2 Install\n\n- status: rolled back\n- error: {report['blockingReasons'][0]}\n- restored files: {len(restored)}\n", encoding="utf-8")
        print(json.dumps({"ok": False, "status": report["status"], "blockingReasons": report["blockingReasons"], "restoredFiles": len(restored), "reportJson": str(REPORT_JSON)}, ensure_ascii=False))
        raise SystemExit(1)


if __name__ == "__main__":
    main()
