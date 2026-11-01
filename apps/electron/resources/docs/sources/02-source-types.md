## Source Types

### MCP Sources

Model Context Protocol servers provide tools via HTTP/SSE.

**OAuth authentication (recommended):**
```json
{
  "id": "linear_a1b2c3d4",
  "type": "mcp",
  "provider": "linear",
  "mcp": {
    "url": "https://mcp.linear.app",
    "authType": "oauth"
  }
}
```

After creating, use `source_oauth_trigger` to authenticate.

**Bearer token authentication:**
```json
{
  "type": "mcp",
  "provider": "custom-mcp",
  "mcp": {
    "url": "https://my-mcp-server.com",
    "authType": "bearer"
  }
}
```

After creating, use `source_credential_prompt` with mode "bearer".

**Public (no auth):**
```json
{
  "type": "mcp",
  "provider": "public-mcp",
  "mcp": {
    "url": "https://public-mcp.example.com",
    "authType": "none"
  }
}
```

**Stdio transport (local command):**

For MCP servers that run locally via command line (npx, node, python), use the stdio transport.

> **Cross-machine tip:** Use path variables (`${HOME}`, `${SOURCE_DIR}`)
> instead of absolute paths to make configs portable across machines.
> See [Path Variables](#path-variables-cross-machine-portability) above.

Users often provide configs in Claude Desktop / Claude Code format:
```json
{
  "mcpServers": {
    "airbnb": {
      "command": "npx",
      "args": ["-y", "@openbnb/mcp-server-airbnb"]
    }
  }
}
```

Convert to native format:
```json
{
  "type": "mcp",
  "name": "Airbnb",
  "provider": "airbnb",
  "mcp": {
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "@openbnb/mcp-server-airbnb"],
    "authType": "none"
  }
}
```

With environment variables:
```json
{
  "type": "mcp",
  "name": "Brave Search",
  "provider": "brave",
  "mcp": {
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-brave-search"],
    "env": {
      "BRAVE_API_KEY": "your-api-key"
    },
    "authType": "none"
  }
}
```

### API Sources

REST APIs become flexible tools that Claude can call.

**Request bodies:** By default, `params` is JSON-serialized for POST/PUT/PATCH requests. For endpoints that expect non-JSON bodies (plain text, XML, form data, etc.), use the special `_rawBody` and `_contentType` params:

```json
{
  "params": {
    "_rawBody": "raw string content to send as-is",
    "_contentType": "text/plain"
  }
}
```

- `_rawBody` (string) — sent as the request body without JSON encoding
- `_contentType` (string, optional) — sets the Content-Type header (defaults to `text/plain`)

**IMPORTANT:** Authenticated API sources require a `testEndpoint` to validate credentials during `source_test`. Without it, we cannot verify your credentials work.

**Header authentication (X-API-Key style):**
```json
{
  "type": "api",
  "provider": "exa",
  "api": {
    "baseUrl": "https://api.exa.ai/",
    "authType": "header",
    "headerName": "x-api-key",
    "testEndpoint": {
      "method": "POST",
      "path": "search",
      "body": { "query": "test", "numResults": 1 }
    }
  }
}
```

**Bearer token (Authorization header):**
```json
{
  "type": "api",
  "provider": "openai",
  "api": {
    "baseUrl": "https://api.openai.com/v1/",
    "authType": "bearer",
    "testEndpoint": {
      "method": "GET",
      "path": "models"
    }
  }
}
```

**Query parameter:**
```json
{
  "type": "api",
  "provider": "weather",
  "api": {
    "baseUrl": "https://api.weather.com/",
    "authType": "query",
    "queryParam": "apikey",
    "testEndpoint": {
      "method": "GET",
      "path": "v1/current"
    }
  }
}
```

**Basic authentication:**
```json
{
  "type": "api",
  "provider": "jira",
  "api": {
    "baseUrl": "https://your-domain.atlassian.net/rest/api/3/",
    "authType": "basic",
    "testEndpoint": {
      "method": "GET",
      "path": "myself"
    }
  }
}
```

**Multi-header authentication:**

Some APIs require multiple authentication headers simultaneously. For example, Datadog requires both `DD-API-KEY` and `DD-APPLICATION-KEY`. Use the `headerNames` array to specify all required headers:

```json
{
  "type": "api",
  "provider": "datadog",
  "api": {
    "baseUrl": "https://api.datadoghq.com/api/",
    "authType": "header",
    "headerNames": ["DD-API-KEY", "DD-APPLICATION-KEY"],
    "testEndpoint": {
      "method": "GET",
      "path": "v1/validate"
    }
  }
}
```

When `headerNames` is specified:
- Each header name gets its own input field during authentication
- All header values are stored together as a JSON object
- Each header is added to every API request

To prompt for multi-header credentials:
```typescript
source_credential_prompt({
  sourceSlug: "datadog",
  mode: "multi-header",
  headerNames: ["DD-API-KEY", "DD-APPLICATION-KEY"],
  description: "Enter your Datadog API credentials"
})
```

Common multi-header use cases:
- **Datadog**: `DD-API-KEY` + `DD-APPLICATION-KEY`
- **APIs with identity + signing keys**: Separate API key and secret
- **Services with app + user credentials**: Application key plus user token

**Generic OAuth (authType: 'oauth'):**

For API sources that use OAuth 2.0 but aren't Google, Slack, or Microsoft. Two modes:

**Auto-discovery (recommended):** If the API supports RFC 9728 (OAuth Protected Resource Metadata), just set `authType: "oauth"` — endpoints and client registration are discovered automatically:

```json
{
  "name": "Craft Connect",
  "type": "api",
  "provider": "craft",
  "api": {
    "baseUrl": "https://connect.craft.do/my/api/v1/",
    "authType": "oauth"
  }
}
```

**Explicit config:** For APIs without standard OAuth metadata (GitHub, Linear, etc.), provide endpoints manually:

```json
{
  "name": "GitHub",
  "type": "api",
  "provider": "github",
  "api": {
    "baseUrl": "https://api.github.com/",
    "authType": "oauth",
    "oauth": {
      "authorizationUrl": "https://github.com/login/oauth/authorize",
      "tokenUrl": "https://github.com/login/oauth/access_token",
      "clientId": "Iv1.your_client_id",
      "clientSecret": "your_client_secret",
      "scopes": ["repo", "read:user"]
    }
  }
}
```

The `oauth` block fields (only needed for explicit config):
- `authorizationUrl` (required): The OAuth authorization endpoint
- `tokenUrl` (required): The OAuth token exchange endpoint
- `clientId` (required): Your OAuth app's client ID
- `clientSecret` (optional): Client secret — not required for public PKCE clients
- `scopes` (optional): Requested OAuth scopes
- `audience` (optional): Auth0-style audience parameter
- `extraParams` (optional): Additional query params for the authorization URL (e.g. `{"access_type": "offline"}`)

To trigger OAuth authentication, use `source_oauth_trigger` (the same tool used for MCP OAuth):
```typescript
source_oauth_trigger({ sourceSlug: "github" })
```

Tokens are sent as `Authorization: Bearer {token}` on every request. Token refresh is automatic when a refresh token is available.

**Basic auth with optional password:**

Some APIs use HTTP Basic Auth but only require the username field (API key), leaving the password empty. For these APIs, use `passwordRequired: false` when prompting for credentials:

```typescript
source_credential_prompt({
  sourceSlug: "ashby",
  mode: "basic",
  passwordRequired: false,  // Password field becomes optional
  labels: { username: "API Key" },
  description: "Enter your Ashby API key"
})
```

When `passwordRequired: false`:
- The password field shows "(optional)" label and "Optional - leave blank" placeholder
- The Save button enables with just a username
- Empty string is submitted for password (per HTTP Basic Auth spec: `base64(username:)`)

**Note:** `passwordRequired` only applies to `mode: "basic"`. It defaults to `true` for backward compatibility with services like Jira or Amplitude that require both username and password.

### testEndpoint Configuration

The `testEndpoint` specifies which endpoint to call when validating credentials:

```json
{
  "testEndpoint": {
    "method": "GET",           // "GET" or "POST"
    "path": "v1/me",           // Path relative to baseUrl (NO leading slash)
    "body": { ... }            // Optional: request body for POST
  }
}
```

**IMPORTANT URL formatting:**
- `baseUrl` MUST have a trailing slash: `https://api.example.com/v1/`
- `testEndpoint.path` must NOT have a leading slash: `users/me`

**Choose an endpoint that:**
- Requires authentication (to verify credentials work)
- Is lightweight (doesn't fetch much data)
- Returns quickly (health/status endpoints are ideal)

**Common patterns:**
- `me`, `user`, `profile` - User info endpoints
- `v1/status`, `health` - Status endpoints that require auth
- `models`, `projects` - List endpoints with minimal data

**Public APIs (authType: 'none')** don't require testEndpoint - we test by hitting the base URL.

### renewEndpoint Configuration (Optional)

The optional `renewEndpoint` enables automatic token renewal for non-OAuth bearer-token APIs. When the token expires, the system calls this endpoint to get a fresh token — no manual re-authentication needed.

```json
{
  "api": {
    "baseUrl": "https://api.example.com/",
    "authType": "bearer",
    "renewEndpoint": {
      "path": "auth/refresh",
      "method": "POST",
      "tokenField": "access_token",
      "expiresInField": "expires_in"
    }
  }
}
```

**Fields:**

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `path` | Yes | — | Renew URL — relative path (resolved against `baseUrl`) or absolute URL |
| `method` | No | `"POST"` | HTTP method: `"GET"` or `"POST"` |
| `body` | No | — | Request body (JSON). Use `{{token}}` as placeholder for the current access token |
| `headers` | No | — | Extra headers. Use `{{token}}` as placeholder. Merged on top of `defaultHeaders` |
| `tokenField` | No | `"access_token"` | JSON field name for the new token in the response |
| `expiresInField` | No | `"expires_in"` | JSON field name for expiry in seconds in the response |
| `fallbackTtlSecs` | No | — | Fallback TTL in seconds when the response doesn't include expiry info |

**How it works:**
1. Before each API request, the system checks if the token is expired or expiring soon (within 5 minutes)
2. If so, it calls the `renewEndpoint` with the current token in the Authorization header
3. The new token and expiry are extracted from the response and stored
4. The refreshed token is used for the API request

**Token substitution:** Use `{{token}}` in `body` or `headers` to insert the current access token. This supports nested objects — all string values are scanned recursively.

**Example with token in request body:**
```json
{
  "renewEndpoint": {
    "path": "auth/refresh",
    "body": { "current_token": "{{token}}" },
    "tokenField": "new_token",
    "expiresInField": "ttl"
  }
}
```

**When `body` is omitted**, the current token is sent via the standard Authorization header (using the source's `authScheme`).

**Note:** This is for APIs with their own token renewal mechanism, not OAuth. For OAuth-based APIs, use `authType: "oauth"` instead.

### Local Sources

Filesystem access for local folders.

```json
{
  "type": "local",
  "provider": "obsidian",
  "local": {
    "path": "/Users/me/Documents/ObsidianVault"
  }
}
```

Use path variables for cross-machine portability:
```json
{
  "type": "local",
  "provider": "obsidian",
  "local": {
    "path": "~/Documents/ObsidianVault"
  }
}
```

**After creating, run `source_test`** to validate the path exists and is accessible.

## guide.md Format

The guide.md file helps Claude understand how to use the source effectively.

```markdown
# Source Name

Brief description of what this source provides.

## Scope

What data/functionality this source provides access to.

## Guidelines

- Best practices for using this source
- Rate limits or quotas to be aware of
- Common patterns and examples

## API Reference

For API sources, document the available endpoints:

### POST /search
Search for content.

**Parameters:**
- `query` (string, required): Search query
- `limit` (number, optional): Max results (default: 10)

**Example:**
\`\`\`json
{
  "query": "machine learning",
  "limit": 5
}
\`\`\`
```

## permissions.json Format

Custom rules to extend Explore mode permissions for this source.

```json
{
  "allowedMcpPatterns": [
    {
      "pattern": "^mcp__linear__list",
      "comment": "Allow listing resources in Explore mode"
    }
  ],
  "allowedApiEndpoints": [
    {
      "method": "GET",
      "path": "^/search",
      "comment": "Allow search endpoint in Explore mode"
    },
    {
      "method": "POST",
      "path": "^/v1/query$",
      "comment": "POST allowed for query-only endpoints"
    }
  ],
  "allowedBashPatterns": [
    {
      "pattern": "^ls\\s",
      "comment": "Allow ls commands"
    }
  ]
}
```

