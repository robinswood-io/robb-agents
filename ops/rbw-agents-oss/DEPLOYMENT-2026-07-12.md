# RBW Agents OSS — Architecture v2 debt-zero release

## Scope

Verified source snapshot for the live `/srv/rbw-agents-oss` cutover completed on 2026-07-12.
This subtree is operational code/configuration and is intentionally isolated from the Robb Agents desktop application.

## Invariants

- 193 manifest agents, 193 Agent Cards, 193 `argv` execution specs.
- 0 `legacy_shell` adapters and no runtime shell fallback.
- Executables are absolute and runtime subprocess execution uses `shell=False`.
- 139 configured schedules with semantic fingerprint `af4879a4875146eb675686ec96a401be6f21ae7a0f2329afcfc22b36335bf647`.
- 139/139 live Temporal schedule parity after archived orphan reconciliation.
- 0 scheduled report-contract debt; runtime execution and business reports are separate.
- Two Sellsy apply sentinels are typed in `execution.env`; no Sellsy workflow was executed during migration.
- Five Temporal queue canaries passed: `default`, `watchdog`, `campaigns`, `sync`, `ao`.
- Five workers active; 0 failed systemd units.
- Four obsolete Certbot renewals and obsolete Nightly Agents units were archived before withdrawal.

## Verification

- Runtime tests: 10/10.
- Architecture v2 guard: passed, 0 warnings/errors.
- Debt-zero guard including systemd: passed.
- Report-contract coverage: 0 missing/accepted/stale entries.
- Release gate: 27/27.
- Security: 0 active sensitive backups, permission issues, secret candidates, or unprotected unsafe listeners.
- Bundle contains 250 files and no `.env`, certificate, secret path, backup, or bytecode.

Deterministic release bundle SHA-256:

```text
fe306127784861a03d396d808973b9ab41f4abc7aa308ed1ddc87381a66d3717
```

## Rollback evidence

Primary pre-cutover snapshot:

```text
/srv/rbw-agents-oss/archive/2026-07/architecture-v2-debt-zero/20260712T202515Z
```

Temporal orphan definitions and every modified live artifact were archived under the July 2026 architecture-v2 archive tree before mutation.
