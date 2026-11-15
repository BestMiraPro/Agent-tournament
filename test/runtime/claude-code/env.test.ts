import { describe, expect, test } from 'vitest'
import { claudeEnvVars, claudeProcessEnv, isStrippedVariable, strippedEnv } from '../../../src/runtime/claude-code/env.js'

// What a Claude Code desktop session leaks into the processes it starts (variable names seen on
// this machine), plus the billing switches.
const inherited: NodeJS.ProcessEnv = {
  PATH: '/usr/bin',
  HOME: '/home/owner',
  ANTHROPIC_API_KEY: 'sk-ant-api-should-not-pass',
  ANTHROPIC_AUTH_TOKEN: 'x',
  ANTHROPIC_BASE_URL: 'http://127.0.0.1:9999',
  ANTHROPIC_VERTEX_PROJECT_ID: 'p',
  CLAUDECODE: '1',
  CLAUDE_CODE_ENTRYPOINT: 'sdk-ts',
  CLAUDE_CODE_SESSION_ID: 's',
  CLAUDE_CODE_SSE_PORT: '1',
  CLAUDE_CODE_OAUTH_TOKEN: 'someone-elses-token',
  CLAUDE_CODE_USE_BEDROCK: '1',
  CLAUDE_CODE_USE_VERTEX: '1',
  CLAUDE_CODE_USE_FOUNDRY: '1',
  CLAUDE_CODE_SIMPLE: '1',
  CLAUDE_AGENT_SDK_VERSION: '1',
  CLAUDE_CONFIG_DIR: '/elsewhere',
  CLAUDE_PID: '7',
  claude_lowercase: 'x',
}

describe('Claude CLI environment', () => {
  test('drops every Anthropic and Claude variable an outer session or shell set', () => {
    const env = strippedEnv(inherited)
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/home/owner' })
    expect(isStrippedVariable('Claude_Code_Use_Bedrock')).toBe(true)
  })

  test('token mode passes the token on a descriptor, never in the environment, with a private config dir', () => {
    const env = claudeProcessEnv(inherited, { credentials: { mode: 'token', token: 'sk-ant-oat01-secret' }, tokenTransport: 'fd', configDir: '/runs/cfg' })
    expect(env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR).toBe('3')
    expect(env.CLAUDE_CONFIG_DIR).toBe('/runs/cfg')
    expect(JSON.stringify(env)).not.toContain('sk-ant-oat01-secret')
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined()
    expect(env).toMatchObject({
      DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
    })
  })

  test('host mode keeps the machine login: no token, no config dir override', () => {
    const env = claudeProcessEnv(inherited, { credentials: { mode: 'host' }, tokenTransport: 'fd' })
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    expect(env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR).toBeUndefined()
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined()
    expect(env.HOME).toBe('/home/owner')
  })

  test('a docker exec gets the token as a secret variable, kept apart from command-line settings', () => {
    const { settings, secrets } = claudeEnvVars({ credentials: { mode: 'token', token: 'tok-12345678901234567890' }, tokenTransport: 'env' })
    expect(secrets).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'tok-12345678901234567890' })
    expect(JSON.stringify(settings)).not.toContain('tok-')
  })

  test('relay mode points the CLI at the relay and pins auxiliary calls to the agent model', () => {
    const { settings, secrets } = claudeEnvVars({
      credentials: { mode: 'relay', baseUrl: 'http://gateway:8787/claude-subscription', token: 'run-token' },
      tokenTransport: 'env', model: 'claude-opus-5-5',
    })
    expect(settings).toMatchObject({
      ANTHROPIC_BASE_URL: 'http://gateway:8787/claude-subscription',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-opus-5-5',
      ANTHROPIC_SMALL_FAST_MODEL: 'claude-opus-5-5',
    })
    expect(secrets).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'run-token' })
  })
})
