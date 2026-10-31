"""Read-only core infrastructure diagnostics. Contains no remediation operations."""
from __future__ import annotations

import argparse
import hashlib
import json
import shlex
import socket
import subprocess
import time
from pathlib import Path

from lib.wrapper_sdk import atomic_write_json, now_iso, write_report
from pydantic import JsonValue, TypeAdapter

ROOT=Path('/srv/rbw-agents-oss')
OPS=Path('/home/craft/.craft-agent/workspaces/my-workspace-2/campaigns/ops')
SLUG='infra-exposure-autoremediation-guard'
POLICY_PATH=ROOT/'config/infra-exposure-autoremediation-policy.json'
ACTION_QUEUE_PATH=OPS/'infra-exposure-observation-action-queue.json'
HISTORY_PATH=OPS/'infra-exposure-observation-history.jsonl'
REMOTE_PROBE = "python3 - <<'PYREMOTE'\n" + Path(__file__).with_name('infrastructure_probe.py').read_text() + "\nPYREMOTE\n"
JSON_OBJECT = TypeAdapter(dict[str, JsonValue])
JSON_ROWS = TypeAdapter(list[dict[str, JsonValue]])
STRINGS = TypeAdapter(list[str])
PORTS = TypeAdapter(list[int])

def load_json(path: Path, default: JsonValue) -> JsonValue:
    try:
        return TypeAdapter(JsonValue).validate_json(path.read_bytes())
    except (OSError, ValueError):
        return default



def save_json(path: Path, payload: JsonValue) -> None:
    atomic_write_json(path, JSON_OBJECT.validate_python(payload))



