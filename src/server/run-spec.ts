import { z } from 'zod'
import { DEFAULT_CONFIG } from '../core/types.js'

const rosterEntry = z.object({
  modelId: z.string().min(1),
  count: z.number().int().min(1),
  temperature: z.number().min(0).max(2),
})

const schema = z.object({
  name: z.string().min(1),
  goal: z.string().min(1),
  sandbox: z.enum(['mock', 'local', 'docker']).default('mock'),
  roster: z.array(rosterEntry).min(1),
  judge: z
    .object({
      modelId: z.string().min(1),
      mode: z.enum(['auto', 'single_call', 'batched_finals']).default('auto'),
    })
    .partial()
    .default({}),
  reflect: z
    .object({ modelId: z.string().min(1), topK: z.number().int().min(1) })
    .partial()
    .default({}),
  budget: z
    .object({
      maxRunTokens: z.number().int().positive(),
      maxRoundTokens: z.number().int().positive(),
      maxAgentTokens: z.number().int().positive(),
    })
    .partial()
    .default({}),
  selection: z
    .object({ crossoverPct: z.number().min(0).max(1) })
    .partial()
    .optional(),
  seedDir: z.string().nullable().default(null),
  workspaceRoot: z.string().nullable().default(null),
  authFile: z.string().nullable().default(null),
  serverUrl: z.string().nullable().default(null),
  criteria: z.string().nullable().default(null),
})

export type RunSpecInput = z.input<typeof schema>

export interface RunSpec {
  name: string
  goal: string
  sandbox: 'mock' | 'local' | 'docker'
  roster: { modelId: string; count: number; temperature: number }[]
  population: number
  judge: { modelId: string; mode: 'auto' | 'single_call' | 'batched_finals' }
  reflect: { modelId: string; topK: number }
  budget: { maxRunTokens: number; maxRoundTokens: number; maxAgentTokens: number }
  selection: { crossoverPct: number }
  seedDir: string | null
  workspaceRoot: string | null
  authFile: string | null
  serverUrl: string | null
  criteria: string | null
}

/**
 * Parse and cross-validate a run-spec. Field shapes come from Zod;
 * cross-field rules live here so both the API and the web client share them.
 * Docker refuses without workspaceRoot AND authFile: containers without
 * credentials fail every agent on its first model call, so accepting the
 * spec would burn setup time for a run that cannot score. (The CLI only
 * warns here; the server refuses — spending through an API needs the guard.)
 */
export function parseRunSpec(input: unknown): RunSpec {
  const p = schema.parse(input)
  if (p.sandbox === 'docker' && !p.workspaceRoot) {
    throw new Error('docker sandbox requires workspaceRoot')
  }
  if (p.sandbox === 'docker' && !p.authFile) {
    throw new Error('docker sandbox requires authFile')
  }
  if (p.sandbox === 'local' && !p.workspaceRoot) {
    throw new Error('local sandbox requires workspaceRoot')
  }
  const population = p.roster.reduce((n, r) => n + r.count, 0)
  return {
    name: p.name,
    goal: p.goal,
    sandbox: p.sandbox,
    roster: p.roster,
    population,
    judge: {
      modelId: p.judge.modelId ?? DEFAULT_CONFIG.judge.modelId,
      mode: p.judge.mode ?? 'auto',
    },
    reflect: {
      modelId: p.reflect.modelId ?? DEFAULT_CONFIG.reflect.modelId,
      topK: p.reflect.topK ?? DEFAULT_CONFIG.reflect.topK,
    },
    budget: {
      maxRunTokens: p.budget.maxRunTokens ?? DEFAULT_CONFIG.budget.maxRunTokens,
      maxRoundTokens: p.budget.maxRoundTokens ?? DEFAULT_CONFIG.budget.maxRoundTokens,
      maxAgentTokens: p.budget.maxAgentTokens ?? DEFAULT_CONFIG.budget.maxAgentTokens,
    },
    selection: {
      crossoverPct: p.selection?.crossoverPct ?? DEFAULT_CONFIG.selection.crossoverPct,
    },
    seedDir: p.seedDir,
    workspaceRoot: p.workspaceRoot,
    authFile: p.authFile,
    serverUrl: p.serverUrl,
    criteria: p.criteria,
  }
}
