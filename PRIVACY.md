# Privacy Policy — Robb Agents

_Last updated: 13 July 2026_

Robb Agents is a French-first, local-first desktop workspace for long-running AI agents. It is an MIT-licensed open-source distribution maintained by Robinswood.

## What Robb Agents does not operate

Robb Agents does not include a required Robinswood account, telemetry service, private updater, credential proxy, artifact bucket, or runtime endpoint. Official desktop artifacts are distributed through GitHub Releases; automatic updates are disabled.

## Local information

Depending on the features you configure, the application may store locally:

- workspace configuration, local session state, and logs;
- files you select or create in local workspaces;
- connection settings for external services; and
- credentials through the operating-system keychain or the credential flow of the provider you selected.

`CRAFT_CONFIG_DIR` can be used to isolate configuration for a separate local profile. Do not commit configuration directories, `.env` files, certificates, API keys, or tokens.

## External providers and sources

When you connect an AI provider, MCP source, browser, or other external service, data is sent only according to the connection and actions you configure. Those providers apply their own privacy terms and retention rules. Review their policies and use the routing and permission controls before granting access to sensitive sources.

Mistral Vibe subscription onboarding is handled by the official local Vibe ACP flow. Robb Agents does not read, copy, store, or automate Vibe credentials or tokens.

## Open-source development

The source repository, issues, pull requests, and GitHub Actions logs are visible according to the repository's GitHub visibility settings. Do not place personal data, credentials, customer data, signing materials, or private endpoints in public source-control content, issue reports, workflow logs, or release notes.

## Security and privacy questions

For security vulnerabilities, follow [SECURITY.md](SECURITY.md) and use GitHub private vulnerability reporting. For non-security privacy questions, open a minimal GitHub issue requesting a private contact channel; do not include personal data in the issue.

## Changes

Material changes to this policy will be made in this file and recorded through the repository's Git history.
