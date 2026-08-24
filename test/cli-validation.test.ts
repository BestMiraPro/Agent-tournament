import { describe, expect, test } from 'vitest'
import { validateRosterModels } from '../src/cli.js'
import { DEFAULT_CONFIG, type RunConfig } from '../src/core/types.js'
import type { OpenCodeClient, PromptBody, PromptResponse } from '../src/runtime/opencode/client.js'

/** Builds a fake OpenCodeClient whose `prompt` is fully controlled by the test. */
function fakeClient(
  prompt: (sessionId: string, directory: string, body: PromptBody) => Promise<PromptResponse>,
): OpenCodeClient {
  return {
    createSession: async () => ({ id: 'ses_1' }),
    prompt,
  } as unknown as OpenCodeClient
}

describe('validateRosterModels', () => {
  test('all models usable resolves; a model repeated across roster entries is probed once for the worker role', async () => {
    const calls: { modelId: string; structured: boolean }[] = []
    const client = fakeClient(async (_sessionId, _directory, body) => {
      calls.push({ modelId: `${body.model.providerID}/${body.model.modelID}`, structured: !!body.format })
      return body.format
        ? {
            info: {},
            parts: [
              {
                type: 'tool',
                tool: 'StructuredOutput',
                state: { input: { ok: 'ok' }, metadata: { valid: true } },
              },
            ],
          }
        : { info: {}, parts: [{ type: 'text', text: 'ok' }] }
    })

    const config: RunConfig = {
      ...DEFAULT_CONFIG,
      roster: [
        { modelId: 'opencode/big-pickle', count: 3, temperature: 0.7 },
        { modelId: 'opencode/big-pickle', count: 2, temperature: 0.8 },
        { modelId: 'wandb/deepseek-ai/DeepSeek-V4-Flash', count: 5, temperature: 0.7 },
      ],
      judge: { ...DEFAULT_CONFIG.judge, modelId: 'wandb/zai-org/GLM-5.2' },
      reflect: { ...DEFAULT_CONFIG.reflect, modelId: 'wandb/deepseek-ai/DeepSeek-V4-Flash' },
    }

    await expect(validateRosterModels(client, '/workspace', config)).resolves.toBeUndefined()

    const bigPickleCalls = calls.filter((c) => c.modelId === 'opencode/big-pickle')
    expect(bigPickleCalls).toHaveLength(1)
    // worker(big-pickle) + worker(deepseek) + judge(GLM-5.2) + reflect(deepseek) = 4 distinct probes
    expect(calls).toHaveLength(4)
  })

  test('a model that 404s throws, naming the model and the 404', async () => {
    const client = fakeClient(async () => ({
      info: { error: { name: 'APIError', data: { statusCode: 404, message: 'Not Found' } } },
      parts: [],
    }))

    const config: RunConfig = {
      ...DEFAULT_CONFIG,
      roster: [{ modelId: 'wandb/moonshotai/Kimi-K3', count: 5, temperature: 0.7 }],
    }

    await expect(validateRosterModels(client, '/workspace', config)).rejects.toThrow(/Kimi-K3/)
    await expect(validateRosterModels(client, '/workspace', config)).rejects.toThrow(/404/)
  })

  test('a worker-capable but structured-incapable model used as judge throws naming the judge role', async () => {
    const client = fakeClient(async (_sessionId, _directory, body) => {
      // Structured requests come back text-only (simulates a model that 400s / silently
      // ignores the schema); plain text requests succeed.
      if (body.format) {
        return { info: {}, parts: [{ type: 'text', text: 'nope' }] }
      }
      return { info: {}, parts: [{ type: 'text', text: 'ok' }] }
    })

    const config: RunConfig = {
      ...DEFAULT_CONFIG,
      roster: [{ modelId: 'opencode/muse-spark-1.2-contributor-free', count: 5, temperature: 0.7 }],
      judge: { ...DEFAULT_CONFIG.judge, modelId: 'opencode/muse-spark-1.2-contributor-free' },
    }

    await expect(validateRosterModels(client, '/workspace', config)).rejects.toThrow(
      /muse-spark-1\.2-contributor-free as judge/,
    )
  })

  test('validateModels: false skips all probes', async () => {
    let calls = 0
    const client = fakeClient(async () => {
      calls++
      return { info: {}, parts: [{ type: 'text', text: 'ok' }] }
    })

    await validateRosterModels(client, '/workspace', DEFAULT_CONFIG, { validateModels: false })
    expect(calls).toBe(0)
  })
})
