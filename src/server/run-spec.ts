import path from 'node:path'
import { z } from 'zod'
import { DEFAULT_CONFIG } from '../core/types.js'
import { MIN_CONTAINER_MEMORY, MIN_CONTAINER_MEMORY_BYTES, parseMemoryLimit } from '../core/memory.js'

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
    .object({
      crossoverPct: z.number().min(0).max(1),
      eliteCount: z.number().int().min(0),
      topPct: z.number().finite().min(0).max(1),
      bottomPct: z.number().finite().min(0).max(1),
      diversityFloor: z.boolean(),
    })
    .partial()
    .optional(),
  // Upper bound is a typo-guard, not tuning — the provider rate-limits real parallelism anyway.
  concurrency: z.number().int().min(1).max(64).optional(),
  // Container sizing for the docker sandbox; mock and local ignore it. In the spec because
  // the capacity preflight refuses a run by telling the operator to change exactly these,
  // and before they were here nothing created from the dashboard could.
  maxContainers: z.number().int().min(1).max(64).optional(),
  containerMemory: z.string().optional(),
  containerCpus: z.number().positive().max(64).optional(),
  isolation: z.enum(['protected', 'shared']).optional(),
  // Four keys, not two: the engine preflight (BudgetTracker assertPrice) fail-closes
  // on cache-less entries (omitting them prices the bulk of a run at zero), so a
  // 2-key shape would pass the API and die at createRun — accept the full shape here.
  pricing: z.record(z.string().min(1), z.object({ inPerM: z.number().nonnegative(), outPerM: z.number().nonnegative(), cacheReadPerM: z.number().nonnegative(), cacheWritePerM: z.number().nonnegative() })).optional(),
  seedDir: z.string().nullable().default(null),
  workspaceRoot: z.string().nullable().default(null),
  authFile: z.string().nullable().default(null),
  contextDir: z.string().nullable().default(null),
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
  selection: { eliteCount: number; topPct: number; bottomPct: number; crossoverPct: number; diversityFloor?: boolean }
  concurrency: number
  maxContainers: number
  containerMemory: string
  containerCpus: number
  /** Docker placement policy; protected unless a docker spec explicitly chooses shared. */
  isolation: 'protected' | 'shared'
  pricing: Record<string, { inPerM: number; outPerM: number; cacheReadPerM: number; cacheWritePerM: number }>
  seedDir: string | null
  workspaceRoot: string | null
  authFile: string | null
  /** Absolute folder of read-only reference material; existence is checked at composition. */
  contextDir: string | null
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
  if (p.workspaceRoot && !path.isAbsolute(p.workspaceRoot)) {
    throw new Error('workspaceRoot must be an absolute path')
  }
  const contextDir = p.contextDir && p.contextDir.trim() !== '' ? p.contextDir.trim() : null
  if (contextDir && !path.isAbsolute(contextDir)) {
    throw new Error('contextDir must be an absolute path')
  }
  const containerMemory = p.containerMemory ?? DEFAULT_CONFIG.containerMemory
  let containerMemoryBytes: number
  try {
    containerMemoryBytes = parseMemoryLimit(containerMemory)
  } catch {
    throw new Error(`containerMemory must look like 512m or 1g, got "${containerMemory}"`)
  }
  if (containerMemoryBytes < MIN_CONTAINER_MEMORY_BYTES) {
    throw new Error(`containerMemory must be at least ${MIN_CONTAINER_MEMORY}, got "${containerMemory}"`)
  }
  const population = p.roster.reduce((n, r) => n + r.count, 0)
  const maxContainers = p.maxContainers ?? DEFAULT_CONFIG.maxContainers
  // Protected is the docker default: co-tenants in one container can read and change each
  // other's work, so sharing must be chosen, never fallen into because containers ran out.
  const isolation = p.isolation ?? (p.sandbox === 'docker' ? 'protected' : 'shared')
  if (p.sandbox === 'docker' && isolation === 'protected' && maxContainers < population) {
    throw new Error(
      `Protected isolation needs one container per agent: ${population} agents but ${maxContainers} containers. ` +
        `Raise Containers to ${population}, lower the agent count to ${maxContainers}, or choose shared isolation, ` +
        "where agents on one container can read and change each other's files.",
    )
  }
  // Same words as the engine guard (selection.ts): computed from merged spec
  // values so PATCH inherits it free through its merge→parseRunSpec path.
  const eliteCount = p.selection?.eliteCount ?? DEFAULT_CONFIG.selection.eliteCount
  const topPct = p.selection?.topPct ?? DEFAULT_CONFIG.selection.topPct
  const topBand = Math.max(1, Math.floor(population * topPct))
  if (eliteCount > topBand) {
    throw new Error(`eliteCount (${eliteCount}) cannot exceed the top band size (${topBand})`)
  }
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
      eliteCount: p.selection?.eliteCount ?? DEFAULT_CONFIG.selection.eliteCount,
      topPct: p.selection?.topPct ?? DEFAULT_CONFIG.selection.topPct,
      bottomPct: p.selection?.bottomPct ?? DEFAULT_CONFIG.selection.bottomPct,
      crossoverPct: p.selection?.crossoverPct ?? DEFAULT_CONFIG.selection.crossoverPct,
      diversityFloor: p.selection?.diversityFloor ?? DEFAULT_CONFIG.selection.diversityFloor,
    },
    concurrency: p.concurrency ?? DEFAULT_CONFIG.concurrency,
    maxContainers,
    containerMemory,
    containerCpus: p.containerCpus ?? DEFAULT_CONFIG.containerCpus,
    isolation,
    pricing: p.pricing ?? {},
    seedDir: p.seedDir,
    workspaceRoot: p.workspaceRoot,
    authFile: p.authFile,
    contextDir,
    serverUrl: p.serverUrl,
    criteria: p.criteria,
  }
}
