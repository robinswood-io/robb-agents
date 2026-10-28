# Sources Configuration Guide

This guide explains how to configure sources (MCP servers, APIs, local filesystems) in Craft Agent.

> **CLI-first workflow (recommended):** Use `craft-agent source ...` commands instead of editing source config files directly.
> - `craft-agent source --help`
> - Canonical command reference: [craft-cli.md](./craft-cli.md)

## Source Setup Process

When a user wants to add a new source, follow this conversational setup process to create a tailored, well-documented integration.

### 0. Search for Specialized Source Guide (REQUIRED FIRST STEP)

**Before doing anything else**, search for a specialized guide using the craft-agents-docs MCP:

```
mcp__craft-agents-docs__SearchCraftAgents({ query: "{service} source setup" })
```

**Available guides:** GitHub, Linear, Slack, Gmail, Google Calendar, Google Drive, Google Docs, Google Sheets, Outlook, Microsoft Calendar, Teams, SharePoint, Craft, Filesystem, Brave Search, Memory

**If a guide exists for the service:**
1. **Read the guide content** carefully
2. **Pay special attention to the "Setup Hints" section** - it contains critical instructions
3. **Follow any CRITICAL/MANDATORY instructions** before proceeding (e.g., GitHub requires checking for `gh` CLI first)
4. **ALWAYS verify current API endpoints via WebSearch and/or in-app browser** - URLs and docs change frequently

**Why this matters:** Some services have important prerequisites or gotchas that MUST be checked before creating a source. Skipping this step can lead to failed setups or redundant configurations.

### 0.5. Choose Source vs Browser Path (RECOMMENDED PRE-FLIGHT)

Sources remain the default for reusable integrations. Before building a new source, ask: **Is this repeatable integration work, or a one-off/UI-driven task?**

**Prefer creating/using a source when:**
- The workflow is repeatable and likely to be reused
- Structured querying/reporting is needed
- Team consistency and automation matter
- API/MCP auth is stable enough to maintain

**Prefer in-app browser first (or as fallback) when:**
- Auth/setup is known to be brittle (common with some Gmail/Microsoft scenarios)
- The user needs a one-off task completed quickly
- The API is limited, unstable, or missing required operations
- The workflow is UI-first and not worth full integration overhead

If you choose browser-first, still offer optional source setup later when the user needs repeatability.

### 1. Understand User Intent

Before creating any configuration, ask questions to understand:
- **Primary purpose**: What do they want to accomplish with this source?
- **Scope**: Specific projects, teams, repositories, or data to focus on?
- **Common tasks**: What operations will they perform most often?
- **Access level**: Read-only exploration or full access?

Example questions:
> "I'd be happy to help set up Linear! A few questions:
> 1. What will you primarily use Linear for? (issue tracking, sprint planning, etc.)
> 2. Are there specific teams or projects you want to focus on?
> 3. Should I set it up for read-only exploration or full access?"

### 2. Research the Service

Use available tools to learn about the service:
- **WebSearch/WebFetch**: Find official documentation, API references, best practices
- **In-app browser tools**: Use when docs are dynamic, interactive, or behind login
- **Look up**: Rate limits, quotas, authentication methods
- **Identify**: Key endpoints or tools relevant to user's stated goals
- **Note**: Any limitations or gotchas to document

### Source vs Browser: Practical Examples

- **Gmail/Microsoft setup keeps failing auth:** attempt source setup, but confirm browser fallback for immediate task completion.
- **Need a one-off export from an admin UI:** use browser directly; skip full source setup unless recurring.
- **API lacks the required endpoint but UI supports it:** use browser as preferred path and document limitation.

### 3. Configure Intelligently

Based on research and user intent, create `config.json` with **ALL required fields**:

