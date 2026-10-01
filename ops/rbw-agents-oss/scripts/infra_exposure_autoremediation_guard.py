#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shlex
import socket
import subprocess
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from lib.wrapper_sdk import atomic_write_json, now_iso, write_report

ROOT = Path('/srv/rbw-agents-oss')
OPS = Path('/home/craft/.craft-agent/workspaces/my-workspace-2/campaigns/ops')
SLUG = 'infra-exposure-autoremediation-guard'
POLICY_PATH = ROOT / 'config/infra-exposure-autoremediation-policy.json'
OVH_INFRA_SECRET_ENV = ROOT / 'secrets/ovh-infrastructure-full.env'
OVH_SECRET_ENV = ROOT / 'secrets/ovh-domain-sentinel.env'
STATE_PATH = OPS / 'infra-exposure-autoremediation-state.json'
ACTION_QUEUE_PATH = OPS / 'infra-exposure-autoremediation-action-queue.json'
HISTORY_PATH = OPS / 'infra-exposure-autoremediation-history.jsonl'

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
    p = run("docker ps -a --format '{{json .}}' 2>/dev/null", timeout=15)
    rows = []
    for line in p['stdout'].splitlines():
        try:
            rows.append(json.loads(line))
        except Exception:
            pass
    issues = []
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


