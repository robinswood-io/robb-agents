from __future__ import annotations

import asyncio
import datetime
import importlib.util
import json
import logging
import subprocess
from pathlib import Path
from typing import Protocol, runtime_checkable

from activity_compaction import (
    JSON_ADAPTER,
    RTK_TOKEN_CONFIG,
    JsonObject,
    _compact_lines,
    _compact_result_observation,
    _compact_temporal_return_payload,
    _estimate_tokens,
    _hard_cap_json_status,
    _json_compact,
    _load_rtk_token_config,
    _rtk_metrics_payload,
    _rtk_optimize_output,
    _tail_text,
    _try_parse_json_blob,
)
from pydantic import TypeAdapter, ValidationError
from rbw_agent_runtime.json_support import _integer, _is_string_array, _optional_string
from runtime_v2_bridge import (
    load_manifest_entries,
    preflight_invocation,
    run_structured_invocation,
)
from temporalio import activity

OBJECT_ADAPTER = TypeAdapter(JsonObject)
logger = logging.getLogger(__name__)

@runtime_checkable
class ContextAdapter(Protocol):
    def check_action(self, action: JsonObject) -> object: ...
    def record_decision_trace(self, trace: JsonObject) -> object: ...

__all__ = [
    "RTK_TOKEN_CONFIG",
    "_compact_lines",
    "_estimate_tokens",
    "_extract_json_status_from_stdout",
    "_try_parse_json_blob",
    "run_legacy_automation",
]

LOGS = Path('/srv/rbw-agents-oss/logs')
CMD_MANIFEST = Path('/srv/rbw-agents-oss/config/command-manifest.json')
COMPAT_ROOT = Path('/home/craft/.craft-agent')
CONTEXT_ADAPTER_PATH = Path('/srv/rbw-agents-oss/apps/context-graph/context_graph_adapter.py')
WRAPPER_FAILURE_ALERT = Path('/srv/rbw-agents-oss/scripts/wrapper_failure_alert.py')


def _load_manifest() -> dict[str, JsonObject]:
    # Runtime v2 repository validates duplicate IDs and caches by manifest mtime.
    return load_manifest_entries()


def _append_jsonl(path: Path, payload: JsonObject) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('a', encoding='utf-8') as f:
        _ = f.write(json.dumps(payload, ensure_ascii=False) + "\n")


def _load_context_adapter() -> ContextAdapter | None:
    if not CONTEXT_ADAPTER_PATH.exists():
        return None
    try:
        spec = importlib.util.spec_from_file_location('rbw_context_graph_adapter', CONTEXT_ADAPTER_PATH)
        if spec is None or spec.loader is None:
            return None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        if not isinstance(module, ContextAdapter):
            raise TypeError("Context adapter must expose both callable operations")
        return module
    except Exception:
        logger.exception("Unable to load context adapter")
        return None


def _context_check_action(action: JsonObject) -> JsonObject:
    adapter = _load_context_adapter()
    if adapter is None:
        return {
            'enabled': False,
            'mode': 'adapter_unavailable',
            'allowed': True,
            'decision': 'allow_fail_open',
            'blockingReasons': [],
        }
    try:
        decision = OBJECT_ADAPTER.validate_python(adapter.check_action(action))
        # Pilot safety: Temporal remains fail-open during observe-only rollout.
        decision['temporalHook'] = 'observe_only_fail_open'
        decision['allowed'] = True
        return decision
    except Exception as exc:
        logger.exception("Optional activity operation failed")
        return {
            'enabled': False,
            'mode': 'adapter_error',
            'allowed': True,
            'decision': 'allow_fail_open',
            'errorType': exc.__class__.__name__,
            'error': str(exc),
            'blockingReasons': [],
        }


def _context_record_trace(trace: JsonObject) -> JsonObject:
    adapter = _load_context_adapter()
    if adapter is None:
        return {'ok': False, 'error': 'adapter_unavailable'}
    try:
        return OBJECT_ADAPTER.validate_python(adapter.record_decision_trace(trace))
    except Exception as exc:
        logger.exception("Optional activity operation failed")
        return {'ok': False, 'errorType': exc.__class__.__name__, 'error': str(exc)}


