import { describe, expect, test } from 'vitest'
import { BudgetTracker, type AgentUsage, type BudgetConfig } from '../../src/engine/budget.js'

/**
 * `Infinity` is the ONLY way to say "unlimited" — see the fail-closed block below.
 * Every limit must be stated, so tests spell out the ones they do not exercise.
 */
const UNLIMITED: BudgetConfig = {
  maxRunTokens: Infinity,
  maxRoundTokens: Infinity,
  maxAgentTokens: Infinity,
  maxRunUsd: Infinity,
  maxRoundUsd: Infinity,
  maxAgentUsd: Infinity,
}

const cfg = (over: Partial<BudgetConfig> = {}): BudgetConfig => ({ ...UNLIMITED, ...over })

/** $1 per 1000 in-tokens, $2 per 1000 out, $0.10 per 1000 cache-read, $0.20 per 1000 cache-write. */
const PRICED = { m1: { inPerM: 1000, outPerM: 2000, cacheReadPerM: 100, cacheWritePerM: 200 } }

const usage = (over: Partial<AgentUsage> = {}): AgentUsage => ({
  agentId: 'a1',
  modelId: 'm1',
  tokensIn: 0,
  tokensOut: 0,
  tokensCacheRead: 0,
  tokensCacheWrite: 0,
  costUsd: 0,
  ...over,
})

describe('BudgetTracker — behaviours carried over from the plan doc', () => {
  test('accumulates spend', () => {
    const b = new BudgetTracker(cfg({ maxRunUsd: 10, maxRoundUsd: 5, pricing: PRICED }))
    b.record(usage({ tokensIn: 1500 }))
    b.record(usage({ tokensIn: 2000 }))
    expect(b.runSpend).toBeCloseTo(3.5)
  })

  test('reports remaining run budget', () => {
    const b = new BudgetTracker(cfg({ maxRunUsd: 10, maxRoundUsd: 5, pricing: PRICED }))
    b.record(usage({ tokensIn: 4000 }))
    expect(b.remainingRun).toBeCloseTo(6)
  })

  test('is not exceeded below the limits', () => {
    const b = new BudgetTracker(cfg({ maxRunUsd: 10, maxRoundUsd: 5, pricing: PRICED }))
    b.record(usage({ tokensIn: 4000 }))
    expect(b.exceeded()).toBeNull()
  })

  test('detects a round budget breach', () => {
    const b = new BudgetTracker(cfg({ maxRunUsd: 100, maxRoundUsd: 5, pricing: PRICED }))
    b.record(usage({ tokensIn: 6000 }))
    expect(b.exceeded()).toMatch(/round/i)
  })

  test('detects a run budget breach', () => {
    const b = new BudgetTracker(cfg({ maxRunUsd: 5, maxRoundUsd: 100, pricing: PRICED }))
    b.record(usage({ tokensIn: 6000 }))
    expect(b.exceeded()).toMatch(/run/i)
  })

  test('startRound resets round spend but not run spend', () => {
    const b = new BudgetTracker(cfg({ maxRunUsd: 100, maxRoundUsd: 5, pricing: PRICED }))
    b.record(usage({ tokensIn: 4000 }))
    b.startRound()
    expect(b.roundSpend).toBe(0)
    expect(b.runSpend).toBeCloseTo(4)
  })

  test('startRound resets round tokens but not run tokens', () => {
    const b = new BudgetTracker(cfg())
    b.record(usage({ tokensIn: 400 }))
    b.startRound()
    expect(b.roundTokens).toBe(0)
    expect(b.runTokens).toBe(400)
  })
})

describe('BudgetTracker — REPLACES the plan doc\'s fail-open "zero means unlimited" rule', () => {
  test('REPLACED: a zero limit is a configuration error, not unlimited', () => {
    expect(() => new BudgetTracker(cfg({ maxRunUsd: 0, maxRoundUsd: 0 }))).toThrow(/maxRunUsd/)
  })

  test('REPLACED: a negative limit is a configuration error, not unlimited', () => {
    expect(() => new BudgetTracker(cfg({ maxRoundTokens: -1 }))).toThrow(/maxRoundTokens/)
  })
})

