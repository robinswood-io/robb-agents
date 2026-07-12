from __future__ import annotations
from temporalio import activity
import asyncio
import os
import signal
import json
import importlib.util
import datetime
import subprocess
import re
from collections import Counter
from pathlib import Path

from runtime_v2_bridge import load_manifest_entries, preflight_invocation, run_structured_invocation

LOGS = Path('/srv/rbw-agents-oss/logs')
CMD_MANIFEST = Path('/srv/rbw-agents-oss/config/command-manifest.json')
COMPAT_ROOT = Path('/home/craft/.craft-agent')
CONTEXT_ADAPTER_PATH = Path('/srv/rbw-agents-oss/apps/context-graph/context_graph_adapter.py')
WRAPPER_FAILURE_ALERT = Path('/srv/rbw-agents-oss/scripts/wrapper_failure_alert.py')
RTK_TOKEN_CONFIG = Path('/srv/rbw-agents-oss/config/temporal/rtk-token-optimization.json')




def _load_rtk_token_config() -> dict:
    defaults = {
        'enabled': True,
        'version': 'rtk-temporal-v1',
        'previewCharBudget': 900,
        'errorPreviewCharBudget': 1400,
        'jsonStringLimit': 220,
        'jsonArraySample': 3,
        'maxObjectKeys': 24,
        'lineHead': 18,
        'lineTail': 12,
        'importantLineLimit': 30,
        'estimateCharsPerToken': 4,
    }
    try:
        if RTK_TOKEN_CONFIG.exists():
            loaded = json.loads(RTK_TOKEN_CONFIG.read_text(encoding='utf-8'))
            if isinstance(loaded, dict):
                defaults.update(loaded)
    except Exception:
        pass
    if os.getenv('RBW_TEMPORAL_RTK_TOKEN_OPTIMIZATION', '').lower() in {'0', 'false', 'no', 'off'}:
        defaults['enabled'] = False
    return defaults


def _estimate_tokens(text: str, cfg: dict) -> int:
    chars_per_token = int(cfg.get('estimateCharsPerToken') or 4) or 4
    return max(0, int((len(text or '') + chars_per_token - 1) / chars_per_token))


def _json_compact(value, cfg: dict, depth: int = 0):
    string_limit = int(cfg.get('jsonStringLimit') or 220)
    array_sample = int(cfg.get('jsonArraySample') or 3)
    max_keys = int(cfg.get('maxObjectKeys') or 24)
    if depth > 4:
        return '<depth-limit>'
    if isinstance(value, str):
        return value if len(value) <= string_limit else value[: string_limit - 20] + f'…<{len(value)} chars>'
    if isinstance(value, (int, float, bool)) or value is None:
        return value
    if isinstance(value, list):
        return {
            '_type': 'list',
            'count': len(value),
            'sample': [_json_compact(v, cfg, depth + 1) for v in value[:array_sample]],
        }
    if isinstance(value, dict):
        priority = [
            'ok', 'status', 'summary', 'counts', 'blockingReasons', 'generatedAt',
            'capabilityId', 'legacyId', 'name', 'mode', 'exitCode', 'timeout',
            'businessFailure', 'jsonStatus', 'artifacts', 'reportJson', 'reportMd',
            'nextActions', 'actionQueue', 'workflowResults', 'checks', 'error', 'errorType',
        ]
        keys = []
        for key in priority:
            if key in value and key not in keys:
                keys.append(key)
        for key in sorted(value.keys(), key=lambda x: str(x)):
            if key not in keys:
                keys.append(key)
            if len(keys) >= max_keys:
                break
        out = {str(k): _json_compact(value.get(k), cfg, depth + 1) for k in keys}
        omitted = max(0, len(value) - len(keys))
        if omitted:
            out['_omittedKeys'] = omitted
        return out
    return str(value)[:string_limit]


def _try_parse_json_blob(text: str):
    raw = (text or '').strip()
    if not raw:
        return None
    candidates = [raw]
    candidates.extend([line.strip() for line in raw.splitlines()[::-1] if line.strip().startswith(('{', '['))][:8])
    for candidate in candidates:
        try:
            return json.loads(candidate)
        except Exception:
            continue
    return None


