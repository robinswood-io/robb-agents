import { CliRpcClient } from './client.ts';
import type { CliArgs } from './cli-args.ts';

// ---------------------------------------------------------------------------
// LLM connection helpers
// ---------------------------------------------------------------------------

const PROVIDER_ENV_KEYS: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  groq: 'GROQ_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  xai: 'XAI_API_KEY',
  cerebras: 'CEREBRAS_API_KEY',
  huggingface: 'HUGGINGFACE_API_KEY',
}

const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  openrouter: 'OpenRouter',
  groq: 'Groq',
  mistral: 'Mistral',
  deepseek: 'DeepSeek',
  xai: 'xAI',
  cerebras: 'Cerebras',
  huggingface: 'Hugging Face',
  'amazon-bedrock': 'Amazon Bedrock',
}

export function getProviderDisplayName(provider: string): string {
  return PROVIDER_DISPLAY_NAMES[provider] ?? provider.charAt(0).toUpperCase() + provider.slice(1)
}

export function resolveApiKey(provider: string, explicit: string): string {
  if (explicit) return explicit
  if (provider === 'amazon-bedrock') return '' // IAM credentials, not API key
  const envKey = PROVIDER_ENV_KEYS[provider]
  if (envKey && process.env[envKey]) return process.env[envKey]!
  throw new Error(
    `No API key found. Use --api-key, set $LLM_API_KEY, or set $${envKey ?? `${provider.toUpperCase()}_API_KEY`}`,
  )
}

export function shouldSetupLlmConnection(existingConnectionCount: number, args: Pick<CliArgs, 'provider' | 'baseUrl'>): boolean {
  return existingConnectionCount === 0 || !!args.baseUrl || args.provider !== 'anthropic'
}

export async function setupLlmConnection(
  client: CliRpcClient,
  args: CliArgs,
): Promise<{ connectionSlug: string }> {
  const { provider, baseUrl } = args
  const key = resolveApiKey(provider, args.apiKey)
  const connectionSlug = `${provider}-cli`

  let providerType: string
  let authType: string
  const setupPayload: Record<string, unknown> = { slug: connectionSlug, credential: key }

  if (baseUrl) {
    // Custom endpoint — send the same payload shape as the desktop UI.
    // The server handler (llm-connections.ts:102-110) detects customEndpoint + baseUrl
    // and sets providerType='pi_compat', piAuthProvider, etc.
    providerType = 'pi_compat'
    authType = 'api_key_with_endpoint'
    setupPayload.baseUrl = baseUrl
    setupPayload.customEndpoint = {
      api: provider === 'anthropic' ? 'anthropic-messages' : 'openai-completions',
    }
    setupPayload.defaultModel = provider === 'anthropic' ? 'claude-sonnet-4-6' : 'gpt-4o'
  } else if (provider === 'anthropic') {
    providerType = 'anthropic'
    authType = 'api_key'
  } else if (provider === 'amazon-bedrock') {
    // Bedrock uses IAM credentials, not a single API key
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY
    const region = process.env.AWS_REGION || 'us-east-1'
    const sessionToken = process.env.AWS_SESSION_TOKEN
    if (!accessKeyId || !secretAccessKey) {
      throw new Error(
        'Amazon Bedrock requires AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY environment variables',
      )
    }
    providerType = 'pi'
    authType = 'iam_credentials'
    setupPayload.piAuthProvider = 'amazon-bedrock'
    setupPayload.bedrockAuthMethod = 'iam_credentials'
    setupPayload.iamCredentials = { accessKeyId, secretAccessKey, sessionToken }
    setupPayload.awsRegion = region
    delete setupPayload.credential // IAM credentials go through iamCredentials field
  } else {
    providerType = 'pi'
    authType = 'api_key'
    setupPayload.piAuthProvider = provider
  }

  await client.invoke('LLM_Connection:save', {
    slug: connectionSlug,
    name: getProviderDisplayName(provider),
    providerType,
    authType,
    createdAt: Date.now(),
  })
  const setupResult = await client.invoke('settings:setupLlmConnection', setupPayload) as { success: boolean; error?: string }
  if (!setupResult?.success) {
    throw new Error(`LLM connection setup failed: ${setupResult?.error ?? 'unknown error'}`)
  }
  await client.invoke('LLM_Connection:setDefault', connectionSlug)
  process.stderr.write(`LLM connection configured: ${provider}${baseUrl ? ` (${baseUrl})` : ''}\n`)

  return { connectionSlug }
}