describe('BudgetTracker — fails closed on missing or malformed configuration', () => {
  test('fails closed: new BudgetTracker({}) throws rather than defaulting to unlimited', () => {
    expect(() => new BudgetTracker({} as BudgetConfig)).toThrow(/maxRunTokens/)
  })

  test('fails closed: an omitted individual limit throws instead of being inferred', () => {
    const { maxRunUsd: _drop, ...rest } = cfg()
    expect(() => new BudgetTracker(rest as BudgetConfig)).toThrow(/maxRunUsd/)
  })

  test('fails closed: an undefined limit throws (undefined <= 0 is false, so it would slip through)', () => {
    expect(() => new BudgetTracker(cfg({ maxRunUsd: undefined as unknown as number }))).toThrow(
      /maxRunUsd/,
    )
  })

  test('fails closed: a NaN limit throws (every NaN comparison is false, so it would never trip)', () => {
    expect(() => new BudgetTracker(cfg({ maxRunUsd: NaN }))).toThrow(/maxRunUsd/)
  })

  test('fails closed: a non-numeric limit throws', () => {
    expect(() => new BudgetTracker(cfg({ maxRoundUsd: '5' as unknown as number }))).toThrow(
      /maxRoundUsd/,
    )
  })

  test('fails closed: -Infinity throws; only +Infinity means unlimited', () => {
    expect(() => new BudgetTracker(cfg({ maxAgentTokens: -Infinity }))).toThrow(/maxAgentTokens/)
    expect(() => new BudgetTracker(cfg({ maxAgentTokens: Infinity }))).not.toThrow()
  })

  test('fails closed: an unrecognised config key throws, so a typo cannot drop a limit', () => {
    expect(
      () => new BudgetTracker({ ...cfg(), maxRunUSD: 10 } as unknown as BudgetConfig),
    ).toThrow(/maxRunUSD/)
  })

  test('fails closed: a price entry missing cache rates throws rather than pricing cache at zero', () => {
    expect(
      () =>
        new BudgetTracker(
          cfg({ maxRunUsd: 10, pricing: { m1: { inPerM: 1, outPerM: 2 } as never } }),
        ),
    ).toThrow(/cacheReadPerM/)
  })

  test('fails closed: a zero price rate is legal (free cache is a real price, unlike a zero limit)', () => {
    expect(
      () =>
        new BudgetTracker(
          cfg({
            maxRunUsd: 10,
            pricing: { m1: { inPerM: 1, outPerM: 2, cacheReadPerM: 0, cacheWritePerM: 0 } },
          }),
        ),
    ).not.toThrow()
  })

  test('fails closed: record() rejects a NaN token count instead of poisoning every later comparison', () => {
    const b = new BudgetTracker(cfg({ maxRunTokens: 100 }))
    expect(() => b.record(usage({ tokensIn: NaN }))).toThrow(/tokensIn/)
  })

  test('fails closed: record() rejects a negative token count', () => {
    const b = new BudgetTracker(cfg({ maxRunTokens: 100 }))
    expect(() => b.record(usage({ tokensOut: -5 }))).toThrow(/tokensOut/)
  })

  test('fails closed: record() rejects a NaN reported cost', () => {
    const b = new BudgetTracker(cfg({ maxRunUsd: 100, pricing: PRICED }))
    expect(() => b.record(usage({ costUsd: NaN }))).toThrow(/costUsd/)
  })
})

describe('BudgetTracker — tokens are the primary denomination', () => {
  test('tracks tokens even when the provider reports no cost at all', () => {
    const b = new BudgetTracker(cfg())
    b.record(usage({ tokensIn: 500, tokensOut: 25, costUsd: 0 }))
    expect(b.runTokens).toBe(525)
    expect(b.runSpend).toBe(0)
  })

  test('REGRESSION: a USD-only budget never fires on the free-tier default roster, but a token budget does', () => {
    // Mirrors DEFAULT_CONFIG: pricing {} and a provider that reports cost 0.
    const usdOnly = new BudgetTracker(cfg({ maxRunUsd: Infinity, pricing: {} }))
    const tokenLimited = new BudgetTracker(cfg({ maxRunTokens: 20_000, pricing: {} }))
    for (let i = 0; i < 10; i++) {
      const burn = usage({ modelId: 'opencode/big-pickle', tokensIn: 8000, tokensOut: 702, costUsd: 0 })
      usdOnly.record(burn)
      tokenLimited.record(burn)
    }
    expect(usdOnly.runSpend).toBe(0)
    expect(usdOnly.exceeded()).toBeNull()
    expect(tokenLimited.runTokens).toBe(87_020)
    expect(tokenLimited.exceeded()).toMatch(/run token/i)
  })

  test('counts cache-read and cache-write tokens, which dominate real traffic', () => {
    const b = new BudgetTracker(cfg())
    // Measured shape: 8177 of 8702 tokens were cache reads.
    b.record(usage({ tokensIn: 500, tokensOut: 25, tokensCacheRead: 8177, tokensCacheWrite: 0 }))
    expect(b.runTokens).toBe(8702)
  })

  test('detects a run token breach', () => {
    const b = new BudgetTracker(cfg({ maxRunTokens: 1000 }))
    b.record(usage({ tokensIn: 1200 }))
    expect(b.exceeded()).toMatch(/run token/i)
  })

  test('detects a round token breach distinctly from a run token breach', () => {
    const b = new BudgetTracker(cfg({ maxRunTokens: 100_000, maxRoundTokens: 1000 }))
    b.record(usage({ tokensIn: 1200 }))
    expect(b.exceeded()).toMatch(/round token/i)
  })

  test('reports remaining run tokens, and Infinity when uncapped', () => {
    const capped = new BudgetTracker(cfg({ maxRunTokens: 1000 }))
    capped.record(usage({ tokensIn: 400 }))
    expect(capped.remainingRunTokens).toBe(600)
    expect(new BudgetTracker(cfg()).remainingRunTokens).toBe(Infinity)
  })

  test('a limit is breached only when spend goes strictly over it', () => {
    const b = new BudgetTracker(cfg({ maxRunTokens: 1000 }))
    b.record(usage({ tokensIn: 1000 }))
    expect(b.exceeded()).toBeNull()
  })
})

