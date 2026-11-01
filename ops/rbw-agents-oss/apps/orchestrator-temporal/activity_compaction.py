from __future__ import annotations

import json
import os
import re
from collections import Counter
from pathlib import Path

from pydantic import JsonValue, TypeAdapter, ValidationError

type JsonObject = dict[str, JsonValue]
JSON_ADAPTER = TypeAdapter(JsonValue)

def _integer(value: JsonValue, default: int) -> int:
    value = value or default
    if not isinstance(value, (str, int, float)):
        raise TypeError("Expected a JSON number or numeric string")
    return int(value)

def _text(value: JsonValue) -> str:
    value = value or ""
    if not isinstance(value, str):
        raise TypeError("Expected text output")
    return value

__all__ = ['RTK_TOKEN_CONFIG', '_compact_lines', '_compact_result_observation',
           '_compact_temporal_return_payload', '_estimate_tokens', '_hard_cap_json_status',
           '_json_compact', '_load_rtk_token_config', '_rtk_metrics_payload',
           '_rtk_optimize_output', '_tail_text', '_try_parse_json_blob']

RTK_TOKEN_CONFIG = Path('/srv/rbw-agents-oss/config/temporal/rtk-token-optimization.json')

def _load_rtk_token_config() -> JsonObject:
    defaults: JsonObject = {
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
            loaded = JSON_ADAPTER.validate_json(RTK_TOKEN_CONFIG.read_bytes())
            if isinstance(loaded, dict):
                defaults.update(loaded)
    except (OSError, UnicodeError, ValidationError):
        pass
    if os.getenv('RBW_TEMPORAL_RTK_TOKEN_OPTIMIZATION', '').lower() in {'0', 'false', 'no', 'off'}:
        defaults['enabled'] = False
    return defaults

def _estimate_tokens(text: str, cfg: JsonObject) -> int:
    chars_per_token = _integer(cfg.get('estimateCharsPerToken'), 4) or 4
    return max(0, int((len(text or '') + chars_per_token - 1) / chars_per_token))

def _json_compact(value: JsonValue, cfg: JsonObject, depth: int = 0) -> JsonValue:
    string_limit = _integer(cfg.get('jsonStringLimit'), 220)
    array_sample = _integer(cfg.get('jsonArraySample'), 3)
    max_keys = _integer(cfg.get('maxObjectKeys'), 24)
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
    priority = [
        'ok', 'status', 'summary', 'counts', 'blockingReasons', 'generatedAt',
        'capabilityId', 'legacyId', 'name', 'mode', 'exitCode', 'timeout',
        'businessFailure', 'jsonStatus', 'artifacts', 'reportJson', 'reportMd',
        'nextActions', 'actionQueue', 'workflowResults', 'checks', 'error', 'errorType',
    ]
    keys: list[str] = []
    for key in priority:
        if key in value and key not in keys:
            keys.append(key)
    for key in sorted(value.keys(), key=lambda x: str(x)):
        if key not in keys:
            keys.append(key)
        if len(keys) >= max_keys:
            break
    out: JsonObject = {str(k): _json_compact(value.get(k), cfg, depth + 1) for k in keys}
    omitted = max(0, len(value) - len(keys))
    if omitted:
        out['_omittedKeys'] = omitted
    return out

def _try_parse_json_blob(text: str) -> JsonValue:
    raw = (text or '').strip()
    if not raw:
        return None
    candidates = [raw]
    candidates.extend([line.strip() for line in raw.splitlines()[::-1] if line.strip().startswith(('{', '['))][:8])
    for candidate in candidates:
        try:
            return JSON_ADAPTER.validate_json(candidate)
        except ValidationError:
            continue
    return None

def _hard_cap_json_status(value: JsonValue, max_bytes: int = 8192) -> JsonValue:
    if not isinstance(value, dict):
        return value
    try:
        if len(json.dumps(value, ensure_ascii=False).encode('utf-8')) <= max_bytes:
            return value
    except (TypeError, ValueError, UnicodeError):
        pass
    compact_cfg: JsonObject = {'jsonStringLimit': 300, 'jsonArraySample': 4, 'jsonDictKeys': 24}
    out: JsonObject = {
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
    except (TypeError, ValueError, UnicodeError):
        pass
    return {k: v for k, v in out.items() if v not in (None, {}, [], '')}

def _compact_lines(text: str, cfg: JsonObject, budget: int, stream: str) -> tuple[str, str]:
    raw_lines = [line.rstrip() for line in (text or '').splitlines() if line.strip()]
    if not raw_lines:
        return '', 'empty'
    important_re = re.compile(r'(traceback|error|exception|failed|fatal|timeout|warning|denied|not found|module|syntax|runtimeerror|applicationerror)', re.IGNORECASE)
    important = [line for line in raw_lines if important_re.search(line)]
    counts = Counter(raw_lines)
    duplicate_groups = [(line, count) for line, count in counts.items() if count > 1]
    lines: list[str] = []
    if important:
        lines.append(f'[rtk:{stream}:important_lines count={len(important)}]')
        lines.extend(important[: _integer(cfg.get('importantLineLimit'), 30)])
    if duplicate_groups:
        lines.append(f'[rtk:{stream}:deduplicated repeats={len(duplicate_groups)}]')
        for line, count in duplicate_groups[:12]:
            lines.append(f'{count}× {line[:220]}')
    head = _integer(cfg.get('lineHead'), 18)
    tail = _integer(cfg.get('lineTail'), 12)
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

def _rtk_optimize_output(text: str, *, stream: str, command: str = '', legacy_id: str | None = None, ok: bool | None = None) -> JsonObject:
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
    budget = _integer(cfg.get('previewCharBudget'), 900)
    if stream == 'stderr' or ok is False:
        budget = _integer(cfg.get('errorPreviewCharBudget'), 1400)
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

def _rtk_metrics_payload(*stream_results: tuple[str, JsonObject]) -> JsonObject | None:
    """Return only useful RTK metrics for Temporal payloads.

    V2 omits zero-savings metadata so small successful runs do not pay a token
    tax for optimization bookkeeping. Metrics are included whenever at least one
    stream actually saved tokens.
    """
    cfg = _load_rtk_token_config()
    include_zero = bool(cfg.get('includeZeroSavingsMetrics'))
    min_saved = _integer(cfg.get('metricsMinSavedTokens'), 1)
    out: JsonObject = {}
    total_original = total_preview = total_saved = 0
    for name, stats in stream_results:
        saved = _integer(stats.get('estimatedSavedTokens'), 0)
        original = _integer(stats.get('estimatedOriginalTokens'), 0)
        preview = _integer(stats.get('estimatedPreviewTokens'), 0)
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

def _compact_result_observation(result: JsonObject) -> JsonObject:
    """Compact workflow-runs result logs without changing semantics.

    Missing boolean/empty fields are interpreted as their defaults by existing
    consumers. Failures keep diagnostic fields; success paths omit zero/false
    noise that dominates high-frequency small wrappers.
    """
    out: JsonObject = {
        'ok': bool(result.get('ok')),
        'exitCode': _integer(result.get('exitCode'), 0),
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
    stdout_bytes = _integer(result.get('stdoutBytes'), len(_text(result.get('stdout')).encode('utf-8', errors='ignore')))
    stderr_bytes = _integer(result.get('stderrBytes'), len(_text(result.get('stderr')).encode('utf-8', errors='ignore')))
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

def _compact_temporal_return_payload(base: JsonObject, result: JsonObject, *, legacy_id: str | None, name: str | None, command: str | None) -> JsonObject:
    """Build the compact activity return stored in Temporal history.

    Keep the fields the workflow and operators need, omit defaults on success,
    and keep richer diagnostics for failures/timeouts/business failures.
    """
    cfg = _load_rtk_token_config()
    compact_enabled = bool(cfg.get('compactTemporalResult', True))
    if not compact_enabled:
        return base
    ok = bool(result.get('ok'))
    out: JsonObject = {
        'ok': ok,
        'legacyId': legacy_id,
        'exitCode': _integer(result.get('exitCode'), 0),
    }
    if base.get('completedAt'):
        out['completedAt'] = base.get('completedAt')
    if result.get('durationSeconds') is not None:
        out['durationSeconds'] = result.get('durationSeconds')
    # Preserve operator context on failures; omit repeated static fields on success.
    if name and ((not ok) or cfg.get('includeSuccessNameInTemporalResult')):
        out['name'] = name
    if command and ((not ok) or cfg.get('includeSuccessCommandInTemporalResult')):
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

def _tail_text(value: JsonValue, limit: int = 2000) -> str:
    text = str(value or '')
    if len(text) <= limit:
        return text
    return text[-limit:]
