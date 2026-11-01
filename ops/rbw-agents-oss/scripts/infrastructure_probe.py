"""Read-only remote probe. Standard library only, so remote hosts need no installation."""
from __future__ import annotations

import json
import os
import re
import subprocess
from typing import TypedDict

type JsonValue = str | int | float | bool | None | list[JsonValue] | dict[str, JsonValue]

class CommandResult(TypedDict):
    ok: bool
    exitCode: int | None
    stdout: str
    stderr: str


def run(command: str, timeout: int = 10) -> CommandResult:
    try:
        result = subprocess.run(command, shell=True, text=True, capture_output=True, timeout=timeout, check=False)
        return {'ok': result.returncode == 0, 'exitCode': result.returncode, 'stdout': result.stdout, 'stderr': result.stderr}
    except (OSError, subprocess.SubprocessError) as error:
        return {'ok': False, 'exitCode': None, 'stdout': '', 'stderr': repr(error)}


def active(service: str) -> bool:
    result = run('systemctl is-active ' + service, timeout=5)
    return result['ok'] and result['stdout'].strip() == 'active'


def parse_listeners(output: str, unsafe_ports: list[int]) -> list[dict[str, JsonValue]]:
    rows: list[dict[str, JsonValue]] = []
    for line in output.splitlines():
        parts = line.split()
        if len(parts) < 5:
            continue
        local = parts[4]
        match = re.search(r':(\d+)$', local.replace(']', ''))
        if not match or int(match.group(1)) not in unsafe_ports:
            continue
        host = local.rsplit(':', 1)[0].strip('[]')
        public = host in ('0.0.0.0', '::', '*') or bool(host and not host.startswith('127.') and host != '::1')
        rows.append({'proto': parts[0], 'state': parts[1], 'local': local, 'port': int(match.group(1)), 'public': public, 'line': line[:500]})
    return rows


def parse_smtp(output: str) -> list[dict[str, JsonValue]]:
    rows: list[dict[str, JsonValue]] = []
    for line in output.splitlines():
        parts = line.split()
        if len(parts) >= 5 and re.search(r':25$', parts[4].replace(']', '')):
            rows.append({'peer': parts[4], 'line': line[:500]})
    return rows


def docker_rows() -> tuple[list[dict[str, JsonValue]], list[dict[str, JsonValue]]]:
    command = ("/opt/ia-webdev/bin/rbw-docker-guard docker -- ps -a --format '{{.Names}}\t{{.Image}}\t{{.Status}}'"
               if os.environ.get('RBW_DEV_DIAGNOSTICS') == '1'
               else "docker ps -a --format '{{.Names}}\t{{.Image}}\t{{.Status}}' 2>/dev/null")
    result = run(command, timeout=15)
    rows: list[dict[str, JsonValue]] = []
    issues: list[dict[str, JsonValue]] = []
    if not result['ok']:
        issues.append({'issue': 'docker_probe_failed', 'status': 'diagnostic_unavailable'})
    for line in result['stdout'].splitlines():
        columns = line.split('\t', 2)
        if len(columns) != 3:
            issues.append({'issue': 'docker_probe_invalid', 'status': 'diagnostic_unavailable'})
            continue
        name, image, status = columns
        rows.append({'Names': name, 'Image': image, 'Status': status})
        issue = 'restarting' if 'Restarting' in status else 'unhealthy' if 'unhealthy' in status.lower() else None
        if issue:
            issues.append({'name': name, 'image': image, 'status': status, 'issue': issue})
    return rows, issues


def has_block(text: str, port: int) -> bool:
    return any(re.search(r'--dport ' + str(port) + r'(?: |$)', line) and
               any(target in line for target in (' -j REJECT', ' -j DROP')) for line in text.splitlines())


def collect_probe() -> dict[str, JsonValue]:
    unsafe_ports = [int(value) for value in os.environ.get('UNSAFE_PROXY_PORTS', '1080 1081 1088 9050 3128 8118').split()]
    services = os.environ.get('MAIL_SERVICES', 'postfix exim4 sendmail opensmtpd').split()
    errors: list[JsonValue] = []

    def checked(command: str, label: str) -> str:
        result = run(command, timeout=8)
        if not result['ok']:
            errors.append({'code': label, 'exitCode': result['exitCode'], 'stderr': result['stderr'][-1000:]})
        return result['stdout']

    listeners = parse_listeners(checked('ss -H -lntup 2>/dev/null', 'listeners_probe_failed'), unsafe_ports)
    smtp = parse_smtp(checked('ss -H -ntp 2>/dev/null', 'smtp_probe_failed'))
    firewall: dict[str, str] = {}
    for chain in ('OUTPUT', 'DOCKER-USER', 'INPUT'):
        firewall[chain] = checked(f'sudo -n iptables -S {chain} 2>/dev/null || iptables -S {chain} 2>/dev/null', 'iptables_' + chain + '_probe_failed')
    containers, issues = docker_rows()
    return {
        'hostname': run('hostname', timeout=5)['stdout'].strip(),
        'generatedAtRemote': run('date -Is', timeout=5)['stdout'].strip(),
        'uptime': run('uptime -p', timeout=5)['stdout'].strip(),
        'publicProxyListeners': [row for row in listeners if row['public']],
        'allUnsafeProxyListeners': list(listeners), 'smtpSockets': list(smtp),
        'mailServices': {service: active(service) for service in services},
        'dockerIssues': list(issues), 'dockerContainersSample': list(containers[:80]),
        'iptables': {
            'outputSmtpBlocked': has_block(firewall['OUTPUT'], 25),
            'dockerSmtpBlocked': has_block(firewall['DOCKER-USER'], 25),
            'unsafeInputBlockedPorts': [port for port in unsafe_ports if has_block(firewall['INPUT'], port)],
            'inputRulesRbw': [line for line in firewall['INPUT'].splitlines() if 'rbw-' in line],
            'outputRulesRbw': [line for line in firewall['OUTPUT'].splitlines() if 'rbw-' in line],
            'dockerUserRulesRbw': [line for line in firewall['DOCKER-USER'].splitlines() if 'rbw-' in line],
        },
        'antiSpamGuardActive': active('rbw-anti-spam-guard.service'),
        'microsocks': {
            'active': active('microsocks.service'),
            'unit': run('systemctl cat microsocks 2>/dev/null', timeout=8)['stdout'],
            'processes': [line for line in run('pgrep -a microsocks 2>/dev/null || true', timeout=5)['stdout'].splitlines()],
        },
        'probeErrors': errors,
    }


if __name__ == '__main__':
    print(json.dumps(collect_probe(), ensure_ascii=False))