describe('BudgetTracker — a USD limit it cannot compute is unenforceable, not satisfied', () => {
  test('prices cache tokens from the table rather than dropping them', () => {
    const b = new BudgetTracker(cfg({ maxRunUsd: 100, pricing: PRICED }))
    b.record(usage({ tokensIn: 1000, tokensOut: 1000, tokensCacheRead: 10_000, tokensCacheWrite: 5000 }))
    // 1 + 2 + 1 + 1 = 5
    expect(b.runSpend).toBeCloseTo(5)
  })

  test('bills the higher of the table-derived cost and the provider-reported cost', () => {
    const b = new BudgetTracker(cfg({ maxRunUsd: 100, pricing: PRICED }))
    b.record(usage({ tokensIn: 1000, costUsd: 7 }))
    expect(b.runSpend).toBeCloseTo(7)
  })

  test('flags a model with no price entry as unpriced', () => {
    const b = new BudgetTracker(cfg({ maxRunUsd: 10, pricing: PRICED }))
    b.record(usage({ modelId: 'wandb/unknown-model' }))
    expect(b.status().unpricedModels).toEqual(['wandb/unknown-model'])
    expect(b.pricingMissing).toBe(true)
  })

  test('exceeded() refuses to report compliance while a USD limit is unenforceable', () => {
    const b = new BudgetTracker(cfg({ maxRunUsd: 10, pricing: {} }))
    b.record(usage({ modelId: 'opencode/big-pickle', tokensIn: 5 }))
    expect(b.exceeded()).toMatch(/unenforceable/i)
    expect(b.exceeded()).toMatch(/opencode\/big-pickle/)
  })

  test('an unpriced model is harmless when every USD limit is explicitly unlimited', () => {
    const b = new BudgetTracker(cfg({ maxRunTokens: 100_000, pricing: {} }))
    b.record(usage({ modelId: 'opencode/big-pickle', tokensIn: 5 }))
    expect(b.pricingMissing).toBe(false)
    expect(b.exceeded()).toBeNull()
  })

  test('constructor preflight: a declared roster model with no price and a finite USD limit throws', () => {
    expect(
      () =>
        new BudgetTracker(
          cfg({ maxRunUsd: 10, pricing: PRICED, models: ['m1', 'opencode/big-pickle'] }),
        ),
    ).toThrow(/opencode\/big-pickle/)
  })

  test('constructor preflight passes when every declared model is priced', () => {
    expect(
      () => new BudgetTracker(cfg({ maxRunUsd: 10, pricing: PRICED, models: ['m1'] })),
    ).not.toThrow()
  })

  test('a model that appears mid-run through mutation is caught at record time', () => {
    // reflect.allowModelMutation is on, so the roster preflight cannot be the only check.
    const b = new BudgetTracker(cfg({ maxRunUsd: 10, pricing: PRICED, models: ['m1'] }))
    b.record(usage({ modelId: 'm1', tokensIn: 10 }))
    expect(b.exceeded()).toBeNull()
    b.record(usage({ modelId: 'mutated/model', tokensIn: 10 }))
    expect(b.exceeded()).toMatch(/unenforceable/i)
  })
})