def _notify_wrapper_failure(payload: JsonObject) -> JsonObject:
    """Best-effort Listmonk alert for wrapper failures/timeouts.

    This function must never break the worker. It is intentionally subprocess
    based so notification failures are isolated from Temporal activity logic.
    Dedupe/cooldown is handled by scripts/wrapper_failure_alert.py.
    """
    if not WRAPPER_FAILURE_ALERT.exists():
        return {'ok': False, 'error': 'alert_helper_missing'}
    try:
        res = subprocess.run(
            ['python3', str(WRAPPER_FAILURE_ALERT)],
            input=json.dumps(payload, ensure_ascii=False),
            capture_output=True,
            check=False,
            text=True,
            timeout=35,
        )
        out = (res.stdout or '').strip()
        parsed: JsonObject
        try:
            parsed = OBJECT_ADAPTER.validate_json(out) if out else {}
        except ValidationError:
            parsed = {'stdout': out[-1000:]}
        _ = parsed.setdefault('returncode', res.returncode)
        if res.stderr:
            parsed['stderr'] = res.stderr[-1000:]
        return parsed
    except Exception as exc:
        logger.exception("Optional activity operation failed")
        return {'ok': False, 'errorType': exc.__class__.__name__, 'error': str(exc)}


def _extract_json_status_from_stdout(stdout: str) -> JsonObject:
    text = (stdout or '').strip()
    if not text:
        return {}
    candidates = [text]
    candidates.extend([line.strip() for line in text.splitlines()[::-1] if line.strip().startswith('{')][:5])
    for raw in candidates:
        try:
            parsed = JSON_ADAPTER.validate_json(raw)
        except ValidationError:
            continue
        if isinstance(parsed, dict):
            return parsed
    return {}


