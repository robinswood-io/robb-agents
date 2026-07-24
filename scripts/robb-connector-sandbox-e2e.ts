import {
  fetchConnectorSandboxTransport,
  runConnectorSandboxProbe,
  type ConnectorSandboxProvider,
} from '../packages/shared/src/connectors/sandbox-e2e'

const supportedProviders = new Set<ConnectorSandboxProvider>([
  'microsoft365',
  'googleWorkspace',
  'slack',
  'hubspot',
  'genericCrm',
  'genericErp',
])

function providerFromEnvironment(value: string | undefined): ConnectorSandboxProvider {
  if (value && supportedProviders.has(value as ConnectorSandboxProvider)) {
    return value as ConnectorSandboxProvider
  }
  throw new Error(
    'ROBB_CONNECTOR_SANDBOX_PROVIDER must be one of: '
    + [...supportedProviders].join(', '),
  )
}

async function main(): Promise<void> {
  const provider = providerFromEnvironment(process.env.ROBB_CONNECTOR_SANDBOX_PROVIDER)
  const accessToken = process.env.ROBB_CONNECTOR_SANDBOX_ACCESS_TOKEN
  if (!accessToken) {
    throw new Error('ROBB_CONNECTOR_SANDBOX_ACCESS_TOKEN is required and is never printed')
  }
  const result = await runConnectorSandboxProbe({
    provider,
    accessToken,
    endpoint: process.env.ROBB_CONNECTOR_SANDBOX_ENDPOINT,
    transport: fetchConnectorSandboxTransport,
  })
  console.log(
    JSON.stringify({
      provider: result.provider,
      endpoint: result.endpoint,
      status: result.status,
      authenticated: result.authenticated,
    }),
  )
}

await main()