def _hard_cap_json_status(value, max_bytes: int = 8192):
    if not isinstance(value, dict):
        return value
    try:
        if len(json.dumps(value, ensure_ascii=False).encode('utf-8')) <= max_bytes:
            return value
    except Exception:
        pass
    compact_cfg = {'jsonStringLimit': 300, 'jsonArraySample': 4, 'jsonDictKeys': 24}
    out = {
        'ok': value.get('ok'),
        'status': value.get('status'),
        'summary': value.get('summary'),
        'capabilityId': value.get('capabilityId'),
        'generatedAt': value.get('generatedAt'),
        '_truncatedJsonStatus': True,
    }
    for key in ('counts','blockingReasons','warningReasons','advisoryReasons','checks','artifacts'):
        if key in value:
            out[key] = _json_compact(value.get(key), compact_cfg)
    try:
        if len(json.dumps(out, ensure_ascii=False).encode('utf-8')) > max_bytes:
            out['checks'] = _json_compact(out.get('checks') or {}, {'jsonStringLimit': 180, 'jsonArraySample': 2, 'jsonDictKeys': 12})
            out['artifacts'] = _json_compact(out.get('artifacts') or {}, {'jsonStringLimit': 180, 'jsonArraySample': 2, 'jsonDictKeys': 12})
    except Exception:
        pass
    return {k: v for k, v in out.items() if v not in (None, {}, [], '')}


def _compact_lines(text: str, cfg: dict, budget: int, stream: str) -> tuple[str, str]:
    raw_lines = [line.rstrip() for line in (text or '').splitlines() if line.strip()]
    if not raw_lines:
        return '', 'empty'
    important_re = re.compile(r'(traceback|error|exception|failed|fatal|timeout|warning|denied|not found|module|syntax|runtimeerror|applicationerror)', re.I)
    important = [line for line in raw_lines if important_re.search(line)]
    counts = Counter(raw_lines)
    duplicate_groups = [(line, count) for line, count in counts.items() if count > 1]
    lines = []
    if important:
        lines.append(f'[rtk:{stream}:important_lines count={len(important)}]')
        lines.extend(important[: int(cfg.get('importantLineLimit') or 30)])
    if duplicate_groups:
        lines.append(f'[rtk:{stream}:deduplicated repeats={len(duplicate_groups)}]')
        for line, count in duplicate_groups[:12]:
            lines.append(f'{count}× {line[:220]}')
    head = int(cfg.get('lineHead') or 18)
    tail = int(cfg.get('lineTail') or 12)
    lines.append(f'[rtk:{stream}:shape lines={len(raw_lines)} chars={len(text or "")}]')
    lines.extend(raw_lines[:head])
    if len(raw_lines) > head + tail:
        lines.append(f'…<{len(raw_lines) - head - tail} lines omitted by RTK Temporal optimizer>')
    if len(raw_lines) > head:
        lines.extend(raw_lines[-tail:])
    preview = '\n'.join(lines)
    if len(preview) > budget:
        preview = preview[: max(0, budget - 80)] + f'\n…<rtk preview truncated to {budget} chars>'
    return preview, 'line_filter_dedupe'


def _rtk_optimize_output(text: str, *, stream: str, command: str = '', legacy_id: str | None = None, ok: bool | None = None) -> dict:
    cfg = _load_rtk_token_config()
    text = text or ''
    original_bytes = len(text.encode('utf-8', errors='ignore'))
    if not cfg.get('enabled'):
        limit = 2000
        preview = _tail_text(text, limit)
        return {
            'applied': False,
            'version': cfg.get('version'),
            'strategy': 'disabled_tail',
            'preview': preview,
            'originalBytes': original_bytes,
            'previewBytes': len(preview.encode('utf-8', errors='ignore')),
            'estimatedOriginalTokens': _estimate_tokens(text, cfg),
            'estimatedPreviewTokens': _estimate_tokens(preview, cfg),
            'estimatedSavedTokens': max(0, _estimate_tokens(text, cfg) - _estimate_tokens(preview, cfg)),
        }
    budget = int(cfg.get('previewCharBudget') or 900)
    if stream == 'stderr' or ok is False:
        budget = int(cfg.get('errorPreviewCharBudget') or 1400)
    parsed = _try_parse_json_blob(text)
    if parsed is not None:
        compact = {
            'rtk': cfg.get('version', 'rtk-temporal-v1'),
            'strategy': 'json_shape_summary',
            'legacyId': legacy_id,
            'stream': stream,
            'commandHint': (command or '')[:180],
            'originalBytes': original_bytes,
            'json': _json_compact(parsed, cfg),
        }
        preview = json.dumps(compact, ensure_ascii=False, separators=(',', ':'))
        if len(preview) > budget:
            preview = preview[: max(0, budget - 80)] + f'…<rtk json summary truncated to {budget} chars>'
        strategy = 'json_shape_summary'
    else:
        preview, strategy = _compact_lines(text, cfg, budget, stream)
    original_tokens = _estimate_tokens(text, cfg)
    preview_tokens = _estimate_tokens(preview, cfg)
    # RTK must never increase Temporal history size. For small outputs, raw text is
    # already cheaper than a structural summary and is safe to keep as preview.
    if original_bytes <= budget and preview_tokens >= original_tokens:
        preview = text
        strategy = 'small_passthrough_no_increase'
        preview_tokens = original_tokens
    elif preview_tokens > original_tokens:
        preview = _tail_text(text, budget)
        strategy = 'tail_no_increase_fallback'
        preview_tokens = _estimate_tokens(preview, cfg)
    return {
        'applied': True,
        'version': cfg.get('version'),
        'strategy': strategy,
        'preview': preview,
        'originalBytes': original_bytes,
        'previewBytes': len(preview.encode('utf-8', errors='ignore')),
        'estimatedOriginalTokens': original_tokens,
        'estimatedPreviewTokens': preview_tokens,
        'estimatedSavedTokens': max(0, original_tokens - preview_tokens),
        'estimatedSavingsPct': round((max(0, original_tokens - preview_tokens) / original_tokens) * 100, 1) if original_tokens else 0.0,
    }


