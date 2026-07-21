# Security policy

## Reporting a vulnerability

Please **do not** disclose security vulnerabilities in public issues.

Use [GitHub private vulnerability reporting](https://github.com/robinswood-io/robb-agents/security/advisories/new) for this repository. If that facility is unavailable, open a minimal public issue asking maintainers for a private reporting channel; do not include exploit details.

Include:

- a clear description and affected version/commit;
- reproduction steps or a proof of concept;
- impact and any mitigations you identified.

We aim to acknowledge reports within 7 days and will coordinate a fix and disclosure timeline with the reporter.

## Scope

This policy covers the Robb Agents desktop application, its `@craft-agent/*` packages in this repository, official GitHub Release artifacts, and the documented installer workflows.

Out of scope: third-party services/dependencies, social engineering, and attacks requiring a user to deliberately bypass platform security warnings.

## Supported versions

| Version | Supported |
| --- | --- |
| Latest release | ✅ |
| Older releases | ❌ |

## User security guidance

- Download installers only from the official GitHub Release and verify `SHA256SUMS.txt`.
- Check whether the release is explicitly marked signed/notarized; local/ad-hoc artifacts are not production installers.
- Keep credentials in provider/OS credential stores; never commit `.env`, signing certificates, API keys, or tokens.
- Review tool permissions before switching to Execute mode.

## License

Security fixes and reports are handled under the repository's [MIT License](LICENSE).
