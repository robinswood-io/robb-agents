
// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

export function printHelp(): void {
  process.stdout.write(`craft-cli — Terminal client for Craft Agent server

Usage: craft-cli [options] <command> [args...]

Connection:
  --url <ws[s]://...>    Server URL (default: $CRAFT_SERVER_URL)
  --token <secret>       Auth token (default: $CRAFT_SERVER_TOKEN)
  --workspace <id>       Workspace ID (auto-detected if omitted)
  --timeout <ms>         Request timeout (default: 10000)
  --tls-ca <path>        Custom CA cert for self-signed TLS
  --json                 Raw JSON output for scripting

LLM Configuration (for 'run' command):
  --provider <name>      LLM provider (default: anthropic, or $LLM_PROVIDER)
                         Supported: anthropic, openai, google, openrouter, groq, mistral, deepseek, xai, ...
  --model <id>           Model to use (or $LLM_MODEL)
  --api-key <key>        API key (or $LLM_API_KEY, or provider-specific e.g. $OPENAI_API_KEY)
  --base-url <url>       Custom API endpoint (or $LLM_BASE_URL)

Commands:
  run <message>          Spawn server, send message, stream response, exit
                         --workspace-dir <path>  Use directory as workspace (creates if needed)
                         --source <slug>     Enable source (repeatable)
                         --mode <mode>       Permission mode (default: allow-all)
                         --output-format     text or stream-json (default: text)
                         --no-cleanup        Keep session after completion
                         --server-entry      Path to server/index.ts
  ping                   Verify connectivity (clientId + latency)
  health                 Check credential store health
  versions               Show server runtime versions
  workspaces             List workspaces
  sessions               List sessions in workspace
  connections            List LLM connections
  sources                List configured sources
  session create         Create a session (--name, --mode)
  session messages <id>  Print session message history
  session delete <id>    Delete a session
  send <id> <message>    Send message and stream AI response
  cancel <id>            Cancel in-progress processing
  invoke <channel> [...] Raw RPC call with JSON args
  listen <channel>       Subscribe to push events (Ctrl+C to stop)
  --validate-server      Multi-step server integration test
                         --verbose, -v       Show server stderr output

Examples:
  craft-cli run "What files are in the current directory?"
  craft-cli run --source craft-kb "Summarize today's daily note"
  craft-cli run --workspace-dir .github/agents --source craft-public "Read the doc"
  craft-cli run --provider openai --model gpt-4o "Summarize this repo"
  OPENAI_API_KEY=sk-... craft-cli run --provider openai "Hello"
  GOOGLE_API_KEY=... craft-cli run --provider google --model gemini-2.0-flash "Hello"
  DEEPSEEK_API_KEY=sk-... craft-cli run --provider deepseek --model deepseek-v4-flash "Hello"
  echo "Analyze this code" | craft-cli run
  craft-cli ping
  craft-cli sessions
  craft-cli send abc-123 "What files are in the current directory?"
  echo "Summarize this" | craft-cli send abc-123
  craft-cli --validate-server
  craft-cli invoke system:homeDir
  craft-cli --json workspaces | jq '.[].name'
`)
}