def _rtk_metrics_payload(*stream_results: tuple[str, dict]) -> dict | None:
    """Return only useful RTK metrics for Temporal payloads.

    V2 omits zero-savings metadata so small successful runs do not pay a token
    tax for optimization bookkeeping. Metrics are included whenever at least one
    stream actually saved tokens.
    """
    cfg = _load_rtk_token_config()
    include_zero = bool(cfg.get('includeZeroSavingsMetrics'))
    min_saved = int(cfg.get('metricsMinSavedTokens') or 1)
    out: dict[str, dict] = {}
    total_original = total_preview = total_saved = 0
    for name, stats in stream_results:
        if not isinstance(stats, dict):
            continue
        saved = int(stats.get('estimatedSavedTokens') or 0)
        original = int(stats.get('estimatedOriginalTokens') or 0)
        preview = int(stats.get('estimatedPreviewTokens') or 0)
        total_original += original
        total_preview += preview
        total_saved += saved
        if include_zero or saved >= min_saved:
            out[name] = {k: v for k, v in stats.items() if k != 'preview'}
    if not out:
        return None
    out['_summary'] = {
        'version': cfg.get('version'),
        'estimatedOriginalTokens': total_original,
        'estimatedPreviewTokens': total_preview,
        'estimatedSavedTokens': total_saved,
        'estimatedSavingsPct': round((total_saved / total_original) * 100, 1) if total_original else 0.0,
    }
    return out


def _compact_result_observation(result: dict) -> dict:
    """Compact workflow-runs result logs without changing semantics.

    Missing boolean/empty fields are interpreted as their defaults by existing
    consumers. Failures keep diagnostic fields; success paths omit zero/false
    noise that dominates high-frequency small wrappers.
    """
    out = {
        'ok': bool(result.get('ok')),
        'exitCode': int(result.get('exitCode') or 0),
    }
    if result.get('timeout'):
        out['timeout'] = True
    if result.get('businessFailure'):
        out['businessFailure'] = True
    if result.get('jsonStatus'):
        out['jsonStatus'] = _hard_cap_json_status(_json_compact(result.get('jsonStatus'), _load_rtk_token_config()))
    if result.get('errorType'):
        out['errorType'] = result.get('errorType')
    if result.get('error'):
        out['error'] = result.get('error')
    stdout_preview = result.get('stdoutPreview') or _tail_text(result.get('stdout', ''), 1000)
    stderr_preview = result.get('stderrPreview') or _tail_text(result.get('stderr', ''), 1000)
    if stdout_preview:
        out['stdoutPreview'] = stdout_preview
    if stderr_preview:
        out['stderrPreview'] = stderr_preview
    stdout_bytes = int(result.get('stdoutBytes') or len((result.get('stdout') or '').encode('utf-8', errors='ignore')) or 0)
    stderr_bytes = int(result.get('stderrBytes') or len((result.get('stderr') or '').encode('utf-8', errors='ignore')) or 0)
    if stdout_bytes:
        out['stdoutBytes'] = stdout_bytes
    if stderr_bytes:
        out['stderrBytes'] = stderr_bytes
    if result.get('stdoutTruncated'):
        out['stdoutTruncated'] = True
    if result.get('stderrTruncated'):
        out['stderrTruncated'] = True
    if result.get('rtkTokenOptimization'):
        out['rtkTokenOptimization'] = result.get('rtkTokenOptimization')
    return out


