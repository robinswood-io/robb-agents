import { describe, expect, it } from 'bun:test'
import { PiAgent } from '../pi-agent.ts'
import type { BackendConfig } from '../backend/types.ts'

function createConfig(overrides: Partial<BackendConfig> = {}): BackendConfig {
  return {
    provider: 'pi',
    workspace: {
      id: 'ws-test',
      name: 'Test Workspace',
      rootPath: '/tmp/craft-agent-test',
    } as any,
    session: {
      id: 'session-test',
      workspaceRootPath: '/tmp/craft-agent-test',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    } as any,
    isHeadless: true,
    ...overrides,
  }
}

describe('PiAgent Bedrock env handling', () => {
  it('buildAwsEnv uses AWS env only and never sets CLAUDE_CODE_USE_BEDROCK', () => {
    const agent = new PiAgent(createConfig())

    const env = (agent as any).buildAwsEnv(
      {
        credential: {
          type: 'iam',
          accessKeyId: 'AKIA_TEST',
          secretAccessKey: 'secret',
          sessionToken: 'session',
          region: 'eu-central-1',
        },
      },
      { piAuthProvider: 'amazon-bedrock' },
    ) as Record<string, string>

    expect(env.AWS_ACCESS_KEY_ID).toBe('AKIA_TEST')
    expect(env.AWS_SECRET_ACCESS_KEY).toBe('secret')
    expect(env.AWS_SESSION_TOKEN).toBe('session')
    expect(env.AWS_REGION).toBe('eu-central-1')
    expect(env.AWS_BEDROCK_FORCE_HTTP1).toBe('1')
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined()

    agent.destroy()
  })

  it('buildAwsEnv returns empty env for non-Bedrock Pi providers', () => {
    const agent = new PiAgent(createConfig())

    const env = (agent as any).buildAwsEnv(
      {
        credential: {
          type: 'iam',
          accessKeyId: 'AKIA_TEST',
          secretAccessKey: 'secret',
          region: 'eu-central-1',
        },
      },
      { piAuthProvider: 'anthropic' },
    ) as Record<string, string>

    expect(env).toEqual({})

    agent.destroy()
  })

  it('copies the AWS credential chain only for explicit Bedrock environment auth', () => {
    const original = new Map<string, string | undefined>()
    const hostValues: Record<string, string> = {
      AWS_PROFILE: 'robb-bedrock',
      AWS_SHARED_CREDENTIALS_FILE: '/secure/aws/credentials',
      AWS_CONFIG_FILE: '/secure/aws/config',
      AWS_ACCESS_KEY_ID: 'AKIA_ENV_TEST',
      AWS_SECRET_ACCESS_KEY: 'environment-secret',
      AWS_SESSION_TOKEN: 'environment-session',
      AWS_REGION: 'eu-west-1',
      AWS_BEDROCK_FORCE_HTTP1: '0',
      AZURE_CLIENT_SECRET: 'must-not-leak',
    }

    for (const [key, value] of Object.entries(hostValues)) {
      original.set(key, process.env[key])
      process.env[key] = value
    }

    const environmentAgent = new PiAgent(createConfig({ authType: 'environment' }))
    const apiKeyAgent = new PiAgent(createConfig({ authType: 'api_key' }))
    try {
      const environmentEnv = (environmentAgent as any).buildAwsEnv(
        null,
        { piAuthProvider: 'amazon-bedrock' },
      ) as Record<string, string>
      const apiKeyEnv = (apiKeyAgent as any).buildAwsEnv(
        null,
        { piAuthProvider: 'amazon-bedrock' },
      ) as Record<string, string>

      expect(environmentEnv.AWS_PROFILE).toBe('robb-bedrock')
      expect(environmentEnv.AWS_SHARED_CREDENTIALS_FILE).toBe('/secure/aws/credentials')
      expect(environmentEnv.AWS_CONFIG_FILE).toBe('/secure/aws/config')
      expect(environmentEnv.AWS_ACCESS_KEY_ID).toBe('AKIA_ENV_TEST')
      expect(environmentEnv.AWS_SECRET_ACCESS_KEY).toBe('environment-secret')
      expect(environmentEnv.AWS_SESSION_TOKEN).toBe('environment-session')
      expect(environmentEnv.AWS_REGION).toBe('eu-west-1')
      expect(environmentEnv.AZURE_CLIENT_SECRET).toBeUndefined()
      expect(environmentEnv.AWS_BEDROCK_FORCE_HTTP1).toBe('0')

      expect(apiKeyEnv.AWS_ACCESS_KEY_ID).toBeUndefined()
      expect(apiKeyEnv.AWS_SECRET_ACCESS_KEY).toBeUndefined()
      expect(apiKeyEnv.AWS_PROFILE).toBeUndefined()
      expect(apiKeyEnv.AWS_BEDROCK_FORCE_HTTP1).toBe('0')
    } finally {
      environmentAgent.destroy()
      apiKeyAgent.destroy()
      for (const [key, value] of original) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })
})
