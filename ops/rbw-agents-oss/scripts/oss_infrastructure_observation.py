#!/usr/bin/env python3
"""Read-only core infrastructure diagnostics. Contains no remediation operations."""
from __future__ import annotations
import argparse, hashlib, json, os, shlex, socket, subprocess, time
from pathlib import Path
from typing import Any
from lib.wrapper_sdk import atomic_write_json, now_iso, write_report
ROOT=Path('/srv/rbw-agents-oss')
OPS=Path('/home/craft/.craft-agent/workspaces/my-workspace-2/campaigns/ops')
SLUG='infra-exposure-autoremediation-guard'
POLICY_PATH=ROOT/'config/infra-exposure-autoremediation-policy.json'
ACTION_QUEUE_PATH=OPS/'infra-exposure-observation-action-queue.json'
HISTORY_PATH=OPS/'infra-exposure-observation-history.jsonl'
REMOTE_PROBE = r'''
python3 - <<'PYREMOTE'
import json, os, re, subprocess

def run(cmd, timeout=10):
    try:
        p = subprocess.run(cmd, shell=True, text=True, capture_output=True, timeout=timeout)
        return {'ok': p.returncode == 0, 'exitCode': p.returncode, 'stdout': p.stdout, 'stderr': p.stderr}
    except Exception as e:
        return {'ok': False, 'exitCode': None, 'stdout': '', 'stderr': repr(e)}

def active(service):
    p = run('systemctl is-active ' + service, timeout=5)
    return p['ok'] and p['stdout'].strip() == 'active'

def parse_ss_listeners(unsafe_ports):
    out = run('ss -H -lntup 2>/dev/null', timeout=8)['stdout']
    rows = []
    for line in out.splitlines():
        parts = line.split()
        if len(parts) < 5:
            continue
        local = parts[4]
        m = re.search(r':(\d+)$', local.replace(']', ''))
        if not m:
            continue
        port = int(m.group(1))
        if port not in unsafe_ports:
            continue
        host = local.rsplit(':', 1)[0].strip('[]')
        public = host in ('0.0.0.0', '::', '*') or (host and not host.startswith('127.') and host != '::1')
        rows.append({'proto': parts[0], 'state': parts[1], 'local': local, 'port': port, 'public': public, 'line': line[:500]})
    return rows

def parse_smtp_sockets():
    out = run('ss -H -ntp 2>/dev/null', timeout=8)['stdout']
    rows = []
    for line in out.splitlines():
        parts = line.split()
        if len(parts) < 5:
            continue
        peer = parts[4]
        if re.search(r':25$', peer.replace(']', '')):
            rows.append({'peer': peer, 'line': line[:500]})
    return rows

def docker_rows():
    command = ("/opt/ia-webdev/bin/rbw-docker-guard docker -- ps -a --format '{{json .}}'"
               if os.environ.get('RBW_DEV_DIAGNOSTICS') == '1'
               else "docker ps -a --format '{{json .}}' 2>/dev/null")
    p = run(command, timeout=15)
    rows = []
    for line in p['stdout'].splitlines():
        try:
            rows.append(json.loads(line))
        except Exception:
            pass
    issues = [] if p['ok'] else [{'issue': 'docker_probe_failed', 'status': 'diagnostic_unavailable'}]
    for r in rows:
        status = str(r.get('Status') or '')
        issue = None
        if 'Restarting' in status:
            issue = 'restarting'
        elif 'unhealthy' in status.lower():
            issue = 'unhealthy'
        if issue:
            issues.append({'name': r.get('Names'), 'image': r.get('Image'), 'status': status, 'issue': issue})
    return rows, issues

def iptables_summary(unsafe_ports):
    output = run('sudo -n iptables -S OUTPUT 2>/dev/null || iptables -S OUTPUT 2>/dev/null', timeout=8)['stdout']
    docker = run('sudo -n iptables -S DOCKER-USER 2>/dev/null || iptables -S DOCKER-USER 2>/dev/null', timeout=8)['stdout']
    input_ = run('sudo -n iptables -S INPUT 2>/dev/null || iptables -S INPUT 2>/dev/null', timeout=8)['stdout']
    def has_smtp(text):
        return '--dport 25' in text and any(x in text for x in [' -j REJECT', ' -j DROP'])
    blocked_ports = []
    for port in unsafe_ports:
        if f'--dport {port}' in input_ and any(x in input_ for x in [' -j REJECT', ' -j DROP']):
            blocked_ports.append(port)
    return {
        'outputSmtpBlocked': has_smtp(output),
        'dockerSmtpBlocked': has_smtp(docker),
        'unsafeInputBlockedPorts': blocked_ports,
        'inputRulesRbw': [l for l in input_.splitlines() if 'rbw-' in l],
        'outputRulesRbw': [l for l in output.splitlines() if 'rbw-' in l],
        'dockerUserRulesRbw': [l for l in docker.splitlines() if 'rbw-' in l],
    }

unsafe_ports = [int(x) for x in os.environ.get('UNSAFE_PROXY_PORTS', '1080 1081 1088 9050 3128 8118').split() if x]
mail_services = os.environ.get('MAIL_SERVICES', 'postfix exim4 sendmail opensmtpd').split()
containers, docker_issues = docker_rows()
probe = {
    'hostname': run('hostname', timeout=5)['stdout'].strip(),
    'generatedAtRemote': run('date -Is', timeout=5)['stdout'].strip(),
    'uptime': run('uptime -p', timeout=5)['stdout'].strip(),
    'publicProxyListeners': [r for r in parse_ss_listeners(unsafe_ports) if r.get('public')],
    'allUnsafeProxyListeners': parse_ss_listeners(unsafe_ports),
    'smtpSockets': parse_smtp_sockets(),
    'mailServices': {s: active(s) for s in mail_services},
    'dockerIssues': docker_issues,
    'dockerContainersSample': containers[:80],
    'iptables': iptables_summary(unsafe_ports),
    'antiSpamGuardActive': active('rbw-anti-spam-guard.service'),
    'microsocks': {
        'active': active('microsocks.service'),
        'unit': run('systemctl cat microsocks 2>/dev/null', timeout=8)['stdout'],
        'processes': run('pgrep -a microsocks 2>/dev/null || true', timeout=5)['stdout'].splitlines(),
    },
}
print(json.dumps(probe, ensure_ascii=False))
PYREMOTE
'''

