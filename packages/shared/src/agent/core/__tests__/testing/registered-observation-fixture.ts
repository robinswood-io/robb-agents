



export const safeGit = 'git --no-optional-locks -c core.fsmonitor=false -c core.hooksPath=/dev/null -c log.showSignature=false -c format.pretty=medium --no-pager';

export const legacyGitWithoutSignatureGuards = 'git --no-optional-locks -c core.fsmonitor=false -c core.hooksPath=/dev/null --no-pager';
