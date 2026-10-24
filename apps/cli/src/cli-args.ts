
export interface CliArgs {
  url: string
  token: string
  workspace?: string
  timeout: number
  json: boolean
  tlsCa?: string
  sendTimeout: number
  command: string
  rest: string[]
  // run-specific flags
  sources: string[]
  mode: string
  outputFormat: string
  noCleanup: boolean
  noSpinner: boolean
  verbose: boolean
  serverEntry?: string
  workspaceDir?: string
  // LLM configuration
  provider: string
  model: string
  apiKey: string
  baseUrl: string
}

export function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2) // skip bun + script path
  let url = ''
  let token = ''
  let workspace: string | undefined
  let timeout = 10_000
  let json = false
  let tlsCa: string | undefined
  let sendTimeout = 300_000 // 5 min
  const rest: string[] = []
  let command = ''
  const sources: string[] = []
  let mode = ''
  let outputFormat = 'text'
  let noCleanup = false
  let noSpinner = false
  let verbose = false
  let serverEntry: string | undefined
  let workspaceDir: string | undefined
  let provider = ''
  let model = ''
  let apiKey = ''
  let baseUrl = ''

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    switch (arg) {
      case '--url':
        url = args[++i] ?? ''
        break
      case '--token':
        token = args[++i] ?? ''
        break
      case '--workspace':
        workspace = args[++i]
        break
      case '--timeout':
        timeout = parseInt(args[++i] ?? '10000', 10)
        break
      case '--json':
        json = true
        break
      case '--tls-ca':
        tlsCa = args[++i]
        break
      case '--send-timeout':
        sendTimeout = parseInt(args[++i] ?? '300000', 10)
        break
      case '--source':
        sources.push(args[++i] ?? '')
        break
      case '--mode':
        mode = args[++i] ?? ''
        break
      case '--output-format':
        outputFormat = args[++i] ?? 'text'
        break
      case '--no-cleanup':
        noCleanup = true
        break
      case '--disable-spinner':
      case '--no-spinner':
        noSpinner = true
        break
      case '--verbose':
      case '-v':
        verbose = true
        break
      case '--server-entry':
        serverEntry = args[++i]
        break
      case '--workspace-dir':
        workspaceDir = args[++i]
        break
      case '--provider':
        provider = args[++i] ?? ''
        break
      case '--model':
        model = args[++i] ?? ''
        break
      case '--api-key':
        apiKey = args[++i] ?? ''
        break
      case '--base-url':
        baseUrl = args[++i] ?? ''
        break
      case '--help':
      case '-h':
        command = 'help'
        break
      case '--version':
        command = 'version'
        break
      case '--validate-server':
        command = 'validate'
        break
      default:
        if (!command && !arg.startsWith('-')) {
          command = arg
        } else {
          rest.push(arg)
        }
    }
  }

  // Env var fallbacks
  if (!url) url = process.env.CRAFT_SERVER_URL ?? ''
  if (!token) token = process.env.CRAFT_SERVER_TOKEN ?? ''
  if (!tlsCa) tlsCa = process.env.CRAFT_TLS_CA
  if (!provider) provider = process.env.LLM_PROVIDER ?? 'anthropic'
  if (!model) model = process.env.LLM_MODEL ?? ''
  if (!apiKey) apiKey = process.env.LLM_API_KEY ?? ''
  if (!baseUrl) baseUrl = process.env.LLM_BASE_URL ?? ''

  return { url, token, workspace, timeout, json, tlsCa, sendTimeout, command, rest, sources, mode, outputFormat, noCleanup, noSpinner, verbose, serverEntry, workspaceDir, provider, model, apiKey, baseUrl }
}
