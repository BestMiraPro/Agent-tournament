import { describe, expect, test } from 'vitest'
import { relayUpstreamsFromAuth } from '../../src/runtime/relay-credentials.js'

// Fake keys only: this file is a fixture, not anyone's credentials.
const auth = JSON.stringify({
  wandb: { type: 'api', key: 'FAKE-WANDB-KEY-123' },
  google: { type: 'api', key: 'FAKE-GOOGLE-KEY-456' },
  anthropic: { type: 'oauth', access: 'FAKE-ACCESS-789', refresh: 'FAKE-REFRESH-000', expires: 1 },
  bedrock: { type: 'api', key: 'FAKE-BEDROCK-KEY' },
})
const catalog = {
  wandb: { api: 'https://api.inference.wandb.ai/v1', npm: '@ai-sdk/openai-compatible' },
  google: { api: null, npm: '@ai-sdk/google' },
  anthropic: { api: null, npm: '@ai-sdk/anthropic' },
  bedrock: { api: null, npm: '@ai-sdk/amazon-bedrock' },
  opencode: { api: 'https://opencode.ai/zen/v1', npm: '@ai-sdk/openai-compatible' },
  deepseek: { api: 'https://api.deepseek.com/v1', npm: '@ai-sdk/openai-compatible' },
}

describe('relayUpstreamsFromAuth', () => {
  test('builds an upstream with its key for each roster provider the relay can carry', () => {
    const { upstreams } = relayUpstreamsFromAuth(auth, catalog, ['wandb', 'google'])
    expect(upstreams).toEqual([
      { providerId: 'wandb', baseUrl: 'https://api.inference.wandb.ai/v1', authStyle: 'bearer', apiKey: 'FAKE-WANDB-KEY-123' },
      { providerId: 'google', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', authStyle: 'x-goog-api-key', apiKey: 'FAKE-GOOGLE-KEY-456' },
    ])
  })

  test('says why a provider cannot be relayed, and never repeats a key while saying it', () => {
    const { upstreams, unsupported } = relayUpstreamsFromAuth(auth, catalog, ['anthropic', 'bedrock', 'deepseek', 'mystery'])
    expect(upstreams).toEqual([])
    expect(unsupported).toEqual([
      { providerId: 'anthropic', reason: 'anthropic is signed in with an OAuth login, which the relay cannot carry; add an API key for it' },
      { providerId: 'bedrock', reason: 'bedrock uses an SDK the relay cannot carry' },
      { providerId: 'deepseek', reason: 'no API key for deepseek in the credentials file' },
      { providerId: 'mystery', reason: 'mystery is not in the model catalogue' },
    ])
    expect(JSON.stringify(unsupported)).not.toMatch(/FAKE-/)
  })

  test('OpenCode Zen without a login uses the public key OpenCode itself sends, so free models still work', () => {
    const { upstreams, unsupported } = relayUpstreamsFromAuth(auth, catalog, ['opencode'])
    expect(upstreams).toEqual([{ providerId: 'opencode', baseUrl: 'https://opencode.ai/zen/v1', authStyle: 'bearer', apiKey: 'public' }])
    expect(unsupported).toEqual([])
    const signedIn = relayUpstreamsFromAuth(JSON.stringify({ opencode: { type: 'api', key: 'FAKE-ZEN-KEY' } }), catalog, ['opencode'])
    expect(signedIn.upstreams[0]!.apiKey).toBe('FAKE-ZEN-KEY')
  })

  test('an unreadable credentials file is refused without echoing it', () => {
    expect(() => relayUpstreamsFromAuth('{"wandb": {"type": "api", "key": "FAKE-SECRET"', catalog, ['wandb'])).toThrow('the credentials file is not valid JSON')
    try {
      relayUpstreamsFromAuth('{"wandb": "FAKE-SECRET"', catalog, ['wandb'])
    } catch (e) {
      expect(String(e)).not.toContain('FAKE-SECRET')
    }
  })
})