def load_env_file(path: Path) -> None:
    if not path.exists():
        return
    for raw in path.read_text(encoding='utf-8', errors='ignore').splitlines():
        line = raw.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        k, v = line.split('=', 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

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


def docker_restart_allowed(state: dict[str, Any], alias: str, name: str, cooldown_hours: float) -> bool:
    last = ((state.get('dockerRestarts') or {}).get(f'{alias}:{name}') or {}).get('at')
    if not last:
        return True
    try:
        dt = datetime.fromisoformat(str(last).replace('Z', '+00:00'))
        return (datetime.now(timezone.utc) - dt).total_seconds() > cooldown_hours * 3600
    except Exception:
        return True


def mark_docker_restarts(state: dict[str, Any], alias: str, names: list[str]) -> None:
    rows = state.setdefault('dockerRestarts', {})
    ts = now_iso()
    for name in names:
        key = f'{alias}:{name}'
        prev = rows.get(key) or {}
        rows[key] = {'at': ts, 'count': int(prev.get('count') or 0) + 1}


def remediation_command(policy: dict[str, Any], block_smtp: bool, containers: list[str]) -> str:
    ports = ' '.join(str(p) for p in policy.get('unsafePublicProxyPorts') or [])
    smtp = '1' if block_smtp else '0'
    containers_text = ' '.join(shlex.quote(c) for c in containers)
    return f'''set -euo pipefail
sudo mkdir -p /usr/local/sbin /etc/systemd/system
sudo tee /usr/local/sbin/rbw-anti-spam-guard.sh >/dev/null <<'GUARD'
#!/bin/sh
set -eu
IPT=/usr/sbin/iptables
IP6T=/usr/sbin/ip6tables
PORTS="{ports}"
BLOCK_SMTP="{smtp}"
add_rule() {{ table_cmd="$1"; shift; chain="$1"; shift; if "$table_cmd" -C "$chain" "$@" 2>/dev/null; then return 0; fi; "$table_cmd" -I "$chain" 1 "$@"; }}
for port in $PORTS; do
  add_rule "$IPT" INPUT ! -i lo -p tcp --dport "$port" -m comment --comment rbw-block-public-proxy -j REJECT --reject-with tcp-reset || true
  if [ -x "$IP6T" ]; then add_rule "$IP6T" INPUT ! -i lo -p tcp --dport "$port" -m comment --comment rbw-block-public-proxy-v6 -j REJECT --reject-with tcp-reset || true; fi
done
if [ "$BLOCK_SMTP" = "1" ]; then
  add_rule "$IPT" OUTPUT -p tcp --dport 25 -m comment --comment rbw-block-outbound-smtp -j REJECT --reject-with tcp-reset || true
  $IPT -N DOCKER-USER 2>/dev/null || true
  add_rule "$IPT" DOCKER-USER -p tcp --dport 25 -m conntrack --ctstate NEW -m comment --comment rbw-block-docker-smtp -j REJECT --reject-with tcp-reset || true
  if [ -x "$IP6T" ]; then
    add_rule "$IP6T" OUTPUT -p tcp --dport 25 -m comment --comment rbw-block-outbound-smtp-v6 -j REJECT --reject-with tcp-reset || true
    $IP6T -N DOCKER-USER 2>/dev/null || true
    add_rule "$IP6T" DOCKER-USER -p tcp --dport 25 -m conntrack --ctstate NEW -m comment --comment rbw-block-docker-smtp-v6 -j REJECT --reject-with tcp-reset || true
  fi
fi
GUARD
sudo chmod 0755 /usr/local/sbin/rbw-anti-spam-guard.sh
sudo tee /etc/systemd/system/rbw-anti-spam-guard.service >/dev/null <<'UNIT'
[Unit]
Description=Robinswood anti-spam/proxy exposure guard
After=network-online.target docker.service
Wants=network-online.target
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/rbw-anti-spam-guard.sh
RemainAfterExit=yes
[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --now rbw-anti-spam-guard.service >/dev/null || true
sudo /usr/local/sbin/rbw-anti-spam-guard.sh
if systemctl cat microsocks >/dev/null 2>&1; then
  unit_path=$(systemctl show -p FragmentPath --value microsocks 2>/dev/null || true)
  if [ -n "$unit_path" ] && [ -f "$unit_path" ]; then
    sudo cp -a "$unit_path" "/root/$(basename "$unit_path").infra-guard.$(date -u +%Y%m%dT%H%M%SZ)" || true
    sudo sed -i 's/-i 0\\.0\\.0\\.0/-i 127.0.0.1/g; s/-i \\* /-i 127.0.0.1 /g' "$unit_path" || true
    sudo chown root:root "$unit_path" || true
    sudo chmod 0644 "$unit_path" || true
    sudo systemctl daemon-reload || true
    sudo systemctl restart microsocks || true
  fi
fi
if command -v docker >/dev/null 2>&1; then
  for c in {containers_text}; do [ -n "$c" ] && docker restart "$c" >/dev/null 2>&1 || true; done
fi
printf '{{"ok":true,"blockSmtp":{smtp},"containersRestarted":"{containers_text}"}}\n'
'''


def remediate(server: dict[str, Any], before: dict[str, Any], cls: dict[str, Any], policy: dict[str, Any], state: dict[str, Any], no_remediate: bool) -> dict[str, Any]:
    if no_remediate or not server.get('autoRemediate'):
        return {'attempted': False, 'reason': 'disabled_or_read_only'}
    needs = set(cls.get('needs') or [])
    if not needs:
        return {'attempted': False, 'reason': 'no_remediation_needed'}
    probe = before.get('probe') or {}
    docker_cfg = policy.get('docker') or {}
    cooldown = float(docker_cfg.get('restartCooldownHours') or 4)
    restart_names = []
    if 'bounded_docker_restart' in needs and docker_cfg.get('restartUnhealthyOrRestartingCoreContainers', True):
        for item in probe.get('dockerIssues') or []:
            name = item.get('name')
            if name and docker_restart_allowed(state, str(server.get('alias')), str(name), cooldown):
                restart_names.append(str(name))
    block_smtp = 'block_direct_smtp_egress' in needs and not cls.get('mailServiceActive')
    result = ssh_command(server, 'bash -s <<\'RBWREMOTE\'\n' + remediation_command(policy, block_smtp, restart_names) + '\nRBWREMOTE', timeout=120)
    if restart_names and result.get('ok'):
        mark_docker_restarts(state, str(server.get('alias')), restart_names)
    return {'attempted': True, 'server': server.get('alias'), 'needs': sorted(needs), 'blockSmtp': block_smtp, 'dockerRestartRequested': restart_names, 'run': compact_run(result)}


def load_ovh_env() -> None:
    load_env_file(OVH_INFRA_SECRET_ENV)
    load_env_file(OVH_SECRET_ENV)

def ovh_credentials_present() -> bool:
    load_ovh_env()
    return bool(os.environ.get('OVH_APP_KEY') and os.environ.get('OVH_APP_SECRET') and os.environ.get('OVH_CONSUMER_KEY'))


def ovh_request(method: str, path: str, body: str = '') -> tuple[int, Any]:
    load_ovh_env()
    import hashlib as _hashlib
    endpoint = os.environ.get('OVH_ENDPOINT', 'ovh-eu')
    base = os.environ.get('OVH_BASE_URL') or {'ovh-eu': 'https://eu.api.ovh.com/1.0', 'ovh-ca': 'https://ca.api.ovh.com/1.0'}.get(endpoint, 'https://eu.api.ovh.com/1.0')
    base = base.rstrip('/')
    app = os.environ['OVH_APP_KEY']; secret = os.environ['OVH_APP_SECRET']; ck = os.environ['OVH_CONSUMER_KEY']
    with urllib.request.urlopen(base + '/auth/time', timeout=15) as r:
        ts = r.read().decode().strip()
    url = base + path
    sig = '$1$' + _hashlib.sha1('+'.join([secret, ck, method.upper(), url, body, ts]).encode()).hexdigest()
    headers = {'X-Ovh-Application': app, 'X-Ovh-Consumer': ck, 'X-Ovh-Signature': sig, 'X-Ovh-Timestamp': ts, 'Content-Type': 'application/json'}
    try:
        with urllib.request.urlopen(urllib.request.Request(url, data=body.encode() if body else None, headers=headers, method=method.upper()), timeout=30) as r:
            txt = r.read().decode()
            return r.status, json.loads(txt) if txt else None
    except urllib.error.HTTPError as e:
        txt = e.read().decode(errors='replace')
        try:
            payload = json.loads(txt)
        except Exception:
            payload = txt
        return e.code, payload


def ovh_check(server: dict[str, Any], clean_after: bool, policy: dict[str, Any], no_remediate: bool) -> dict[str, Any]:
    ip = server.get('ovhIpService')
    if not ip:
        return {'checked': False, 'reason': 'no_ip'}
    if not ovh_credentials_present():
        return {'checked': False, 'reason': 'ovh_env_credentials_missing'}
    out = {'checked': True, 'ipService': ip}
    status, payload = ovh_request('GET', f'/ip/{ip}/spam')
    out.update({'listStatusCode': status, 'spamList': payload if isinstance(payload, list) else []})
    if isinstance(payload, list) and ip in payload:
        d_status, detail = ovh_request('GET', f'/ip/{ip}/spam/{ip}')
        out.update({'detailStatusCode': d_status, 'detail': detail})
        if isinstance(detail, dict) and detail.get('state') == 'blockedForSpam' and clean_after and not no_remediate and (policy.get('ovh') or {}).get('unblockAfterCleanRemediation', True):
            u_status, u_payload = ovh_request('POST', f'/ip/{ip}/spam/{ip}/unblock')
            out['unblock'] = {'statusCode': u_status, 'payload': u_payload}
    return out


def build_action_queue(after: list[dict[str, Any]], classes: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    actions = []
    for row in after:
        server = row.get('server') or {}
        alias = server.get('alias')
        probe = row.get('probe') or {}
        cls = classes.get(str(alias), {})
        for issue in probe.get('dockerIssues') or []:
            target = {'server': alias, 'container': issue.get('name'), 'issue': issue.get('issue')}
            actions.append({'id': stable_id({'capability': SLUG, 'target': target}), 'originAutomation': SLUG, 'owner': 'agent', 'actionType': 'investigate_and_fix_container_restart_loop_with_project_rules', 'priority': 'high', 'actionableNow': True, 'target': target, 'title': f"Corriger le conteneur {issue.get('name')} sur {alias}", 'summary': f"Le conteneur est {issue.get('status')}. Lire les règles projet locales avant toute correction applicative.", 'dedupeKey': f"{SLUG}:{alias}:{issue.get('name')}", 'mutationAllowed': True, 'externalSendAllowed': False, 'data': {'server': server, 'dockerIssue': issue, 'requiredPreflight': ['read project CLAUDE/AGENTS/RULEBOOK/BMAD', 'inspect docker labels and compose working dir', 'verify with container health and public URL if applicable'], 'blockedEffects': ['external_send', 'destructive_cleanup', 'client_server_mutation_without_approval']}})
        for err in cls.get('errors') or []:
            actions.append({'id': stable_id({'capability': SLUG, 'server': alias, 'error': err}), 'originAutomation': SLUG, 'owner': 'agent', 'actionType': 'verify_infrastructure_security_remediation', 'priority': 'critical', 'actionableNow': True, 'target': {'server': alias, 'code': err.get('code')}, 'title': f"Vérifier remédiation sécurité infrastructure sur {alias}", 'summary': f"Anomalie persistante après remédiation bornée: {err.get('code')}", 'dedupeKey': f"{SLUG}:{alias}:{err.get('code')}", 'mutationAllowed': True, 'externalSendAllowed': False, 'data': {'server': server, 'finding': err}})
    return actions


def main() -> dict[str, Any]:
    parser = argparse.ArgumentParser()
    parser.add_argument('--no-remediate', action='store_true')
    parser.add_argument('--server', action='append')
    args = parser.parse_args()
    policy = load_json(POLICY_PATH, {})
    servers = [s for s in policy.get('servers', []) if isinstance(s, dict)]
    if args.server:
        wanted = set(args.server)
        servers = [s for s in servers if s.get('alias') in wanted]
    state = load_json(STATE_PATH, {'dockerRestarts': {}})
    before, after, remediations, ovh = [], [], [], []
    before_cls, after_cls = {}, {}
    for server in servers:
        b = probe_server(server, policy); before.append(b)
        cls = classify(server, b, policy); before_cls[str(server.get('alias'))] = cls
        rem = remediate(server, b, cls, policy, state, args.no_remediate); remediations.append(rem)
        if rem.get('attempted'):
            time.sleep(8)
        a = probe_server(server, policy); after.append(a)
        a_cls = classify(server, a, policy); after_cls[str(server.get('alias'))] = a_cls
        try:
            ovh.append({'server': server.get('alias'), **ovh_check(server, not a_cls.get('errors'), policy, args.no_remediate)})
        except Exception as exc:
            ovh.append({'server': server.get('alias'), 'checked': False, 'reason': 'ovh_check_failed', 'error': repr(exc)})
    errors, warnings, infos = [], [], []
    for cls in after_cls.values():
        errors.extend(cls.get('errors') or [])
        warnings.extend(cls.get('warnings') or [])
        infos.extend(cls.get('infos') or [])
    queue = build_action_queue(after, after_cls)
    save_json(ACTION_QUEUE_PATH, {'generatedAt': now_iso(), 'schemaVersion': 'infra-exposure-autoremediation-action-queue-v1', 'items': queue})
    save_json(STATE_PATH, {**state, 'lastRunAt': now_iso(), 'lastServerAliases': [s.get('alias') for s in servers]})
    counts = {'serversTargeted': len(servers), 'sshProbeFailures': sum(1 for r in after if not (r.get('ssh') or {}).get('ok')), 'remediationsAttempted': sum(1 for r in remediations if r.get('attempted')), 'errorsAfter': len(errors), 'warningsAfter': len(warnings), 'infosAfter': len(infos), 'actionQueue': len(queue), 'ovhChecked': sum(1 for r in ovh if r.get('checked'))}
    terminal_ok = not errors and not warnings and not queue
    if errors:
        status = 'failed'
    elif queue or warnings:
        status = 'needs_agent_repair'
    elif any(r.get('attempted') for r in remediations):
        status = 'remediated_and_verified'
    else:
        status = 'passed'
    payload = {'ok': terminal_ok, 'status': status, 'generatedAt': now_iso(), 'contractVersion': 'infra-exposure-autoremediation-guard-v1', 'capabilityId': SLUG, 'summary': f"infra exposure guard: servers={counts['serversTargeted']} remediations={counts['remediationsAttempted']} errors={counts['errorsAfter']} warnings={counts['warningsAfter']} actionQueue={counts['actionQueue']}", 'policy': {'path': str(POLICY_PATH), 'schemaVersion': policy.get('schemaVersion'), 'cadence': policy.get('cadencePolicy')}, 'counts': counts, 'errors': errors, 'warnings': warnings, 'infos': infos, 'before': before, 'after': after, 'classificationsBefore': before_cls, 'classificationsAfter': after_cls, 'remediations': remediations, 'ovh': ovh, 'actionQueue': queue, 'guardrails': policy.get('guardrails'), 'systemsOfRecordValidation': {'complete': True, 'enforced': False, 'mode': 'not_required', 'reasons': [], 'systemsOfRecord': {'pendingSyncItems': []}}, 'systemsOfRecord': {'complete': True, 'enforced': False, 'mode': 'not_required', 'pendingSyncItems': []}, 'checks': {'technicalProbeExecuted': True, 'systemOfRecordNotRequired': True, 'systemOfRecordComplete': True, 'manualRemediationMode': bool(args.no_remediate), 'ovhCredentialsPresent': ovh_credentials_present(), 'terminalOkRequiresNoErrorsWarningsOrActionQueue': True}, 'blockingReasons': [e.get('code') for e in errors if isinstance(e, dict) and e.get('code')] + [a.get('dedupeKey') for a in queue if isinstance(a, dict) and a.get('dedupeKey')], 'warningReasons': [w.get('code') for w in warnings if isinstance(w, dict) and w.get('code')], 'artifacts': {'actionQueue': str(ACTION_QUEUE_PATH), 'state': str(STATE_PATH), 'historyJsonl': str(HISTORY_PATH), 'policy': str(POLICY_PATH)}, 'updatedBy': SLUG}
    art = write_report(SLUG, payload, title='Infrastructure Exposure Autoremediation Guard')
    payload['artifacts'].update(art)
    write_report(SLUG, payload, title='Infrastructure Exposure Autoremediation Guard')
    append_jsonl(HISTORY_PATH, {'generatedAt': payload['generatedAt'], 'status': payload['status'], 'ok': payload['ok'], 'counts': counts})
    print(json.dumps({'ok': payload['ok'], 'status': payload['status'], 'counts': counts, 'artifacts': payload['artifacts'], 'systemsOfRecordValidation': payload['systemsOfRecordValidation']}, ensure_ascii=False))
    return payload


if __name__ == '__main__':
    result = main()
    raise SystemExit(0 if result.get('ok') else 1)