def _compact_temporal_return_payload(base: dict, result: dict, *, legacy_id: str | None, name: str | None, command: str | None) -> dict:
    """Build the compact activity return stored in Temporal history.

    Keep the fields the workflow and operators need, omit defaults on success,
    and keep richer diagnostics for failures/timeouts/business failures.
    """
    cfg = _load_rtk_token_config()
    compact_enabled = bool(cfg.get('compactTemporalResult', True))
    if not compact_enabled:
        return base
    ok = bool(result.get('ok'))
    out = {
        'ok': ok,
        'legacyId': legacy_id,
        'exitCode': int(result.get('exitCode') or 0),
    }
    if base.get('completedAt'):
        out['completedAt'] = base.get('completedAt')
    if result.get('durationSeconds') is not None:
        out['durationSeconds'] = result.get('durationSeconds')
    # Preserve operator context on failures; omit repeated static fields on success.
    if (not ok) or cfg.get('includeSuccessNameInTemporalResult'):
        if name:
            out['name'] = name
    if (not ok) or cfg.get('includeSuccessCommandInTemporalResult'):
        if command:
            out['command'] = command
    if result.get('timeout'):
        out['timeout'] = True
    if result.get('businessFailure'):
        out['businessFailure'] = True
    if result.get('jsonStatus'):
        out['jsonStatus'] = _hard_cap_json_status(_json_compact(result.get('jsonStatus'), _load_rtk_token_config()))
    if base.get('alert'):
        out['alert'] = base.get('alert')
    if result.get('errorType'):
        out['errorType'] = result.get('errorType')
    if result.get('error'):
        out['error'] = result.get('error')
    observation = _compact_result_observation(result)
    for key in ('stdoutPreview','stderrPreview','stdoutBytes','stderrBytes','stdoutTruncated','stderrTruncated','rtkTokenOptimization'):
        if key in observation:
            out[key] = observation[key]
    return out


def _load_manifest() -> dict:
    # Runtime v2 repository validates duplicate IDs and caches by manifest mtime.
    return load_manifest_entries()


def _append_jsonl(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('a', encoding='utf-8') as f:
        f.write(json.dumps(payload, ensure_ascii=False) + "\n")




def _load_context_adapter():
    if not CONTEXT_ADAPTER_PATH.exists():
        return None
    try:
        spec = importlib.util.spec_from_file_location('rbw_context_graph_adapter', CONTEXT_ADAPTER_PATH)
        if spec is None or spec.loader is None:
            return None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    except Exception:
        return None


def _context_check_action(action: dict) -> dict:
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
        decision = adapter.check_action(action)
        # Pilot safety: Temporal remains fail-open during observe-only rollout.
        decision['temporalHook'] = 'observe_only_fail_open'
        decision['allowed'] = True
        return decision
    except Exception as exc:
        return {
            'enabled': False,
            'mode': 'adapter_error',
            'allowed': True,
            'decision': 'allow_fail_open',
            'errorType': exc.__class__.__name__,
            'error': str(exc),
            'blockingReasons': [],
        }


def _context_record_trace(trace: dict) -> dict:
    adapter = _load_context_adapter()
    if adapter is None:
        return {'ok': False, 'error': 'adapter_unavailable'}
    try:
        return adapter.record_decision_trace(trace)
    except Exception as exc:
        return {'ok': False, 'errorType': exc.__class__.__name__, 'error': str(exc)}


def _notify_wrapper_failure(payload: dict) -> dict:
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
            text=True,
            timeout=35,
        )
        out = (res.stdout or '').strip()
        try:
            parsed = json.loads(out) if out else {}
        except Exception:
            parsed = {'stdout': out[-1000:]}
        parsed.setdefault('returncode', res.returncode)
        if res.stderr:
            parsed['stderr'] = res.stderr[-1000:]
        return parsed
    except Exception as exc:
        return {'ok': False, 'errorType': exc.__class__.__name__, 'error': str(exc)}

def _tail_text(value, limit: int = 2000) -> str:
    text = str(value or '')
    if len(text) <= limit:
        return text
    return text[-limit:]


def _extract_json_status_from_stdout(stdout: str) -> dict:
    text = (stdout or '').strip()
    if not text:
        return {}
    candidates = [text]
    candidates.extend([line.strip() for line in text.splitlines()[::-1] if line.strip().startswith('{')][:5])
    for raw in candidates:
        try:
            parsed = json.loads(raw)
        except Exception:
            continue
        if isinstance(parsed, dict):
            return parsed
    return {}