**Core fields:**
- `id` - **REQUIRED**: Unique identifier string. Format: `{slug}_{random}` (e.g., `linear_a1b2c3d4`). Generate the random part with any method (e.g., 8 hex chars).
- `name`, `slug`, `provider`, `type` - Basic identification
- `icon` - **RECOMMENDED**: URL to the service's favicon, logo, or app icon. The icon is auto-downloaded and cached locally. Use an emoji as fallback.
- `tagline` - **RECOMMENDED**: Short description for agent context (e.g., "Issue tracking, sprint planning, and project management")
- Type-specific config (`mcp`, `api`, or `local`)
- Authentication method appropriate for the service

### 4. Configure Explore Mode Permissions (REQUIRED)

Sources should work in Explore mode by default. Create `permissions.json` to allow read-only operations.

**How it works:** Patterns in a source's `permissions.json` are automatically scoped to that source. Write simple patterns like `list` - the system converts them to `mcp__<sourceSlug>__.*list` internally. This prevents cross-source leakage.

**For MCP sources:**
1. After connecting, list the server's available tools
2. Identify read-only tools (list, get, search, find, query operations)
3. Create simple patterns for those operations

```json
{
  "allowedMcpPatterns": [
    { "pattern": "list", "comment": "All list operations" },
    { "pattern": "get", "comment": "All get/read operations" },
    { "pattern": "search", "comment": "All search operations" },
    { "pattern": "find", "comment": "All find operations" }
  ]
}
```

**For API sources:**
```json
{
  "allowedApiEndpoints": [
    { "method": "GET", "path": ".*", "comment": "All GET requests are read-only" },
    { "method": "POST", "path": "^/search", "comment": "Search endpoint (read-only despite POST)" }
  ]
}
```

**For local sources:**
```json
{
  "allowedBashPatterns": [
    { "pattern": "^(ls|cat|head|tail|grep|find|tree)\\s", "comment": "Read-only commands" }
  ]
}
```

> **Goal:** Sources should be fully functional in Explore mode. Allow all read operations by default. Only block actual mutations (create, update, delete).

### 5. Write Comprehensive guide.md

Create a guide.md tailored to the user's context:
- Summarize the source's purpose in their specific use case
- Document capabilities relevant to their workflow
- Include specific project/team/scope references they mentioned
- Add usage examples tailored to their tasks
- Note rate limits, quotas, or limitations

### 6. Test and Validate (MANDATORY)

**You MUST use the `source_test` tool after creating any source.** This applies to ALL source types - MCP, API, and local filesystem sources. This is not optional.

```
mcp__session__source_test({ sourceSlug: "{slug}" })
```

The `source_test` tool:
1. **Validates config.json** against the schema
2. **Downloads and caches the icon** if a URL was provided
3. **Tests the connection** to verify the source is reachable
4. **Reports missing fields** (icon, tagline) that should be added
5. **Auto-enables the source** (default): on a clean run it flips `enabled: true` in config if needed and activates the source in the current session so its tools become available without a restart. Pass `autoEnable: false` to keep pure validation behavior.

After validation passes, trigger the appropriate auth flow:
- OAuth sources: `source_oauth_trigger({ sourceSlug: "{slug}" })`
- Bearer/API key: `source_credential_prompt({ sourceSlug: "{slug}", mode: "bearer" })`
- Google services: `source_google_oauth_trigger({ sourceSlug: "{slug}" })`
- Microsoft services: `source_microsoft_oauth_trigger({ sourceSlug: "{slug}" })`
- Slack: `source_slack_oauth_trigger({ sourceSlug: "{slug}" })`

**Do NOT skip validation** - it catches config errors before they cause runtime failures.

## guide.md Best Practices

The guide.md file is critical—it helps Claude understand how to use the source effectively in future sessions.

### Structure

```markdown
# Source Name

Brief description of what this source provides and the user's specific use case.

## Scope

What data/functionality this provides. Include:
- Specific projects, teams, or repos the user mentioned
- Relevant filters or defaults
- Any limitations on access

## Guidelines

- Best practices for using this source
- Rate limits or quotas to be aware of
- Common patterns the user will need
- Things to avoid or be careful about

## Examples

Concrete examples tailored to the user's workflow:
- "To find issues in the Craft iOS project: ..."
- "To search for recent commits by the mobile team: ..."
```