def append_jsonl(path: Path, payload: dict[str, JsonValue]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('a', encoding='utf-8') as f:
        _ = f.write(json.dumps(payload, ensure_ascii=False) + '\n')



def stable_id(payload: JsonValue) -> str:
    return hashlib.sha256(json.dumps(payload, ensure_ascii=False, sort_keys=True).encode()).hexdigest()[:16]



def run_local(cmd: list[str], timeout: int = 30) -> dict[str, JsonValue]:
    started = time.time()
    try:
        proc = subprocess.run(cmd, text=True, capture_output=True, timeout=timeout, check=False)
        return {'ok': proc.returncode == 0, 'exitCode': proc.returncode, 'stdout': proc.stdout, 'stderr': proc.stderr, 'durationSeconds': round(time.time() - started, 3), 'command': list(cmd)}
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        return {'ok': False, 'exitCode': None, 'stdout': '', 'stderr': repr(exc), 'durationSeconds': round(time.time() - started, 3), 'command': list(cmd)}



def compact_run(result: dict[str, JsonValue], limit: int = 1200) -> dict[str, JsonValue]:
    return {'ok': result.get('ok'), 'exitCode': result.get('exitCode'), 'durationSeconds': result.get('durationSeconds'), 'stdoutTail': str(result.get('stdout') or '')[-limit:], 'stderr': str(result.get('stderr') or '')[-limit:]}



def public_server(server: dict[str, JsonValue]) -> dict[str, JsonValue]:
    return {k: server.get(k) for k in ['alias', 'host', 'user', 'port', 'role', 'autoRemediate', 'ovhIpService', 'local']}



def ssh_command(server: dict[str, JsonValue], remote: str, timeout: int = 60) -> dict[str, JsonValue]:
    if server.get('local'):
        return run_local(['bash', '-lc', remote], timeout=timeout)
    cmd = [
        'ssh', '-i', str(server.get('sshKey') or '~/.ssh/id_ecdsa_vps'), '-p', str(server.get('port') or 22),
        '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=8',
        f"{server.get('user')}@{server.get('host')}", remote,
    ]
    return run_local(cmd, timeout=timeout)



def probe_server(server: dict[str, JsonValue], policy: dict[str, JsonValue]) -> dict[str, JsonValue]:
    env = 'UNSAFE_PROXY_PORTS=' + shlex.quote(' '.join(map(str, PORTS.validate_python(policy.get('unsafePublicProxyPorts') or [])))) + ' MAIL_SERVICES=' + shlex.quote(' '.join(STRINGS.validate_python(JSON_OBJECT.validate_python(policy.get('smtp') or {}).get('mailServices') or []))) + ' '
    if server.get('alias') == 'dev':
        env += 'RBW_DEV_DIAGNOSTICS=1 '
    result = ssh_command(server, env + REMOTE_PROBE, timeout=90)
    parsed: JsonValue = None
    if result.get('ok'):
        try:
            parsed = JSON_OBJECT.validate_json(TypeAdapter(str).validate_python(result['stdout']).strip().rsplit('\n', 1)[-1])
        except (OSError, ValueError, subprocess.SubprocessError) as exc:
            result['parseError'] = repr(exc)
    return {'server': public_server(server), 'ssh': compact_run(result), 'probe': parsed}



def public_port_reachable(host: str, port: int, timeout: float = 2.0) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False



def classify(server: dict[str, JsonValue], row: dict[str, JsonValue], policy: dict[str, JsonValue]) -> dict[str, JsonValue]:
    probe = JSON_OBJECT.validate_python(row.get('probe') or {})
    if not probe or not all(key in probe for key in ('publicProxyListeners', 'smtpSockets', 'mailServices', 'iptables', 'dockerIssues', 'probeErrors')):
        return {'errors': [{'code': 'ssh_or_probe_failed', 'server': server.get('alias')}], 'warnings': [], 'needs': [], 'mailServiceActive': False}
    errors: list[dict[str, JsonValue]] = JSON_ROWS.validate_python(probe.get('probeErrors') or [])
    warnings: list[dict[str, JsonValue]] = []
    infos: list[dict[str, JsonValue]] = []
    needs: list[str] = []
    public_proxy = JSON_ROWS.validate_python(probe.get('publicProxyListeners') or [])
    if public_proxy:
        errors.append({'code': 'unsafe_public_proxy_listener', 'server': server.get('alias'), 'listeners': list(public_proxy[:20])})
        needs.append('block_public_proxy_ports')
    external = [p for p in sorted(PORTS.validate_python(policy.get('unsafePublicProxyPorts') or [])) if public_port_reachable(str(server.get('host')), int(p))]
    if external:
        errors.append({'code': 'unsafe_proxy_port_reachable_from_oss', 'server': server.get('alias'), 'ports': list(external)})
        needs.append('block_public_proxy_ports')
    mail_active = any(JSON_OBJECT.validate_python(probe.get('mailServices') or {}).values())
    smtp_sockets = JSON_ROWS.validate_python(probe.get('smtpSockets') or [])
    if smtp_sockets and not mail_active:
        errors.append({'code': 'direct_smtp_socket_on_non_mail_server', 'server': server.get('alias'), 'sockets': list(smtp_sockets[:30])})
        needs.append('block_direct_smtp_egress')
    ipt = JSON_OBJECT.validate_python(probe.get('iptables') or {})
    expected_proxy_ports = set(PORTS.validate_python(policy.get('unsafePublicProxyPorts') or []))
    blocked_proxy_ports = set(PORTS.validate_python(ipt.get('unsafeInputBlockedPorts') or []))
    if server.get('autoRemediate') and not expected_proxy_ports.issubset(blocked_proxy_ports):
        needs.append('ensure_public_proxy_guard')
    if server.get('autoRemediate') and not mail_active and not (ipt.get('outputSmtpBlocked') and ipt.get('dockerSmtpBlocked')):
        warnings.append({'code': 'smtp_egress_guard_missing', 'server': server.get('alias'), 'outputBlocked': ipt.get('outputSmtpBlocked'), 'dockerBlocked': ipt.get('dockerSmtpBlocked')})
        needs.append('block_direct_smtp_egress')
    if server.get('autoRemediate') and mail_active and not (ipt.get('outputSmtpBlocked') and ipt.get('dockerSmtpBlocked')):
        infos.append({'code': 'smtp_egress_block_skipped_mail_service_active', 'server': server.get('alias'), 'mailServices': probe.get('mailServices')})
    docker_issues = JSON_ROWS.validate_python(probe.get('dockerIssues') or [])
    if docker_issues:
        warnings.append({'code': 'docker_restart_or_unhealthy_containers', 'server': server.get('alias'), 'count': len(docker_issues), 'sample': list(docker_issues[:20])})
        needs.append('bounded_docker_restart')
    return {'errors': list(errors), 'warnings': list(warnings), 'infos': list(infos), 'needs': [need for need in sorted(set(needs))], 'mailServiceActive': mail_active}



def main() -> int:
    parser=argparse.ArgumentParser()
    _ = parser.add_argument('--no-remediate',action='store_true',help='Compatibility only; this component is always read-only.')
    _ = parser.parse_args()
    policy=JSON_OBJECT.validate_python(load_json(POLICY_PATH,{}))
    expected={'dev':'164.132.161.150','interne':'146.59.230.253','prod':'92.222.101.25'}
    servers=[s for s in JSON_ROWS.validate_python(policy.get('servers',[]))
             if isinstance(s.get('alias'), str) and s.get('host')==expected.get(str(s['alias']))]
    if len(servers)!=3 or len({str(s['alias']) for s in servers})!=3:
        raise ValueError('core_server_policy_incomplete_or_mismatched')
    rows: list[dict[str, JsonValue]] = []
    classes: dict[str, JsonValue] = {}
    errors: list[dict[str, JsonValue]] = []
    warnings: list[dict[str, JsonValue]] = []
    infos: list[dict[str, JsonValue]] = []
    queue: list[dict[str, JsonValue]] = []
    for server in servers:
        row=probe_server(server,policy);rows.append(row)
        cls=classify(server,row,policy);classes[str(server['alias'])]=cls
        errors.extend(JSON_ROWS.validate_python(cls.get('errors',[])));warnings.extend(JSON_ROWS.validate_python(cls.get('warnings',[])));infos.extend(JSON_ROWS.validate_python(cls.get('infos',[])))
        for finding in JSON_ROWS.validate_python(cls.get('errors',[]))+JSON_ROWS.validate_python(cls.get('warnings',[])):
            target: dict[str, JsonValue] = {'server':server['alias'],'code':finding['code']}
            queue.append({'id':stable_id(target),'originAutomation':SLUG,
                          'actionType':'read_only_infrastructure_investigation','owner':'agent',
                          'actionableNow':True,'target':target,'finding':finding,
                          'mutationAllowed':False,'externalSendAllowed':False,
                          'requiresExplicitInfrastructureApproval':True,
                          'dedupeKey':SLUG+':'+str(server['alias'])+':'+str(finding['code'])})
    counts={'serversTargeted':len(servers),'sshProbeFailures':sum(not JSON_OBJECT.validate_python(r['ssh'])['ok'] for r in rows),
            'remediationsAttempted':0,'errorsAfter':len(errors),'warningsAfter':len(warnings),
            'infosAfter':len(infos),'actionQueue':len(queue),'ovhChecked':0}
    ok=not errors and not warnings
    payload=JSON_OBJECT.validate_python({'generatedAt':now_iso(),'contractVersion':'infra-read-only-observation-v1',
             'capabilityId':SLUG,'ok':ok,'status':'passed' if ok else 'needs_agent_repair',
             'summary':'Read-only infrastructure observation; mutations require separate authorization.',
             'counts':counts,'errors':errors,'warnings':warnings,'infos':infos,
             'after':rows,'classificationsAfter':classes,'actionQueue':queue,
             'blockingReasons':sorted({str(x['code']) for x in errors}),
             'warningReasons':sorted({str(x['code']) for x in warnings}),
             'checks':{'technicalProbeExecuted':True,'manualRemediationMode':True,
                       'infrastructureMutationAllowed':False,'runtimeRestartAllowed':False},
             'artifacts':{'actionQueue':str(ACTION_QUEUE_PATH),'historyJsonl':str(HISTORY_PATH)}})
    save_json(ACTION_QUEUE_PATH,JSON_OBJECT.validate_python({'generatedAt':payload['generatedAt'],'items':queue}))
    artifacts = JSON_OBJECT.validate_python(payload['artifacts'])
    artifacts.update(write_report(SLUG,payload,title='Read-only infrastructure observation'))
    payload['artifacts'] = artifacts
    _ = write_report(SLUG,payload,title='Read-only infrastructure observation')
    append_jsonl(HISTORY_PATH,JSON_OBJECT.validate_python({'generatedAt':payload['generatedAt'],'counts':counts,'ok':ok}))
    print(json.dumps({k:payload[k] for k in ('ok','status','counts','artifacts')},ensure_ascii=False))
    return 0 if ok else 1
if __name__=='__main__':raise SystemExit(main())
