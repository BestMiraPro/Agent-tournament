import { describe, expect, test } from 'vitest'
import { RelayPolicy, upstreamFor, type RelayRequest } from '../../src/runtime/provider-relay.js'

const upstreams = [
  { providerId: 'wandb', baseUrl: 'https://api.inference.wandb.ai/v1', authStyle: 'bearer' as const, apiKey: 'REAL-WANDB-KEY' },
  { providerId: 'google', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', authStyle: 'x-goog-api-key' as const, apiKey: 'REAL-GOOGLE-KEY' },
  { providerId: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', authStyle: 'x-api-key' as const, apiKey: 'REAL-ANTHROPIC-KEY' },
]
const limits = { maxRequestBytes: 1024, maxResponseBytes: 4096 }

const policy = () => {
  const p = new RelayPolicy(upstreams, limits)
  p.grant('run-1', { token: 'tok-1', allowedModels: ['wandb/zai-org/GLM-5.2', 'google/gemini-3.1-flash', 'anthropic/claude-opus-5'], maxRequests: 3 })
  return p
}
const json = (body: unknown) => Buffer.from(JSON.stringify(body))
const chat = (over: Partial<RelayRequest> = {}): RelayRequest => ({
  method: 'POST',
  path: '/wandb/chat/completions',
  headers: { authorization: 'Bearer tok-1', 'content-type': 'application/json', cookie: 'x=1', host: 'relay', 'x-forwarded-for': '1.2.3.4' },
  body: json({ model: 'zai-org/GLM-5.2', messages: [] }),
  ...over,
})

describe('RelayPolicy', () => {
  test('forwards an allowed model call to the fixed upstream with the real key swapped in', () => {
    const d = policy().authorize(chat())
    expect(d).toEqual({
      ok: true,
      runId: 'run-1',
      modelId: 'wandb/zai-org/GLM-5.2',
      url: 'https://api.inference.wandb.ai/v1/chat/completions',
      headers: { authorization: 'Bearer REAL-WANDB-KEY', 'content-type': 'application/json' },
      body: json({ model: 'zai-org/GLM-5.2', messages: [] }),
    })
  })

  test('each provider gets its own key header, and the worker token never travels upstream', () => {
    const g = policy().authorize({
      method: 'POST',
      path: '/google/models/gemini-3.1-flash:streamGenerateContent?alt=sse',
      headers: { 'x-goog-api-key': 'tok-1', 'content-type': 'application/json' },
      body: json({ contents: [] }),
    })
    expect(g).toMatchObject({
      ok: true, modelId: 'google/gemini-3.1-flash',
      url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash:streamGenerateContent?alt=sse',
      headers: { 'x-goog-api-key': 'REAL-GOOGLE-KEY' },
    })
    const a = policy().authorize({
      method: 'POST', path: '/anthropic/messages',
      headers: { 'x-api-key': 'tok-1', 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
      body: json({ model: 'claude-opus-5', messages: [] }),
    })
    expect(a).toMatchObject({ ok: true, headers: { 'x-api-key': 'REAL-ANTHROPIC-KEY', 'anthropic-version': '2023-06-01' } })
    expect(JSON.stringify([g, a])).not.toContain('tok-1')
  })

  test("OpenCode's client identification reaches OpenCode Zen only, bounded, and never another provider", () => {
    const client = {
      'user-agent': 'opencode/1.18.21', 'x-opencode-client': 'cli', 'x-opencode-session': 'ses_1',
      'x-opencode-project': 'x'.repeat(300), 'x-opencode-directory': '/work/a1',
    }
    const p = new RelayPolicy([], limits)
    p.grant('run-z', {
      token: 'tok-z', allowedModels: ['opencode/muse-spark-free', 'wandb/zai-org/GLM-5.2'], maxRequests: 5,
      upstreams: [
        { providerId: 'opencode', baseUrl: 'https://opencode.ai/zen/v1', authStyle: 'bearer', apiKey: 'public' },
        upstreams[0]!,
      ],
    })
    const zen = p.authorize(chat({
      path: '/opencode/chat/completions',
      headers: { authorization: 'Bearer tok-z', 'content-type': 'application/json', ...client },
      body: json({ model: 'muse-spark-free', messages: [] }),
    }))
    expect(zen).toMatchObject({
      ok: true,
      headers: {
        authorization: 'Bearer public', 'content-type': 'application/json',
        'user-agent': 'opencode/1.18.21', 'x-opencode-client': 'cli', 'x-opencode-session': 'ses_1',
      },
    })
    const zenHeaders = (zen as { headers: Record<string, string> }).headers
    expect(zenHeaders['x-opencode-project']).toBeUndefined()
    expect(zenHeaders['x-opencode-directory']).toBeUndefined()
    const wandb = p.authorize(chat({ headers: { authorization: 'Bearer tok-z', 'content-type': 'application/json', ...client } }))
    expect((wandb as { headers: Record<string, string> }).headers).toEqual({ authorization: 'Bearer REAL-WANDB-KEY', 'content-type': 'application/json' })
  })

  test('refuses a missing, unknown or revoked token', () => {
    const p = policy()
    expect(p.authorize(chat({ headers: { 'content-type': 'application/json' } }))).toMatchObject({ ok: false, status: 401 })
    expect(p.authorize(chat({ headers: { authorization: 'Bearer nope', 'content-type': 'application/json' } }))).toMatchObject({ ok: false, status: 401 })
    p.revoke('run-1')
    expect(p.authorize(chat())).toMatchObject({ ok: false, status: 401 })
  })

  test('refuses a model outside the run roster, naming it', () => {
    expect(policy().authorize(chat({ body: json({ model: 'deepseek-ai/DeepSeek-V4-Pro', messages: [] }) }))).toEqual({
      ok: false, status: 403, runId: 'run-1',
      error: 'model wandb/deepseek-ai/DeepSeek-V4-Pro is not in this run\'s roster',
    })
  })

  test('is not a general proxy: unknown providers, other paths, other methods, queries and traversal are refused', () => {
    const p = policy()
    for (const path of ['/openai/chat/completions', '/wandb/models', '/wandb/../../etc/passwd', '/wandb/chat/completions?url=https://evil', '/https://evil.example/x']) {
      expect(p.authorize(chat({ path }))).toMatchObject({ ok: false, status: 404 })
    }
    expect(p.authorize(chat({ method: 'GET' }))).toMatchObject({ ok: false, status: 405 })
    expect(p.authorize({ ...chat(), method: 'CONNECT', path: 'api.inference.wandb.ai:443' })).toMatchObject({ ok: false, status: 405 })
  })

  test('bounds request size and count per run', () => {
    const p = policy()
    expect(p.authorize(chat({ body: Buffer.alloc(2048, 32) }))).toMatchObject({ ok: false, status: 413 })
    expect(p.authorize(chat({ body: Buffer.from('not json') }))).toMatchObject({ ok: false, status: 400 })
    for (let i = 0; i < 3; i++) expect(p.authorize(chat()).ok).toBe(true)
    expect(p.authorize(chat())).toMatchObject({ ok: false, status: 429, error: 'this run used all 3 relay requests it was granted' })
  })

  test('each run can carry its own upstream keys, and reaches only its own providers', () => {
    const p = new RelayPolicy([], limits)
    p.grant('run-a', {
      token: 'tok-a', allowedModels: ['wandb/zai-org/GLM-5.2'], maxRequests: 5,
      upstreams: [{ providerId: 'wandb', baseUrl: 'https://api.inference.wandb.ai/v1', authStyle: 'bearer', apiKey: 'KEY-A' }],
    })
    p.grant('run-b', {
      token: 'tok-b', allowedModels: ['wandb/zai-org/GLM-5.2'], maxRequests: 5,
      upstreams: [{ providerId: 'wandb', baseUrl: 'https://api.inference.wandb.ai/v1', authStyle: 'bearer', apiKey: 'KEY-B' }],
    })
    const as = (token: string) => p.authorize(chat({ headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } }))
    expect(as('tok-a')).toMatchObject({ ok: true, runId: 'run-a', headers: { authorization: 'Bearer KEY-A' } })
    expect(as('tok-b')).toMatchObject({ ok: true, runId: 'run-b', headers: { authorization: 'Bearer KEY-B' } })
    // run-b holds no google upstream, so a google path is not an endpoint for it at all.
    expect(p.authorize({
      method: 'POST', path: '/google/models/gemini-3.1-flash:generateContent',
      headers: { 'x-goog-api-key': 'tok-b', 'content-type': 'application/json' }, body: json({}),
    })).toMatchObject({ ok: false })
  })

  test('a token is scoped to its own run', () => {
    const p = policy()
    p.grant('run-2', { token: 'tok-2', allowedModels: ['wandb/other/model'], maxRequests: 5 })
    expect(p.authorize(chat({ headers: { authorization: 'Bearer tok-2', 'content-type': 'application/json' } })))
      .toMatchObject({ ok: false, status: 403, runId: 'run-2' })
    expect(p.limits).toEqual(limits)
  })
})

describe('upstreamFor', () => {
  test('maps catalogue providers to a fixed https upstream and key header, or refuses', () => {
    expect(upstreamFor('wandb', { api: 'https://api.inference.wandb.ai/v1', npm: '@ai-sdk/openai-compatible' }))
      .toEqual({ providerId: 'wandb', baseUrl: 'https://api.inference.wandb.ai/v1', authStyle: 'bearer' })
    expect(upstreamFor('openai', { api: null, npm: '@ai-sdk/openai' })).toEqual({ providerId: 'openai', baseUrl: 'https://api.openai.com/v1', authStyle: 'bearer' })
    expect(upstreamFor('google', { api: null, npm: '@ai-sdk/google' })).toMatchObject({ authStyle: 'x-goog-api-key' })
    expect(upstreamFor('anthropic', { api: null, npm: '@ai-sdk/anthropic' })).toMatchObject({ authStyle: 'x-api-key' })
    expect(upstreamFor('bedrock', { api: null, npm: '@ai-sdk/amazon-bedrock' })).toBeNull()
    expect(upstreamFor('plain', { api: 'http://insecure.example/v1', npm: '@ai-sdk/openai-compatible' })).toBeNull()
  })
})