### Key Principles

1. **Be specific to user context**: Reference the projects, teams, and tasks they mentioned
2. **Include concrete examples**: Use their actual project names and workflows
3. **Document user preferences**: Any preferences they shared for future sessions
4. **Note scope boundaries**: What the source can and cannot do
5. **Keep it actionable**: Focus on what Claude needs to know to help effectively

## Example Conversational Flow

```
User: I want to add Linear

Agent: [FIRST: Searches for Linear guide]
       mcp__craft-agents-docs__SearchCraftAgents({ query: "linear source setup" })

Agent: I found the Linear setup guide! A few questions:
1. What will you primarily use Linear for? (issue tracking, sprint planning, reporting?)
2. Are there specific teams or projects you want to focus on?
3. Should I set it up for read-only exploration or full access?

User: Issue tracking for my iOS team, project called "Craft iOS"

Agent: [Uses WebSearch to verify current Linear MCP URL]
Agent: [Creates config.json with:
        - icon: (searches web for app icon or uses favicon)
        - tagline: "Issue tracking for the Craft iOS team"
        - OAuth authentication]
Agent: [Writes guide.md mentioning "Craft iOS" project and iOS team context]
Agent: [Sets up permissions.json for read-only listing in Explore mode]
Agent: [MANDATORY: Runs source_test to validate]
       mcp__session__source_test({ sourceSlug: "linear" })
Agent: [Triggers source_oauth_trigger for authentication]
       mcp__session__source_oauth_trigger({ sourceSlug: "linear" })

Agent: Linear is now set up! I've configured it to focus on the "Craft iOS" project.
You can use it to:
- Search and view issues in Craft iOS
- Track sprint progress for the iOS team
- Create and update issues

Would you like me to show you what issues are currently open?
```

## Overview

Sources are stored as folders under:
- `~/.craft-agent/workspaces/{workspaceId}/sources/{sourceSlug}/`

Each source folder contains:
- `config.json` - Source configuration (required)
- `guide.md` - Usage documentation for Claude (optional)
- `permissions.json` - Custom permission rules for Explore mode (optional)
- `icon.svg`, `icon.png`, `icon.jpg`, or `icon.jpeg` - Source icon (optional)

## config.json Schema

```json
{
  "id": "linear_a1b2c3d4",        // Unique identifier: {slug}_{random}
  "name": "Human-readable name",
  "slug": "url-safe-identifier",
  "enabled": true,
  "provider": "provider-name",
  "type": "mcp" | "api" | "local",

  // RECOMMENDED: Icon and tagline for better UI and agent context
  "icon": "https://example.com/favicon.ico",  // URL (auto-downloaded) or emoji
  "tagline": "Brief description for agent context",

  // For MCP sources:
  // Path fields (command, args, env values) support variables:
  // ~, ${HOME}, ${CRAFT_CONFIG_DIR}, ${WORKSPACE}, ${SOURCE_DIR}
  "mcp": {
    "url": "https://mcp.example.com",
    "authType": "oauth" | "bearer" | "none"
  },

  // For API sources:
  "api": {
    "baseUrl": "https://api.example.com/",  // MUST have trailing slash
    "authType": "bearer" | "header" | "query" | "basic" | "oauth" | "none",
    "headerName": "X-API-Key",      // For single header auth
    "headerNames": ["X-API-KEY", "X-APP-KEY"],  // For multi-header auth (2+ headers)
    "queryParam": "api_key",         // For query auth
    "authScheme": "Bearer"           // For bearer auth (default: "Bearer")
  },

  // For local sources:
  "local": {
    "path": "/path/to/folder"
  },

  // Status (updated by source_test):
  "isAuthenticated": true,
  "connectionStatus": "connected" | "needs_auth" | "failed" | "untested",
  "lastTestedAt": 1704067200000,

  // Icon: emoji or URL (auto-downloaded to local icon.* file)
  // Local icon files are auto-discovered, no config needed
  "icon": "🔧",                      // Emoji icon (optional)

  // Timestamps:
  "createdAt": 1704067200000,
  "updatedAt": 1704067200000
}
```

