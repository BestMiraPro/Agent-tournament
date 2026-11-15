import { describe, expect, test } from 'vitest'
import { validateRosterModels } from '../src/cli.js'
import { DEFAULT_CONFIG, type RunConfig } from '../src/core/types.js'
import type { OpenCodeClient, PromptBody } from '../src/runtime/opencode/client.js'

describe('validateRosterModels with Claude subscription models', () => {
  test('never probes claude-subscription models through OpenCode, so an all-Claude worker roster is not "every worker unusable"', async () => {
    const probed: string[] = []
    const client = {
      createSession: async () => ({ id: 'ses_1' }),
      prompt: async (_s: string, _d: string, body: PromptBody) => {
        probed.push(`${body.model.providerID}/${body.model.modelID}`)
        return body.format
          ? { info: {}, parts: [{ type: 'tool', tool: 'StructuredOutput', state: { input: { ok: 'ok' }, metadata: { valid: true } } }] }
          : { info: {}, parts: [{ type: 'text', text: 'ok' }] }
      },
    } as unknown as OpenCodeClient
    const config: RunConfig = {
      ...DEFAULT_CONFIG,
      roster: [{ modelId: 'claude-subscription/claude-opus-5-5', count: 2, temperature: 0.7 }],
      judge: { ...DEFAULT_CONFIG.judge, modelId: 'claude-subscription/claude-opus-5-5' },
      reflect: { ...DEFAULT_CONFIG.reflect, modelId: 'wandb/deepseek-ai/DeepSeek-V4-Flash' },
    }
    await expect(validateRosterModels(client, '/w', config)).resolves.toBeUndefined()
    expect(probed).toEqual(['wandb/deepseek-ai/DeepSeek-V4-Flash'])
  })
})
