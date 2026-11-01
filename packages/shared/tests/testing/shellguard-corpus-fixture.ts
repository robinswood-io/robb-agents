import type { ModeConfig } from '../../src/agent/mode-types.ts';

export const TEST_MODE_CONFIG: ModeConfig = {
  readOnlyMcpPatterns: [],
  allowedApiEndpoints: [],
  displayName: 'Explore',
  shortcutHint: 'QA',
  blockedTools: new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']),
  readOnlyBashPatterns: [
    // File exploration
    { regex: /^ls\b/, source: '^ls\\b', comment: 'List directory contents' },
    { regex: /^tree\b/, source: '^tree\\b', comment: 'Display directory tree' },
    { regex: /^file\b/, source: '^file\\b', comment: 'Determine file type' },
    { regex: /^stat\b/, source: '^stat\\b', comment: 'Display file status' },
    { regex: /^du\b/, source: '^du\\b', comment: 'Estimate disk usage' },
    { regex: /^df\b/, source: '^df\\b', comment: 'Report filesystem disk space' },
    { regex: /^wc\b/, source: '^wc\\b', comment: 'Count lines, words, bytes' },
    { regex: /^head\b/, source: '^head\\b', comment: 'Output first part of files' },
    { regex: /^tail\b/, source: '^tail\\b', comment: 'Output last part of files' },
    { regex: /^cat\b/, source: '^cat\\b', comment: 'Concatenate and display files' },
    { regex: /^less\b/, source: '^less\\b', comment: 'View file contents' },
    { regex: /^more\b/, source: '^more\\b', comment: 'View file contents' },

    // Search
    { regex: /^find\b/, source: '^find\\b', comment: 'Search for files' },
    { regex: /^grep\b/, source: '^grep\\b', comment: 'Search file contents' },
    { regex: /^rg\b/, source: '^rg\\b', comment: 'Ripgrep search' },
    { regex: /^which\b/, source: '^which\\b', comment: 'Locate a command' },

    // Git read-only
    {
      regex:
        /^git\s+((-[A-Za-z]|--[a-z][-a-z]*)(\s+[^\s-][^\s]*)?\s+)*(status|log|diff|show|branch|tag|remote|stash\s+list|describe|rev-parse|config\s+--get|config\s+-l|ls-files|ls-tree|shortlog|blame|annotate|reflog|cherry|whatchanged|ls-remote|history)\b/,
      source: 'git read-only',
      comment: 'Git read-only operations',
    },

    // System info
    { regex: /^pwd\b/, source: '^pwd\\b', comment: 'Print working directory' },
    { regex: /^whoami\b/, source: '^whoami\\b', comment: 'Print current username' },
    { regex: /^id\b/, source: '^id\\b', comment: 'Print user and group IDs' },
    { regex: /^uname\b/, source: '^uname\\b', comment: 'Print system information' },
    { regex: /^hostname\b/, source: '^hostname\\b', comment: 'Print hostname' },
    { regex: /^date\b/, source: '^date\\b', comment: 'Print date and time' },
    { regex: /^uptime\b/, source: '^uptime\\b', comment: 'Print system uptime' },
    { regex: /^env$/, source: '^env$', comment: 'Print all environment variables' },
    { regex: /^printenv\b/, source: '^printenv\\b', comment: 'Print environment variables' },
    { regex: /^echo\b/, source: '^echo\\b', comment: 'Print text to stdout' },
    { regex: /^ps\b/, source: '^ps\\b', comment: 'List running processes' },

    // Docker read
    {
      regex:
        /^docker\s+(ps|images|logs|inspect|stats|top|port|diff|history|version|info|system\s+info|system\s+df|network\s+ls|network\s+inspect|volume\s+ls|volume\s+inspect|container\s+ls|image\s+ls)\b/,
      source: 'docker read',
      comment: 'Docker read operations',
    },

    // Kubernetes read
    {
      regex:
        /^kubectl\s+(get|describe|logs|top|explain|api-resources|api-versions|cluster-info|config\s+view|config\s+get-contexts|version)\b/,
      source: 'kubectl read',
      comment: 'Kubernetes read operations',
    },

    // Text processing
    { regex: /^sort\b/, source: '^sort\\b', comment: 'Sort lines of text' },
    { regex: /^uniq\b/, source: '^uniq\\b', comment: 'Report repeated lines' },
    { regex: /^cut\b/, source: '^cut\\b', comment: 'Remove sections from lines' },
    { regex: /^(?:gawk|mawk|nawk|awk)\b/, source: '^awk\\b', comment: 'Awk text processing' },
    { regex: /^jq\b/, source: '^jq\\b', comment: 'JSON processor' },
    { regex: /^diff\b/, source: '^diff\\b', comment: 'Compare files' },

    // Network diagnostics
    { regex: /^ping\b/, source: '^ping\\b', comment: 'Send ICMP echo requests' },
    { regex: /^dig\b/, source: '^dig\\b', comment: 'DNS lookup' },
    { regex: /^nslookup\b/, source: '^nslookup\\b', comment: 'Query DNS' },

    // Package managers
    {
      regex: /^npm\s+(ls|list|view|info|show|outdated|audit|search|explain|why)\b/,
      source: 'npm read',
      comment: 'npm read operations',
    },

    // craft-agent CLI read-only
    { regex: /^craft-agent\s+label\s+(list|get)\b/, source: '^craft-agent\\s+label\\s+(list|get)\\b', comment: 'craft-agent label read-only operations' },
    { regex: /^craft-agent\s+source\s+(list|get|validate|test)\b/, source: '^craft-agent\\s+source\\s+(list|get|validate|test)\\b', comment: 'craft-agent source read-only operations' },
    { regex: /^craft-agent\s+skill\s+(list|get|validate|where)\b/, source: '^craft-agent\\s+skill\\s+(list|get|validate|where)\\b', comment: 'craft-agent skill read-only operations' },
    { regex: /^craft-agent\s+automation\s+(list|get|validate|history|last-executed|test|lint)\b/, source: '^craft-agent\\s+automation\\s+(list|get|validate|history|last-executed|test|lint)\\b', comment: 'craft-agent automation read-only operations' },
    { regex: /^craft-agent\s*$/, source: '^craft-agent\\s*$', comment: 'craft-agent bare invocation' },
    { regex: /^craft-agent\s+(label|source|skill|automation)\s+--help\b/, source: '^craft-agent\\s+(label|source|skill|automation)\\s+--help\\b', comment: 'craft-agent entity help flags' },
    { regex: /^craft-agent\s+--(help|version|discover)\b/, source: '^craft-agent\\s+--(help|version|discover)\\b', comment: 'craft-agent global flags' },

    // Version checks
    { regex: /^node\s+(--version|-v)\b/, source: 'node version', comment: 'Node.js version' },
    { regex: /^python3?\s+(--version|-V)\b/, source: 'python version', comment: 'Python version' },

    // Modern tools
    { regex: /^pgrep\b/, source: '^pgrep\\b', comment: 'Search running processes' },
  ],
};

export const SAFE_GIT = 'git --no-optional-locks -c core.fsmonitor=false -c core.hooksPath=/dev/null -c log.showSignature=false -c format.pretty=medium --no-pager';
