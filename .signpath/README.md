# SignPath Foundation readiness

**Status: pending SignPath Foundation approval. Do not enable this integration until SignPath has accepted the project and supplied the organization/project/policy configuration.**

Robb Agents intends to use [SignPath Foundation](https://signpath.org/) for Windows signing of its public MIT-licensed releases. The repository must be public before SignPath can verify the open-source project and before GitHub Free can provide the intended repository protections and public provenance attestations.

## Required SignPath setup after approval

1. Install the [SignPath GitHub App](https://github.com/apps/signpath) and grant it access only to `robinswood-io/robb-agents`.
2. Add the predefined **GitHub.com** Trusted Build System to the SignPath organization and link it to the Robb Agents project.
3. Create a signing policy and artifact configuration for the Windows NSIS installer.
4. Store only `SIGNPATH_API_TOKEN` as a GitHub Actions secret in the protected `release` environment. Configure the organization ID, project slug, signing-policy slug, and artifact-configuration slug as environment variables after approval.
5. Replace the temporary PFX/Authenticode route in the release workflow with the official `signpath/github-action-submit-signing-request@v2` action. That action must sign an artifact first uploaded by the same GitHub-hosted workflow, wait for completion, and download the signed artifact before release publication.

## Required signing policy controls

The production SignPath policy should require GitHub-hosted runners and disallow workflow reruns. If GitHub branch rulesets become available, it should also require pull-request review, block force pushes, and protect the future `.signpath/policies/<project>/<policy>.yml` policy file with CODEOWNERS.

## Security boundary

Do not commit SignPath tokens, organization IDs if treated as confidential by the service, policy configuration files containing service secrets, certificates, or signed binaries. A SignPath approval or account creation alone does **not** authorize a public Robb Agents release; macOS Developer ID signing and notarization must also pass.

Official integration reference: <https://docs.signpath.io/trusted-build-systems/github>.
