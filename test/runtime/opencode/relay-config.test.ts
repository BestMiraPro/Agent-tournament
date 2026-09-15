import { describe, expect, test } from 'vitest'
import { relayProviderConfig } from '../../../src/runtime/opencode/relay-config.js'

describe('relayProviderConfig', () => {
  test('points each roster provider at the relay with the run token in place of a key', () => {
    const json = relayProviderConfig({ providers: ['wandb', 'google', 'wandb'], relayBaseUrl: 'http://gateway:8787', token: 'tok-abc' })
    expect(JSON.parse(json)).toEqual({
      $schema: 'https://opencode.ai/config.json',
      provider: {
        google: { options: { baseURL: 'http://gateway:8787/google', apiKey: 'tok-abc' } },
        wandb: { options: { baseURL: 'http://gateway:8787/wandb', apiKey: 'tok-abc' } },
      },
    })
  })

  test('refuses provider ids and relay URLs that could redirect a worker elsewhere', () => {
    expect(() => relayProviderConfig({ providers: ['wandb/../x'], relayBaseUrl: 'http://gateway:8787', token: 't' })).toThrow(/provider id/)
    expect(() => relayProviderConfig({ providers: ['wandb'], relayBaseUrl: 'http://gateway:8787/', token: 't' })).toThrow(/relay URL/)
    expect(() => relayProviderConfig({ providers: ['wandb'], relayBaseUrl: 'https://api.inference.wandb.ai', token: 't' })).toThrow(/relay URL/)
  })
})