describe('BudgetTracker — per-agent cap and the residual overspend bound', () => {
  test('record() returns a breach for an agent that blew its own token cap', () => {
    const b = new BudgetTracker(cfg({ maxAgentTokens: 1000 }))
    const breach = b.record(usage({ agentId: 'runaway', tokensIn: 5000 }))
    expect(breach?.scope).toBe('agent')
    expect(breach?.reason).toMatch(/runaway/)
  })

  test('record() returns null for an agent inside its cap', () => {
    const b = new BudgetTracker(cfg({ maxAgentTokens: 1000 }))
    expect(b.record(usage({ tokensIn: 500 }))).toBeNull()
  })

  test('a per-agent breach is detective only and does not by itself stop the run', () => {
    const b = new BudgetTracker(cfg({ maxAgentTokens: 1000, maxRunTokens: 100_000 }))
    b.record(usage({ agentId: 'runaway', tokensIn: 5000 }))
    expect(b.exceeded()).toBeNull()
    expect(b.shouldStopDispatch()).toBe(false)
    expect(b.status().agentBreaches).toHaveLength(1)
  })

  test('a per-agent USD cap trips on derived cost', () => {
    const b = new BudgetTracker(cfg({ maxAgentUsd: 1, pricing: PRICED }))
    expect(b.record(usage({ tokensIn: 3000 }))?.reason).toMatch(/agent/i)
  })

  test('shouldStopDispatch flips once an aggregate limit trips and stays flipped', () => {
    const b = new BudgetTracker(cfg({ maxRunTokens: 1000 }))
    expect(b.shouldStopDispatch()).toBe(false)
    b.record(usage({ tokensIn: 1200 }))
    expect(b.shouldStopDispatch()).toBe(true)
    b.startRound()
    expect(b.shouldStopDispatch()).toBe(true)
  })

  test('a round breach stops dispatch but clears on the next startRound', () => {
    const b = new BudgetTracker(cfg({ maxRunTokens: 100_000, maxRoundTokens: 1000 }))
    b.record(usage({ tokensIn: 1200 }))
    expect(b.shouldStopDispatch()).toBe(true)
    b.startRound()
    expect(b.shouldStopDispatch()).toBe(false)
  })

  test('worstCaseResidual bounds in-flight overspend by the per-agent cap', () => {
    const b = new BudgetTracker(cfg({ maxAgentTokens: 50_000, maxAgentUsd: 2, pricing: PRICED }))
    const residual = b.worstCaseResidual(8)
    expect(residual.tokens).toBe(400_000)
    expect(residual.usd).toBe(16)
    expect(residual.unbounded).toBe(false)
  })

  test('worstCaseResidual reports unbounded when there is no per-agent cap', () => {
    const b = new BudgetTracker(cfg({ maxRunTokens: 1000 }))
    const residual = b.worstCaseResidual(8)
    expect(residual.tokens).toBe(Infinity)
    expect(residual.unbounded).toBe(true)
  })

  test('worstCaseResidual of zero in-flight agents is zero even with no cap', () => {
    const b = new BudgetTracker(cfg())
    expect(b.worstCaseResidual(0)).toEqual({ tokens: 0, usd: 0, unbounded: false })
  })

  test('status() snapshots everything the driver needs to record a stopped run', () => {
    const b = new BudgetTracker(cfg({ maxRunTokens: 1000, pricing: PRICED }))
    b.record(usage({ tokensIn: 1200 }))
    const s = b.status()
    expect(s).toMatchObject({
      runTokens: 1200,
      roundTokens: 1200,
      remainingRunTokens: 0,
      pricingMissing: false,
    })
    expect(s.breach?.scope).toBe('run')
    expect(s.breach?.kind).toBe('tokens')
  })

  test('remaining never goes negative', () => {
    const b = new BudgetTracker(cfg({ maxRunTokens: 1000, maxRunUsd: 1, pricing: PRICED }))
    b.record(usage({ tokensIn: 5000 }))
    expect(b.remainingRunTokens).toBe(0)
    expect(b.remainingRun).toBe(0)
  })
})

describe('BudgetTracker — concurrency', () => {
  test('record() is synchronous, so interleaved parallel agents sum exactly', async () => {
    const b = new BudgetTracker(cfg())
    await Promise.all(
      Array.from({ length: 200 }, async (_v, i) => {
        await new Promise((r) => setTimeout(r, i % 5))
        b.record(usage({ agentId: `a${i}`, tokensIn: 7, tokensCacheRead: 3 }))
      }),
    )
    expect(b.runTokens).toBe(2000)
  })
})