@activity.defn
async def run_legacy_automation(payload: JsonObject) -> JsonObject:
    now_dt = datetime.datetime.now(datetime.UTC)
    now = now_dt.isoformat()
    LOGS.mkdir(parents=True, exist_ok=True)
    legacy_id = _optional_string(payload.get('legacy_id'))
    info = activity.info()
    manifest = _load_manifest()
    entry = manifest.get(legacy_id) if legacy_id is not None else None

    activity_log: JsonObject = {
        'ts': now,
        'workflow': 'RbwAutomationWorkflow',
        'payload': payload,
        'mode': 'runtime-v2-preflight',
    }

    runtime_v2_preflight = await asyncio.to_thread(preflight_invocation, payload, entry)
    activity_log['runtimeV2'] = runtime_v2_preflight
    if not runtime_v2_preflight.get('allowed'):
        completed_at = datetime.datetime.now(datetime.UTC).isoformat()
        reasons = runtime_v2_preflight.get('strict_reasons') or ['unknown_automation_id']
        if not _is_string_array(reasons):
            raise TypeError('Preflight reasons must be a list of strings')
        activity_log['completedAt'] = completed_at
        activity_log['result'] = {
            'ok': False,
            'exitCode': 2,
            'timeout': False,
            'errorType': 'RuntimeV2PreflightBlocked',
            'error': ','.join(reasons),
            'stdoutPreview': '',
            'stderrPreview': ','.join(reasons),
        }
        _append_jsonl(LOGS / 'workflow-runs.jsonl', activity_log)
        return {
            'ok': False,
            'completedAt': completed_at,
            'legacyId': legacy_id,
            'name': payload.get('name') or (entry or {}).get('name'),
            'mode': 'runtime-v2-preflight',
            'exitCode': 2,
            'timeout': False,
            'businessFailure': False,
            'jsonStatus': {},
            'errorType': 'RuntimeV2PreflightBlocked',
            'error': ','.join(reasons),
            'stderrPreview': ','.join(reasons),
        }

    if entry and entry.get('mode') == 'script':
        timeout_seconds = _integer(entry.get('timeout_seconds', 600))
        raw_event = payload.get('event')
        event: JsonObject = raw_event if isinstance(raw_event, dict) else {}
        command = entry['command']
        if not isinstance(command, str):
            raise TypeError('Manifest command must be text')
        extra_env: JsonObject = {
            'RBW_LEGACY_ID': legacy_id,
            'RBW_AUTOMATION_PAYLOAD_JSON': json.dumps(payload, ensure_ascii=False),
            'RBW_EVENT_JSON': json.dumps(event, ensure_ascii=False),
            'RBW_SESSION_ID': event.get('sessionId') or event.get('session_id') or event.get('id') or '',
        }
        activity_log['mode'] = 'script'
        activity_log['command'] = entry['command']
        activity_log['timeoutSeconds'] = timeout_seconds
        context_action: JsonObject = {
            'legacy_id': legacy_id,
            'name': entry.get('name') or payload.get('name'),
            'command': entry.get('command'),
            'mode': entry.get('mode'),
            'riskClass': entry.get('riskClass'),
            'sideEffects': entry.get('sideEffects', []),
            'entry': entry,
            'payload': payload,
            'scope': legacy_id,
        }
        context_preflight = await asyncio.to_thread(_context_check_action, context_action)
        activity_log['decisionContext'] = context_preflight
        try:
            # V12: this activity is async, therefore every blocking subprocess/file-heavy
            # operation must be offloaded from the worker event loop. Running Popen +
            # communicate() inline was starving workflow-task polling and producing
            # TMPRL1101 / eviction-slot cascades under schedule bursts.
            result = await asyncio.to_thread(run_structured_invocation, runtime_v2_preflight, extra_env)
        except subprocess.TimeoutExpired as exc:
            completed_at = datetime.datetime.now(datetime.UTC).isoformat()
            stdout = exc.stdout or ''
            stderr = exc.stderr or ''
            if isinstance(stdout, bytes):
                stdout = stdout.decode(errors='ignore')
            if isinstance(stderr, bytes):
                stderr = stderr.decode(errors='ignore')
            activity_log['completedAt'] = completed_at
            stdout_rtk = _rtk_optimize_output(str(stdout), stream='stdout', command=command, legacy_id=legacy_id, ok=False)
            stderr_rtk = _rtk_optimize_output(str(stderr), stream='stderr', command=command, legacy_id=legacy_id, ok=False)
            activity_log['result'] = {
                'ok': False,
                'exitCode': 124,
                'timeout': True,
                'errorType': 'timeout',
                'error': str(exc),
                'stdoutPreview': stdout_rtk.get('preview', ''),
                'stderrPreview': stderr_rtk.get('preview', ''),
                'rtkTokenOptimization': _rtk_metrics_payload(('stdout', stdout_rtk), ('stderr', stderr_rtk)),
            }
            activity_log['alert'] = await asyncio.to_thread(_notify_wrapper_failure, {
                'generatedAt': completed_at,
                'legacyId': legacy_id,
                'name': payload.get('name') or entry.get('name'),
                'command': entry['command'],
                'exitCode': 124,
                'timeout': True,
                'error': str(exc),
                'stdout': str(stdout),
                'stderr': str(stderr),
                'attempt': info.attempt,
                'workflowId': info.workflow_id,
                'taskQueue': info.task_queue,
            })
            activity_log['decisionTrace'] = await asyncio.to_thread(_context_record_trace, {
                'phase': 'postflight',
                'outcome': 'timeout',
                'legacyId': legacy_id,
                'payload': payload,
                'preflight': activity_log.get('decisionContext'),
                'result': activity_log['result'],
            })
            _append_jsonl(LOGS / 'workflow-runs.jsonl', activity_log)
            return {
                'ok': False,
                'executedAt': now,
                'completedAt': completed_at,
                'durationSeconds': None,
                'legacyId': legacy_id,
                'name': payload.get('name') or entry.get('name'),
                'mode': 'script',
                'command': entry['command'],
                'exitCode': 124,
                'timeout': True,
                'businessFailure': False,
                'jsonStatus': {},
                'alert': activity_log.get('alert'),
                'stdoutPreview': stdout_rtk.get('preview', _tail_text(stdout, 2000)),
                'stderrPreview': stderr_rtk.get('preview', _tail_text(stderr, 2000)),
                'rtkTokenOptimization': _rtk_metrics_payload(('stdout', stdout_rtk), ('stderr', stderr_rtk)),
                'stdoutBytes': len(str(stdout).encode('utf-8', errors='ignore')),
                'stderrBytes': len(str(stderr).encode('utf-8', errors='ignore')),
                'stdoutTruncated': len(str(stdout)) > 2000,
                'stderrTruncated': len(str(stderr)) > 2000,
                'errorType': 'timeout',
                'error': str(exc),
            }
        except Exception as exc:
            logger.exception("Structured activity invocation failed")
            completed_at = datetime.datetime.now(datetime.UTC).isoformat()
            activity_log['completedAt'] = completed_at
            activity_log['result'] = {
                'ok': False,
                'exitCode': 1,
                'timeout': False,
                'errorType': exc.__class__.__name__,
                'error': str(exc),
                'stdoutPreview': '',
                'stderrPreview': '',
            }
            activity_log['alert'] = await asyncio.to_thread(_notify_wrapper_failure, {
                'generatedAt': completed_at,
                'legacyId': legacy_id,
                'name': payload.get('name') or entry.get('name'),
                'command': entry['command'],
                'exitCode': 1,
                'timeout': False,
                'error': str(exc),
                'attempt': info.attempt,
                'workflowId': info.workflow_id,
                'taskQueue': info.task_queue,
            })
            activity_log['decisionTrace'] = await asyncio.to_thread(_context_record_trace, {
                'phase': 'postflight',
                'outcome': 'exception',
                'legacyId': legacy_id,
                'payload': payload,
                'preflight': activity_log.get('decisionContext'),
                'result': activity_log['result'],
            })
            _append_jsonl(LOGS / 'workflow-runs.jsonl', activity_log)
            return {
                'ok': False,
                'executedAt': now,
                'completedAt': completed_at,
                'durationSeconds': None,
                'legacyId': legacy_id,
                'name': payload.get('name') or entry.get('name'),
                'mode': 'script',
                'command': entry['command'],
                'exitCode': 1,
                'timeout': False,
                'businessFailure': False,
                'jsonStatus': {},
                'alert': activity_log.get('alert'),
                'errorType': exc.__class__.__name__,
                'error': str(exc),
            }

        completed_at = datetime.datetime.now(datetime.UTC).isoformat()
        activity_log['completedAt'] = completed_at
        activity_log['durationSeconds'] = result.get('durationSeconds')
        activity_log['result'] = _compact_result_observation(result)
        activity_log['decisionTrace'] = await asyncio.to_thread(_context_record_trace, {
            'phase': 'postflight',
            'outcome': 'completed',
            'legacyId': legacy_id,
            'payload': payload,
            'preflight': activity_log.get('decisionContext'),
            'result': activity_log['result'],
            'durationSeconds': result.get('durationSeconds'),
        })
        alert_result = None
        if not result['ok']:
            alert_payload: JsonObject = {
                'generatedAt': completed_at,
                'legacyId': legacy_id,
                'name': payload.get('name') or entry.get('name'),
                'command': entry['command'],
                'exitCode': result.get('exitCode'),
                'timeout': result.get('timeout', False),
                'businessFailure': result.get('businessFailure', False),
                'jsonStatus': _hard_cap_json_status(_json_compact(result.get('jsonStatus') or {}, _load_rtk_token_config())) if result.get('jsonStatus') else {},
                'durationSeconds': result.get('durationSeconds'),
                'stdout': result.get('stdout', ''),
                'stderr': result.get('stderr', ''),
                'attempt': info.attempt,
                'workflowId': info.workflow_id,
                'taskQueue': info.task_queue,
            }
            alert_result = await asyncio.to_thread(_notify_wrapper_failure, alert_payload)
            activity_log['alert'] = alert_result

        _append_jsonl(LOGS / 'workflow-runs.jsonl', activity_log)
        return_payload_base: JsonObject = {
            'ok': result['ok'],
            'executedAt': now,
            'completedAt': completed_at,
            'durationSeconds': result.get('durationSeconds'),
            'legacyId': legacy_id,
            'name': payload.get('name') or entry.get('name'),
            'mode': 'script',
            'command': entry['command'],
            'exitCode': result['exitCode'],
            'timeout': result.get('timeout', False),
            'businessFailure': result.get('businessFailure', False),
            'jsonStatus': _hard_cap_json_status(_json_compact(result.get('jsonStatus') or {}, _load_rtk_token_config())) if result.get('jsonStatus') else {},
            'alert': alert_result,
            'stdoutPreview': result.get('stdoutPreview', _tail_text(result.get('stdout', ''), 2000)),
            'stderrPreview': result.get('stderrPreview', _tail_text(result.get('stderr', ''), 2000)),
            'stdoutBytes': result.get('stdoutBytes', len((_optional_string(result.get('stdout')) or '').encode('utf-8', errors='ignore'))),
            'stderrBytes': result.get('stderrBytes', len((_optional_string(result.get('stderr')) or '').encode('utf-8', errors='ignore'))),
            'stdoutTruncated': result.get('stdoutTruncated', len(_optional_string(result.get('stdout')) or '') > 2000),
            'stderrTruncated': result.get('stderrTruncated', len(_optional_string(result.get('stderr')) or '') > 2000),
        }
        if result.get('rtkTokenOptimization'):
            return_payload_base['rtkTokenOptimization'] = result.get('rtkTokenOptimization')
        return _compact_temporal_return_payload(
            return_payload_base,
            result,
            legacy_id=legacy_id,
            name=_optional_string(payload.get('name') or entry.get('name')),
            command=command,
        )

    # Defense in depth: preflight should already reject this branch. Never turn an
    # unknown/non-script automation into a successful Temporal execution.
    completed_at = datetime.datetime.now(datetime.UTC).isoformat()
    activity_log['completedAt'] = completed_at
    activity_log['result'] = {
        'ok': False,
        'exitCode': 2,
        'timeout': False,
        'errorType': 'RuntimeV2UnsupportedEntry',
        'error': 'unknown_automation_id_or_unsupported_mode',
    }
    _append_jsonl(LOGS / 'workflow-runs.jsonl', activity_log)
    return {
        'ok': False,
        'completedAt': completed_at,
        'legacyId': legacy_id,
        'name': payload.get('name'),
        'mode': 'runtime-v2-fail-closed',
        'exitCode': 2,
        'timeout': False,
        'businessFailure': False,
        'jsonStatus': {},
        'errorType': 'RuntimeV2UnsupportedEntry',
        'error': 'unknown_automation_id_or_unsupported_mode',
    }
