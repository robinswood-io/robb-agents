## Icon Handling

The `config.icon` field controls the source icon. Resolution follows this priority:

| `config.icon` value | Behavior |
|---------------------|----------|
| Emoji (e.g., `"🔧"`) | Rendered as emoji text |
| Local path `"./icon.svg"` | Loads from `sources/{slug}/icon.svg` |
| URL `"https://..."` | Auto-downloaded to local `icon.*` file by `source_test` |
| Undefined/null | Auto-discovers `sources/{slug}/icon.{svg,png}`, falls back to favicon |

**Examples:**

```json
// Emoji icon
{ "icon": "📝" }

// Explicit local path (rarely needed - auto-discovery handles this)
{ "icon": "./icon.svg" }

// URL (downloaded automatically by source_test)
{ "icon": "https://linear.app/static/favicon.svg" }

// No icon field - auto-discovers icon.svg/icon.png or resolves favicon
{}
```

**Best practice:** Set `icon` to a URL when creating a source. Run `source_test` to download and cache it locally. The app then uses the local file for fast, offline-capable display.

## Provider Domain Cache

For favicon resolution, a cache maps provider names to their canonical domains at:
`~/.craft-agent/provider-domains.json`

**Format:**
```json
{
  "version": 1,
  "domains": {
    "linear": "linear.app",
    "notion": "notion.so",
    "brave": "brave.com"
  },
  "updatedAt": 1704067200000
}
```

**When to update:** If a source's favicon appears incorrect (generic globe, wrong icon), add the provider→domain mapping to this file. The app loads this cache on startup.

**Example:** If "acme-mcp" source shows wrong icon, add:
```json
"acme": "acme.com"
```

## Common Providers

### Gmail (and other Google services)
Provider: `google`, Type: `api`
Requires user-provided OAuth credentials in the source config:
- `googleOAuthClientId`: Your Google OAuth Client ID
- `googleOAuthClientSecret`: Your Google OAuth Client Secret

Create credentials at [Google Cloud Console](https://console.cloud.google.com/apis/credentials) (Desktop app type).
Uses OAuth via `source_google_oauth_trigger`.

### Linear
Provider: `linear`, Type: `mcp`
URL: `https://mcp.linear.app`, OAuth auth.

### GitHub
Provider: `github`, Type: `mcp`
URL: `https://api.githubcopilot.com/mcp/`, **bearer auth** (PAT required - OAuth will fail).

### Exa (Search)
Provider: `exa`, Type: `api`
Base URL: `https://api.exa.ai`, header auth with `x-api-key`.

### Brave Search
Provider: `brave`, Type: `mcp`
Transport: `stdio`, Command: `npx -y @modelcontextprotocol/server-brave-search`, requires `BRAVE_API_KEY` env.

### Memory
Provider: `memory`, Type: `mcp`
Transport: `stdio`, Command: `npx -y @modelcontextprotocol/server-memory`, no auth.

## Workflow

### Creating a Source

**Always follow the conversational setup process** (see above). The key steps:

1. **Ask before creating**: Understand user intent, scope, and common tasks
2. **Choose the right path**: Confirm if this should be a source or a browser-first one-off workflow
3. **Research before configuring**: Use WebSearch/WebFetch and browser tools as needed
4. **Tailor guide.md to context**: Include specific projects/teams the user mentioned
5. **Test before declaring done**: Validate config, trigger auth, verify connection

Technical steps:

1. Create the source folder:
   ```bash
   mkdir -p ~/.craft-agent/workspaces/{ws}/sources/my-source
   ```

2. Write `config.json` with appropriate settings (see schemas above)

3. Write `guide.md` tailored to user's context and use case

4. **Create `permissions.json` for Explore mode** - List the source's tools, identify read-only operations (list, get, search), and add simple patterns. Patterns are auto-scoped to this source.

5. Run `source_test` to validate configuration and test connection

6. If auth is required, trigger the appropriate flow:
   - `source_oauth_trigger` for MCP OAuth
   - `source_google_oauth_trigger` for Google services (Gmail, Calendar, Drive, Docs, Sheets, YouTube, Search Console)
   - `source_microsoft_oauth_trigger` for Microsoft services
   - `source_slack_oauth_trigger` for Slack
   - `source_credential_prompt` for API keys/tokens
   - For basic auth with optional password: `source_credential_prompt({ mode: "basic", passwordRequired: false })`

7. Confirm with user that the source is working as expected

### Testing a Source

Use `source_test` with the source slug:
- Validates config.json schema
- Tests connectivity
- Downloads icon if needed
- Updates connectionStatus

### Troubleshooting

**"needs_auth" status:**
- Source requires authentication
- Use appropriate auth trigger tool

**"failed" status:**
- Check `connectionError` in config.json
- Verify URL is correct
- Check network connectivity

**Icon not showing:**
- Ensure iconUrl is valid
- Run `source_test` to re-download
- Check file exists in source folder