@activity.defn
async def run_legacy_automation(payload: dict) -> dict:
    now_dt = datetime.datetime.now(datetime.timezone.utc)
    now = now_dt.isoformat()
    LOGS.mkdir(parents=True, exist_ok=True)
    legacy_id = payload.get('legacy_id')
    info = activity.info()
    manifest = _load_manifest()
    entry = manifest.get(legacy_id)

    activity_log = {
        'ts': now,
        'workflow': 'RbwAutomationWorkflow',
        'payload': payload,
        'mode': 'runtime-v2-preflight',
    }

    runtime_v2_preflight = await asyncio.to_thread(preflight_invocation, payload, entry)
    activity_log['runtimeV2'] = runtime_v2_preflight
    if not runtime_v2_preflight.get('allowed'):
        completed_at = datetime.datetime.now(datetime.timezone.utc).isoformat()
        reasons = runtime_v2_preflight.get('strict_reasons') or ['unknown_automation_id']
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
        timeout_seconds = int(entry.get('timeout_seconds', 600))
        event = payload.get('event') if isinstance(payload.get('event'), dict) else {}
        extra_env = {
            'RBW_LEGACY_ID': legacy_id,
            'RBW_AUTOMATION_PAYLOAD_JSON': json.dumps(payload, ensure_ascii=False),
            'RBW_EVENT_JSON': json.dumps(event, ensure_ascii=False),
            'RBW_SESSION_ID': event.get('sessionId') or event.get('session_id') or event.get('id') or '',
        }
        activity_log['mode'] = 'script'
        activity_log['command'] = entry['command']
        activity_log['timeoutSeconds'] = timeout_seconds
        context_action = {
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
            completed_at = datetime.datetime.now(datetime.timezone.utc).isoformat()
            stdout = exc.stdout or ''
            stderr = exc.stderr or ''
            if isinstance(stdout, bytes):
                stdout = stdout.decode(errors='ignore')
            if isinstance(stderr, bytes):
                stderr = stderr.decode(errors='ignore')
            activity_log['completedAt'] = completed_at
            stdout_rtk = _rtk_optimize_output(str(stdout), stream='stdout', command=entry['command'], legacy_id=legacy_id, ok=False)
            stderr_rtk = _rtk_optimize_output(str(stderr), stream='stderr', command=entry['command'], legacy_id=legacy_id, ok=False)
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
                'attempt': getattr(info, 'attempt', None),
                'workflowId': getattr(info, 'workflow_id', ''),
                'taskQueue': getattr(info, 'task_queue', ''),
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
            completed_at = datetime.datetime.now(datetime.timezone.utc).isoformat()
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
                'attempt': getattr(info, 'attempt', None),
                'workflowId': getattr(info, 'workflow_id', ''),
                'taskQueue': getattr(info, 'task_queue', ''),
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

        completed_at = datetime.datetime.now(datetime.timezone.utc).isoformat()
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
            alert_payload = {
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
                'attempt': getattr(info, 'attempt', None),
                'workflowId': getattr(info, 'workflow_id', ''),
                'taskQueue': getattr(info, 'task_queue', ''),
            }
            alert_result = await asyncio.to_thread(_notify_wrapper_failure, alert_payload)
            activity_log['alert'] = alert_result

        _append_jsonl(LOGS / 'workflow-runs.jsonl', activity_log)
        return_payload_base = {
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
            'stdoutBytes': result.get('stdoutBytes', len((result.get('stdout') or '').encode('utf-8', errors='ignore'))),
            'stderrBytes': result.get('stderrBytes', len((result.get('stderr') or '').encode('utf-8', errors='ignore'))),
            'stdoutTruncated': result.get('stdoutTruncated', len(result.get('stdout') or '') > 2000),
            'stderrTruncated': result.get('stderrTruncated', len(result.get('stderr') or '') > 2000),
        }
        if result.get('rtkTokenOptimization'):
            return_payload_base['rtkTokenOptimization'] = result.get('rtkTokenOptimization')
        return _compact_temporal_return_payload(
            return_payload_base,
            result,
            legacy_id=legacy_id,
            name=payload.get('name') or entry.get('name'),
            command=entry['command'],
        )

    # Defense in depth: preflight should already reject this branch. Never turn an
    # unknown/non-script automation into a successful Temporal execution.
    completed_at = datetime.datetime.now(datetime.timezone.utc).isoformat()
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
