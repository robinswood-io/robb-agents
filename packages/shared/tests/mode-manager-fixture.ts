/**
 * Tests for mode-manager.ts shell command security
 *
 * These tests verify that dangerous shell commands are blocked in Safe (Explore) mode
 * while legitimate read-only commands are allowed.
 */
import "bun:test";
import { join } from 'path';
import "fs";
import "os";
import { setPowerShellValidatorRoot } from '../src/agent/powershell-validator.ts';
import "../src/agent/mode-manager.ts";
import "../src/agent/powershell-validator.ts";
import "../src/agent/powershell-validator.ts";
import "../src/agent/powershell-validator.ts";
import "../src/agent/mode-manager.ts";

import { type CompiledBashPattern } from '../src/agent/mode-manager.ts';

setPowerShellValidatorRoot(join(import.meta.dir, '..', 'src', 'agent'));

export const TEST_MODE_CONFIG = {
  blockedTools: new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']),
  readOnlyBashPatterns: [
    // File exploration
    { regex: /^ls\b/, source: '^ls\\b', comment: 'List directory contents' },
    { regex: /^ll\b/, source: '^ll\\b', comment: 'Long listing (ls -l alias)' },
    { regex: /^la\b/, source: '^la\\b', comment: 'List all including hidden' },
    { regex: /^tree\b/, source: '^tree\\b', comment: 'Display directory tree structure' },
    { regex: /^file\b/, source: '^file\\b', comment: 'Determine file type' },
    { regex: /^test\b/, source: '^test\\b', comment: 'Evaluate file and value conditions' },
    { regex: /^stat\b/, source: '^stat\\b', comment: 'Display file status' },
    { regex: /^du\b/, source: '^du\\b', comment: 'Estimate disk usage' },
    { regex: /^df\b/, source: '^df\\b', comment: 'Report filesystem disk space' },
    { regex: /^wc\b/, source: '^wc\\b', comment: 'Count lines, words, bytes' },
    { regex: /^nl\b/, source: '^nl\\b', comment: 'Add line numbers to text output' },
    { regex: /^head\b/, source: '^head\\b', comment: 'Output first part of files' },
    { regex: /^tail\b/, source: '^tail\\b', comment: 'Output last part of files' },
    { regex: /^cat\b/, source: '^cat\\b', comment: 'Concatenate and display files' },
    { regex: /^less\b/, source: '^less\\b', comment: 'View file contents' },
    { regex: /^more\b/, source: '^more\\b', comment: 'View file contents' },
    { regex: /^bat\b/, source: '^bat\\b', comment: 'Cat with syntax highlighting' },

    // Search
    { regex: /^find\b/, source: '^find\\b', comment: 'Search for files' },
    { regex: /^locate\b/, source: '^locate\\b', comment: 'Find files by name' },
    { regex: /^which\b/, source: '^which\\b', comment: 'Locate a command' },
    { regex: /^whereis\b/, source: '^whereis\\b', comment: 'Locate binary' },
    { regex: /^type\b/, source: '^type\\b', comment: 'Display command type' },
    { regex: /^grep\b/, source: '^grep\\b', comment: 'Search file contents' },
    { regex: /^rg\b/, source: '^rg\\b', comment: 'Ripgrep search' },
    { regex: /^ag\b/, source: '^ag\\b', comment: 'Silver Searcher' },
    { regex: /^ack\b/, source: '^ack\\b', comment: 'Ack search' },
    { regex: /^fd\b/, source: '^fd\\b', comment: 'Fast find alternative' },
    { regex: /^fzf\b/, source: '^fzf\\b', comment: 'Fuzzy finder' },

    // Git read-only (supports flags like -C before subcommand)
    { regex: /^git\s+((-[A-Za-z]|--[a-z][-a-z]*)(\s+[^\s-][^\s]*)?\s+)*(status|log|diff|show|branch|tag|remote|stash\s+list|describe|rev-parse|config\s+--get|config\s+-l|ls-files|ls-tree|shortlog|blame|annotate|reflog|cherry|whatchanged|ls-remote|history)\b/, source: '^git\\s+((-[A-Za-z]|--[a-z][-a-z]*)(\\s+[^\\s-][^\\s]*)?\\s+)*(status|log|diff|show|branch|tag|remote|stash\\s+list|describe|rev-parse|config\\s+--get|config\\s+-l|ls-files|ls-tree|shortlog|blame|annotate|reflog|cherry|whatchanged|ls-remote|history)\\b', comment: 'Git read-only operations' },

    // GitHub CLI read
    { regex: /^gh\s+(pr|issue|repo|release|run|workflow|gist|project)\s+(view|list|status|diff|checks|comments)\b/, source: '^gh\\s+(pr|issue|repo|release|run|workflow|gist|project)\\s+(view|list|status|diff|checks|comments)\\b', comment: 'GitHub CLI read operations' },
    { regex: /^gh\s+api\b.*--method\s+GET\b/, source: '^gh\\s+api\\b.*--method\\s+GET\\b', comment: 'GitHub API with GET' },
    { regex: /^gh\s+api\b(?!.*--method)/, source: '^gh\\s+api\\b(?!.*--method)', comment: 'GitHub API without method (defaults to GET)' },
    { regex: /^gh\s+auth\s+status\b/, source: '^gh\\s+auth\\s+status\\b', comment: 'Check GitHub auth status' },
    { regex: /^gh\s+config\s+(get|list)\b/, source: '^gh\\s+config\\s+(get|list)\\b', comment: 'Read GitHub CLI config' },

    // Package managers
    { regex: /^npm\s+(ls|list|view|info|show|outdated|audit|search|explain|why|config\s+get|config\s+list)\b/, source: '^npm\\s+(ls|list|view|info|show|outdated|audit|search|explain|why|config\\s+get|config\\s+list)\\b', comment: 'npm read operations' },
    { regex: /^yarn\s+(list|info|why|outdated|audit)\b/, source: '^yarn\\s+(list|info|why|outdated|audit)\\b', comment: 'Yarn read operations' },
    { regex: /^pnpm\s+(list|ls|why|outdated|audit)\b/, source: '^pnpm\\s+(list|ls|why|outdated|audit)\\b', comment: 'pnpm read operations' },
    { regex: /^bun\s+(pm\s+ls)\b/, source: '^bun\\s+(pm\\s+ls)\\b', comment: 'Bun package manager list' },
    { regex: /^pip\s+(list|show|freeze|check)\b/, source: '^pip\\s+(list|show|freeze|check)\\b', comment: 'pip read operations' },
    { regex: /^pip3\s+(list|show|freeze|check)\b/, source: '^pip3\\s+(list|show|freeze|check)\\b', comment: 'pip3 read operations' },
    { regex: /^cargo\s+(tree|metadata|pkgid|verify-project)\b/, source: '^cargo\\s+(tree|metadata|pkgid|verify-project)\\b', comment: 'Cargo read operations' },
    { regex: /^go\s+(list|mod\s+graph|mod\s+why|version)\b/, source: '^go\\s+(list|mod\\s+graph|mod\\s+why|version)\\b', comment: 'Go read operations' },
    { regex: /^composer\s+(show|info|outdated|licenses)\b/, source: '^composer\\s+(show|info|outdated|licenses)\\b', comment: 'Composer read operations' },
    { regex: /^gem\s+(list|info|dependency|environment)\b/, source: '^gem\\s+(list|info|dependency|environment)\\b', comment: 'RubyGems read operations' },
    { regex: /^bundle\s+(list|info|outdated)\b/, source: '^bundle\\s+(list|info|outdated)\\b', comment: 'Bundler read operations' },

    // System info
    { regex: /^cd\b/, source: '^cd\\b', comment: 'Change directory' },
    { regex: /^pwd\b/, source: '^pwd\\b', comment: 'Print working directory' },
    { regex: /^whoami\b/, source: '^whoami\\b', comment: 'Print current username' },
    { regex: /^id\b/, source: '^id\\b', comment: 'Print user and group IDs' },
    { regex: /^groups\b/, source: '^groups\\b', comment: 'Print group memberships' },
    { regex: /^uname\b/, source: '^uname\\b', comment: 'Print system information' },
    { regex: /^hostname\b/, source: '^hostname\\b', comment: 'Print hostname' },
    { regex: /^date\b/, source: '^date\\b', comment: 'Print date and time' },
    { regex: /^uptime\b/, source: '^uptime\\b', comment: 'Print system uptime' },
    { regex: /^env$/, source: '^env$', comment: 'Print all environment variables' },
    { regex: /^printenv\b/, source: '^printenv\\b', comment: 'Print environment variables' },
    { regex: /^echo\b/, source: '^echo\\b', comment: 'Print text to stdout' },
    { regex: /^ps\b/, source: '^ps\\b', comment: 'List running processes' },
    { regex: /^top\s+-[lb]/, source: '^top\\s+-[lb]', comment: 'Process viewer in batch mode' },
    { regex: /^htop\b/, source: '^htop\\b', comment: 'Interactive process viewer' },
    { regex: /^free\b/, source: '^free\\b', comment: 'Display memory usage' },
    { regex: /^vmstat\b/, source: '^vmstat\\b', comment: 'Virtual memory statistics' },
    { regex: /^iostat\b/, source: '^iostat\\b', comment: 'I/O statistics' },
    { regex: /^lscpu\b/, source: '^lscpu\\b', comment: 'Display CPU architecture' },

    // Docker read
    { regex: /^docker\s+(ps|images|logs|inspect|stats|top|port|diff|history|version|info|system\s+info|system\s+df|network\s+ls|network\s+inspect|volume\s+ls|volume\s+inspect|container\s+ls|image\s+ls)\b/, source: '^docker\\s+(ps|images|logs|inspect|stats|top|port|diff|history|version|info|system\\s+info|system\\s+df|network\\s+ls|network\\s+inspect|volume\\s+ls|volume\\s+inspect|container\\s+ls|image\\s+ls)\\b', comment: 'Docker read operations' },
    { regex: /^docker-compose\s+(ps|logs|config|images|top|version)\b/, source: '^docker-compose\\s+(ps|logs|config|images|top|version)\\b', comment: 'Docker Compose read operations' },
    { regex: /^docker\s+compose\s+(ps|logs|config|images|top|version)\b/, source: '^docker\\s+compose\\s+(ps|logs|config|images|top|version)\\b', comment: 'Docker Compose v2 read operations' },

    // Kubernetes read
    { regex: /^kubectl\s+(get|describe|logs|top|explain|api-resources|api-versions|cluster-info|config\s+view|config\s+get-contexts|version)\b/, source: '^kubectl\\s+(get|describe|logs|top|explain|api-resources|api-versions|cluster-info|config\\s+view|config\\s+get-contexts|version)\\b', comment: 'Kubernetes read operations' },

    // Text processing
    { regex: /^sed\s+-n\b/, source: '^sed\\s+-n\\b', comment: 'sed in print-only mode' },
    { regex: /^sort\b/, source: '^sort\\b', comment: 'Sort lines of text' },
    { regex: /^uniq\b/, source: '^uniq\\b', comment: 'Report repeated lines' },
    { regex: /^cut\b/, source: '^cut\\b', comment: 'Remove sections from lines' },
    { regex: /^tr\b/, source: '^tr\\b', comment: 'Translate characters' },
    { regex: /^column\b/, source: '^column\\b', comment: 'Columnate lists' },
    { regex: /^(?:gawk|mawk|nawk|awk)\b/, source: '^(?:gawk|mawk|nawk|awk)\\b', comment: 'Awk text processing' },
    { regex: /^jq\b/, source: '^jq\\b', comment: 'JSON processor' },
    { regex: /^yq\b/, source: '^yq\\b', comment: 'YAML processor' },
    { regex: /^xq\b/, source: '^xq\\b', comment: 'XML processor' },
    { regex: /^xmllint\b/, source: '^xmllint\\b', comment: 'XML linter' },
    { regex: /^json_pp\b/, source: '^json_pp\\b', comment: 'JSON pretty printer' },
    { regex: /^python\s+-m\s+json\.tool\b/, source: '^python\\s+-m\\s+json\\.tool\\b', comment: 'Python JSON formatter' },

    // Network diagnostics
    { regex: /^ping\b/, source: '^ping\\b', comment: 'Send ICMP echo requests' },
    { regex: /^traceroute\b/, source: '^traceroute\\b', comment: 'Trace packet route' },
    { regex: /^tracepath\b/, source: '^tracepath\\b', comment: 'Trace path to host' },
    { regex: /^mtr\b/, source: '^mtr\\b', comment: 'Network diagnostic tool' },
    { regex: /^dig\b/, source: '^dig\\b', comment: 'DNS lookup utility' },
    { regex: /^nslookup\b/, source: '^nslookup\\b', comment: 'Query DNS servers' },
    { regex: /^host\b/, source: '^host\\b', comment: 'DNS lookup utility' },
    { regex: /^netstat\b/, source: '^netstat\\b', comment: 'Network statistics' },
    { regex: /^ss\b/, source: '^ss\\b', comment: 'Socket statistics' },
    { regex: /^ip\s+(addr|link|route|neigh)\s*(show)?\b/, source: '^ip\\s+(addr|link|route|neigh)\\s*(show)?\\b', comment: 'IP address/link/route info' },
    { regex: /^ifconfig\b/, source: '^ifconfig\\b', comment: 'Network interface config' },

    // Version checks
    { regex: /^node\s+(--version|-v)\b/, source: '^node\\s+(--version|-v)\\b', comment: 'Node.js version' },
    { regex: /^npm\s+(--version|-v)\b/, source: '^npm\\s+(--version|-v)\\b', comment: 'npm version' },
    { regex: /^yarn\s+(--version|-v)\b/, source: '^yarn\\s+(--version|-v)\\b', comment: 'Yarn version' },
    { regex: /^pnpm\s+(--version|-v)\b/, source: '^pnpm\\s+(--version|-v)\\b', comment: 'pnpm version' },
    { regex: /^bun\s+(--version|-v)\b/, source: '^bun\\s+(--version|-v)\\b', comment: 'Bun version' },
    { regex: /^python\s+(--version|-V)\b/, source: '^python\\s+(--version|-V)\\b', comment: 'Python version' },
    { regex: /^python3\s+(--version|-V)\b/, source: '^python3\\s+(--version|-V)\\b', comment: 'Python 3 version' },
    { regex: /^ruby\s+(--version|-v)\b/, source: '^ruby\\s+(--version|-v)\\b', comment: 'Ruby version' },
    { regex: /^go\s+version\b/, source: '^go\\s+version\\b', comment: 'Go version' },
    { regex: /^rustc\s+(--version|-V)\b/, source: '^rustc\\s+(--version|-V)\\b', comment: 'Rust compiler version' },
    { regex: /^cargo\s+(--version|-V)\b/, source: '^cargo\\s+(--version|-V)\\b', comment: 'Cargo version' },
    { regex: /^java\s+(-version|--version)\b/, source: '^java\\s+(-version|--version)\\b', comment: 'Java version' },
    { regex: /^dotnet\s+--version\b/, source: '^dotnet\\s+--version\\b', comment: '.NET version' },
    { regex: /^php\s+(--version|-v)\b/, source: '^php\\s+(--version|-v)\\b', comment: 'PHP version' },
    { regex: /^perl\s+(--version|-v)\b/, source: '^perl\\s+(--version|-v)\\b', comment: 'Perl version' },

    // Swift/Xcode
    { regex: /^swift\s+(--version|package\s+(describe|dump-package|show-dependencies))\b/, source: '^swift\\s+(--version|package\\s+(describe|dump-package|show-dependencies))\\b', comment: 'Swift version and package info' },
    { regex: /^xcodebuild\s+(-list|-showBuildSettings)\b/, source: '^xcodebuild\\s+(-list|-showBuildSettings)\\b', comment: 'Xcode schemes and settings' },
    { regex: /^xcrun\s+(simctl\s+list|--show-sdk-path|--find)\b/, source: '^xcrun\\s+(simctl\\s+list|--show-sdk-path|--find)\\b', comment: 'Xcode toolchain info' },
    { regex: /^pod\s+(outdated|list|search)\b/, source: '^pod\\s+(outdated|list|search)\\b', comment: 'CocoaPods read operations' },

    // Terraform
    { regex: /^terraform\s+(show|plan|state\s+(list|show)|output|providers|version|validate)\b/, source: '^terraform\\s+(show|plan|state\\s+(list|show)|output|providers|version|validate)\\b', comment: 'Terraform read operations' },

    // AWS
    { regex: /^aws\s+(s3\s+ls|sts\s+get-caller-identity|ec2\s+describe|iam\s+get|configure\s+list)\b/, source: '^aws\\s+(s3\\s+ls|sts\\s+get-caller-identity|ec2\\s+describe|iam\\s+get|configure\\s+list)\\b', comment: 'AWS CLI read operations' },

    // Modern tools
    { regex: /^eza\b/, source: '^eza\\b', comment: 'Modern ls replacement' },
    { regex: /^lsd\b/, source: '^lsd\\b', comment: 'LSDeluxe - modern ls' },
    { regex: /^tokei\b/, source: '^tokei\\b', comment: 'Code statistics' },
    { regex: /^cloc\b/, source: '^cloc\\b', comment: 'Count lines of code' },
    { regex: /^scc\b/, source: '^scc\\b', comment: 'Sloc, cloc, code counter' },
    { regex: /^hyperfine\b/, source: '^hyperfine\\b', comment: 'Command benchmarking' },
    { regex: /^diff\b/, source: '^diff\\b', comment: 'Compare files' },
    { regex: /^colordiff\b/, source: '^colordiff\\b', comment: 'Colorized diff' },
    { regex: /^delta\b/, source: '^delta\\b', comment: 'Git delta viewer' },
    { regex: /^brew\s+(list|info|deps|leaves|outdated|search)\b/, source: '^brew\\s+(list|info|deps|leaves|outdated|search)\\b', comment: 'Homebrew read operations' },

    // macOS
    { regex: /^sw_vers\b/, source: '^sw_vers\\b', comment: 'macOS version' },
    { regex: /^system_profiler\b/, source: '^system_profiler\\b', comment: 'macOS system info' },
    { regex: /^defaults\s+read\b/, source: '^defaults\\s+read\\b', comment: 'Read macOS defaults' },
    { regex: /^mdfind\b/, source: '^mdfind\\b', comment: 'Spotlight search' },
    { regex: /^mdls\b/, source: '^mdls\\b', comment: 'Spotlight metadata' },

    // Help
    { regex: /^man\b/, source: '^man\\b', comment: 'Display manual pages' },
    { regex: /--help\b/, source: '--help\\b', comment: 'Display command help' },
    { regex: /-h\b$/, source: '-h\\b$', comment: 'Display command help (short)' },
  ] as CompiledBashPattern[],
  readOnlyMcpPatterns: [
    /blocks_read/, /blocks_list/, /blocks_get/,
    /document_get/, /document_list/, /spaces_list/, /folders_list/,
    /search/, /list/, /get/, /read/, /view/, /query/, /fetch/, /describe/, /info/,
  ],
  allowedApiEndpoints: [],
  allowedWritePaths: [],
  displayName: 'Test Safe Mode',
  shortcutHint: 'SHIFT+TAB',
};

export const SAFE_GIT = 'git --no-optional-locks -c core.fsmonitor=false -c core.hooksPath=/dev/null -c log.showSignature=false -c format.pretty=medium --no-pager';