## Path Variables (Cross-Machine Portability)

Source configs often contain absolute paths (e.g., to MCP server binaries,
project directories, or virtual environments). These paths differ between
machines, making configs hard to share across a team.

**Path variables** are expanded automatically when a source is loaded.
They make configs portable without changing existing behavior.

### Supported Variables

| Variable | Resolves To | Example |
|----------|-------------|--------|
| `~` / `~/` | Home directory | `~/Development/my-mcp` |
| `${HOME}` | Home directory | `${HOME}/.crawl4ai/venv/bin/python` |
| `${CRAFT_CONFIG_DIR}` | Craft Agent config directory (default: `~/.craft-agent`) | `${CRAFT_CONFIG_DIR}/sources/my-mcp` |
| `${WORKSPACE}` | Current workspace root | `${WORKSPACE}/mcp-servers/my-server` |
| `${SOURCE_DIR}` | This source's own folder | `${SOURCE_DIR}/server/index.js` |

### Where Variables Are Expanded

For **MCP sources** (stdio transport):
- `command` — the executable path
- `args` — each argument string
- `env` — each environment variable value

For **local sources**:
- `path` — the folder path

### Examples

**Portable local MCP with home-relative paths:**
```json
{
  "type": "mcp",
  "mcp": {
    "transport": "stdio",
    "command": "${HOME}/.crawl4ai/venv/bin/python",
    "args": ["-m", "crawler_agent.mcp_server"],
    "env": {
      "PYTHONPATH": "${HOME}/.crawl4ai/crawl4ai-mcp-server"
    },
    "authType": "none"
  }
}
```

**MCP stored inside a source folder:**
```json
{
  "type": "mcp",
  "mcp": {
    "transport": "stdio",
    "command": "node",
    "args": ["${SOURCE_DIR}/server/index.js"],
    "authType": "none"
  }
}
```

**Portable local source:**
```json
{
  "type": "local",
  "local": {
    "path": "~/Documents/MyProject"
  }
}
```

### Platform Overrides (Cross-OS Configs)

For MCP stdio sources, you can override `command`, `args`, and `env` per
platform. Keys match Node.js `process.platform` values: `win32`, `darwin`, `linux`.

**Override rules:**
- `command` — **replaces** the default command
- `args` — **replaces** the default args entirely
- `env` — **merges** on top of the default env (not replaced)

**Example — different command on Windows:**
```json
{
  "type": "mcp",
  "mcp": {
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem"],
    "platform": {
      "win32": {
        "command": "npx.cmd"
      }
    }
  }
}
```

**Example — platform-specific paths with variables:**
```json
{
  "type": "mcp",
  "mcp": {
    "transport": "stdio",
    "command": "dart",
    "args": ["${SOURCE_DIR}/server/main.dart"],
    "env": {
      "DART_SDK": "${HOME}/.dart-sdk"
    },
    "platform": {
      "win32": {
        "command": "dart.exe",
        "env": {
          "DART_SDK": "C:\\tools\\dart-sdk"
        }
      },
      "darwin": {
        "env": {
          "DART_SDK": "/opt/homebrew/opt/dart"
        }
      }
    }
  }
}
```

Path variables (`${HOME}`, `${SOURCE_DIR}`, etc.) are expanded inside platform
overrides exactly the same as in default fields.

### Backward Compatibility

Existing configs with absolute paths (no variables) continue to work
exactly as before. Variables are purely opt-in — a path without `${...}`
or `~` passes through unchanged.

---