def load_json(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except Exception:
        return default



def save_json(path: Path, payload: Any) -> None:
    atomic_write_json(path, payload)



def append_jsonl(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('a', encoding='utf-8') as f:
        f.write(json.dumps(payload, ensure_ascii=False) + '\n')



def stable_id(payload: Any) -> str:
    return hashlib.sha256(json.dumps(payload, ensure_ascii=False, sort_keys=True).encode()).hexdigest()[:16]



def run_local(cmd: list[str], timeout: int = 30) -> dict[str, Any]:
    started = time.time()
    try:
        proc = subprocess.run(cmd, text=True, capture_output=True, timeout=timeout)
        return {'ok': proc.returncode == 0, 'exitCode': proc.returncode, 'stdout': proc.stdout, 'stderr': proc.stderr, 'durationSeconds': round(time.time() - started, 3), 'command': cmd}
    except Exception as exc:
        return {'ok': False, 'exitCode': None, 'stdout': '', 'stderr': repr(exc), 'durationSeconds': round(time.time() - started, 3), 'command': cmd}



def compact_run(result: dict[str, Any], limit: int = 1200) -> dict[str, Any]:
    return {'ok': result.get('ok'), 'exitCode': result.get('exitCode'), 'durationSeconds': result.get('durationSeconds'), 'stdoutTail': str(result.get('stdout') or '')[-limit:], 'stderr': str(result.get('stderr') or '')[-limit:]}



def public_server(server: dict[str, Any]) -> dict[str, Any]:
    return {k: server.get(k) for k in ['alias', 'host', 'user', 'port', 'role', 'autoRemediate', 'ovhIpService', 'local']}



def ssh_command(server: dict[str, Any], remote: str, timeout: int = 60) -> dict[str, Any]:
    if server.get('local'):
        return run_local(['bash', '-lc', remote], timeout=timeout)
    cmd = [
        'ssh', '-i', str(server.get('sshKey') or '~/.ssh/id_ecdsa_vps'), '-p', str(server.get('port') or 22),
        '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=8',
        f"{server.get('user')}@{server.get('host')}", remote,
    ]
    return run_local(cmd, timeout=timeout)



def probe_server(server: dict[str, Any], policy: dict[str, Any]) -> dict[str, Any]:
    env = 'UNSAFE_PROXY_PORTS=' + shlex.quote(' '.join(map(str, policy.get('unsafePublicProxyPorts') or []))) + ' MAIL_SERVICES=' + shlex.quote(' '.join((policy.get('smtp') or {}).get('mailServices') or [])) + ' '
    if server.get('alias') == 'dev':
        env += 'RBW_DEV_DIAGNOSTICS=1 '
    result = ssh_command(server, env + REMOTE_PROBE, timeout=90)
    parsed = None
    if result.get('ok'):
        try:
            parsed = json.loads(result['stdout'].strip().splitlines()[-1])
        except Exception as exc:
            result['parseError'] = repr(exc)
    return {'server': public_server(server), 'ssh': compact_run(result), 'probe': parsed}



def public_port_reachable(host: str, port: int, timeout: float = 2.0) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except Exception:
        return False



def classify(server: dict[str, Any], row: dict[str, Any], policy: dict[str, Any]) -> dict[str, Any]:
    probe = row.get('probe')
    if not probe:
        return {'errors': [{'code': 'ssh_or_probe_failed', 'server': server.get('alias')}], 'warnings': [], 'needs': [], 'mailServiceActive': False}
    errors, warnings, infos, needs = [], [], [], []
    public_proxy = probe.get('publicProxyListeners') or []
    if public_proxy:
        errors.append({'code': 'unsafe_public_proxy_listener', 'server': server.get('alias'), 'listeners': public_proxy[:20]})
        needs.append('block_public_proxy_ports')
    external = [p for p in sorted(policy.get('unsafePublicProxyPorts') or []) if public_port_reachable(str(server.get('host')), int(p))]
    if external:
        errors.append({'code': 'unsafe_proxy_port_reachable_from_oss', 'server': server.get('alias'), 'ports': external})
        needs.append('block_public_proxy_ports')
    mail_active = any((probe.get('mailServices') or {}).values())
    smtp_sockets = probe.get('smtpSockets') or []
    if smtp_sockets and not mail_active:
        errors.append({'code': 'direct_smtp_socket_on_non_mail_server', 'server': server.get('alias'), 'sockets': smtp_sockets[:30]})
        needs.append('block_direct_smtp_egress')
    ipt = probe.get('iptables') or {}
    expected_proxy_ports = set(policy.get('unsafePublicProxyPorts') or [])
    blocked_proxy_ports = set(ipt.get('unsafeInputBlockedPorts') or [])
    if server.get('autoRemediate') and not expected_proxy_ports.issubset(blocked_proxy_ports):
        needs.append('ensure_public_proxy_guard')
    if server.get('autoRemediate') and not mail_active and not (ipt.get('outputSmtpBlocked') and ipt.get('dockerSmtpBlocked')):
        warnings.append({'code': 'smtp_egress_guard_missing', 'server': server.get('alias'), 'outputBlocked': ipt.get('outputSmtpBlocked'), 'dockerBlocked': ipt.get('dockerSmtpBlocked')})
        needs.append('block_direct_smtp_egress')
    if server.get('autoRemediate') and mail_active and not (ipt.get('outputSmtpBlocked') and ipt.get('dockerSmtpBlocked')):
        infos.append({'code': 'smtp_egress_block_skipped_mail_service_active', 'server': server.get('alias'), 'mailServices': probe.get('mailServices')})
    docker_issues = probe.get('dockerIssues') or []
    if docker_issues:
        warnings.append({'code': 'docker_restart_or_unhealthy_containers', 'server': server.get('alias'), 'count': len(docker_issues), 'sample': docker_issues[:20]})
        needs.append('bounded_docker_restart')
    return {'errors': errors, 'warnings': warnings, 'infos': infos, 'needs': sorted(set(needs)), 'mailServiceActive': mail_active}



def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--no-remediate',action='store_true',help='Compatibility only; this component is always read-only.')
    args=parser.parse_args()
    policy=load_json(POLICY_PATH,{})
    expected={'dev':'164.132.161.150','interne':'146.59.230.253','prod':'92.222.101.25'}
    servers=[s for s in policy.get('servers',[]) if isinstance(s,dict) and
             s.get('alias') in expected and s.get('host')==expected[s['alias']]]
    if len(servers)!=3 or len({s['alias'] for s in servers})!=3:
        raise ValueError('core_server_policy_incomplete_or_mismatched')
    rows=[];classes={};errors=[];warnings=[];infos=[];queue=[]
    for server in servers:
        row=probe_server(server,policy);rows.append(row)
        cls=classify(server,row,policy);classes[server['alias']]=cls
        errors.extend(cls.get('errors',[]));warnings.extend(cls.get('warnings',[]));infos.extend(cls.get('infos',[]))
        for finding in cls.get('errors',[])+cls.get('warnings',[]):
            target={'server':server['alias'],'code':finding['code']}
            queue.append({'id':stable_id(target),'originAutomation':SLUG,
                          'actionType':'read_only_infrastructure_investigation','owner':'agent',
                          'actionableNow':True,'target':target,'finding':finding,
                          'mutationAllowed':False,'externalSendAllowed':False,
                          'requiresExplicitInfrastructureApproval':True,
                          'dedupeKey':SLUG+':'+server['alias']+':'+finding['code']})
    counts={'serversTargeted':len(servers),'sshProbeFailures':sum(not r['ssh']['ok'] for r in rows),
            'remediationsAttempted':0,'errorsAfter':len(errors),'warningsAfter':len(warnings),
            'infosAfter':len(infos),'actionQueue':len(queue),'ovhChecked':0}
    ok=not errors and not warnings
    payload={'generatedAt':now_iso(),'contractVersion':'infra-read-only-observation-v1',
             'capabilityId':SLUG,'ok':ok,'status':'passed' if ok else 'needs_agent_repair',
             'summary':'Read-only infrastructure observation; mutations require separate authorization.',
             'counts':counts,'errors':errors,'warnings':warnings,'infos':infos,
             'after':rows,'classificationsAfter':classes,'actionQueue':queue,
             'blockingReasons':sorted({x['code'] for x in errors}),
             'warningReasons':sorted({x['code'] for x in warnings}),
             'checks':{'technicalProbeExecuted':True,'manualRemediationMode':True,
                       'infrastructureMutationAllowed':False,'runtimeRestartAllowed':False},
             'artifacts':{'actionQueue':str(ACTION_QUEUE_PATH),'historyJsonl':str(HISTORY_PATH)}}
    save_json(ACTION_QUEUE_PATH,{'generatedAt':payload['generatedAt'],'items':queue})
    payload['artifacts'].update(write_report(SLUG,payload,title='Read-only infrastructure observation'))
    write_report(SLUG,payload,title='Read-only infrastructure observation')
    append_jsonl(HISTORY_PATH,{'generatedAt':payload['generatedAt'],'counts':counts,'ok':ok})
    print(json.dumps({k:payload[k] for k in ('ok','status','counts','artifacts')},ensure_ascii=False))
    return 0 if ok else 1
if __name__=='__main__':raise SystemExit(main())
