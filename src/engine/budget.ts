/**
 * Container limits protect the machine; this protects the wallet. Agents are selected on
 * outcome, so any strategy that raises rank is selected FOR — including burning tokens.
 *
 * Two things shape this design, both learned from the code rather than assumed:
 *
 * 1. **Tokens are the primary denomination, not dollars.** `RunConfig.pricing` is declared
 *    but read nowhere, so the only source of USD is the provider's own `res.info?.cost`,
 *    which is 0 or absent across the free-tier default roster. A USD-only budget therefore
 *    stays at 0 forever and never trips, no matter how much is burned. `res.info.tokens` is
 *    always present, so tokens are what can actually be enforced. USD is a SECONDARY limit
 *    that applies only where pricing is genuinely known.
 *
 * 2. **Absent or malformed configuration fails CLOSED.** The obvious `if (limit <= 0) return
 *    null` idiom treats `undefined` as a real limit (`undefined <= 0` is false) and then
 *    compares against it (`spend > undefined` is NaN-false, always), so a missing limit reads
 *    as unlimited. Every limit must be stated as a finite positive number or the explicit
 *    `Infinity` sentinel; anything else throws at construction, the same way the host-capacity
 *    preflight refuses an overcommitted run rather than proceeding hopefully.
 */

export type BudgetScope = 'agent' | 'round' | 'run'
export type BudgetKind = 'tokens' | 'usd' | 'pricing'

export interface BudgetBreach {
  scope: BudgetScope
  kind: BudgetKind
  reason: string
}

/**
 * Per-million-token rates. Cache rates are REQUIRED, not optional: cache reads dominate real
 * traffic (a measured call was 8177 of 8702 tokens), so a table that omits them would price
 * the bulk of a run at zero and under-report spend by an order of magnitude. `0` is a legal
 * rate — free cache is a real price — which is why prices allow zero where limits do not.
 */
export interface ModelPrice {
  inPerM: number
  outPerM: number
  cacheReadPerM: number
  cacheWritePerM: number
}

export interface BudgetLimits {
  maxRunTokens: number
  maxRoundTokens: number
  maxAgentTokens: number
  maxRunUsd: number
  maxRoundUsd: number
  maxAgentUsd: number
}

export interface BudgetConfig extends BudgetLimits {
  pricing?: Record<string, ModelPrice>
  /**
   * Model ids the run intends to use. Supplying them turns the pricing check into a
   * construction-time preflight. It cannot be the only check — `reflect.allowModelMutation`
   * lets breeding introduce model ids that did not exist when the run started — so `record`
   * re-checks whatever actually shows up.
   */
  models?: readonly string[]
}

/** One completed agent run. Cost is only observable after the fact; see `worstCaseResidual`. */
export interface AgentUsage {
  agentId: string
  modelId: string
  tokensIn: number
  tokensOut: number
  tokensCacheRead: number
  tokensCacheWrite: number
  /** Provider-reported cost. Frequently 0 or absent, which is exactly the problem. */
  costUsd: number
}

export interface ResidualBound {
  tokens: number
  usd: number
  unbounded: boolean
}

export interface BudgetStatus {
  runTokens: number
  roundTokens: number
  runSpend: number
  roundSpend: number
  remainingRunTokens: number
  remainingRoundTokens: number
  remainingRun: number
  remainingRound: number
  agentBreaches: readonly BudgetBreach[]
  unpricedModels: readonly string[]
  pricingMissing: boolean
  breach: BudgetBreach | null
}

const LIMIT_KEYS = [
  'maxRunTokens',
  'maxRoundTokens',
  'maxAgentTokens',
  'maxRunUsd',
  'maxRoundUsd',
  'maxAgentUsd',
] as const

const CONFIG_KEYS: readonly string[] = [...LIMIT_KEYS, 'pricing', 'models']

const PRICE_KEYS = ['inPerM', 'outPerM', 'cacheReadPerM', 'cacheWritePerM'] as const

/** A limit is a finite positive number, or `Infinity` meaning deliberately unlimited. */
function assertLimit(name: string, value: unknown): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new Error(
      `Budget limit ${name} must be a positive number or Infinity for unlimited, got ${String(value)}. ` +
        `Unlimited is never inferred from a missing or malformed value.`,
    )
  }
  if (value === Infinity) return value
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      `Budget limit ${name} must be a positive number or Infinity for unlimited, got ${String(value)}. ` +
        `Zero and negative limits are configuration errors, not a way to say unlimited.`,
    )
  }
  return value
}

/** A recorded quantity is a finite number at or above zero. NaN here would silently disable every later comparison. */
function assertQuantity(name: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`Usage field ${name} must be a finite number >= 0, got ${String(value)}`)
  }
  return value
}

function assertPrice(modelId: string, price: unknown): ModelPrice {
  if (typeof price !== 'object' || price === null) {
    throw new Error(`Pricing entry for "${modelId}" must be an object, got ${String(price)}`)
  }
  const rec = price as Record<string, unknown>
  for (const key of PRICE_KEYS) {
    const v = rec[key]
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      throw new Error(
        `Pricing entry for "${modelId}" needs ${key} as a finite rate >= 0, got ${String(v)}. ` +
          `Cache rates are required: omitting them prices the bulk of a run at zero.`,
      )
    }
  }
  return {
    inPerM: rec.inPerM as number,
    outPerM: rec.outPerM as number,
    cacheReadPerM: rec.cacheReadPerM as number,
    cacheWritePerM: rec.cacheWritePerM as number,
  }
}

const money = (n: number): string => `$${n.toFixed(4)}`

/** Tracks spend so a runaway tournament stops rather than billing without bound. */
export class BudgetTracker {
  private readonly limits: BudgetLimits
  private readonly pricing: Record<string, ModelPrice>

  private _runTokens = 0
  private _roundTokens = 0
  private _runSpend = 0
  private _roundSpend = 0

  private readonly _agentBreaches: BudgetBreach[] = []
  private readonly _unpriced = new Set<string>()
  /** A run breach is terminal; a round breach clears at the next `startRound`. */
  private _runBreached: BudgetBreach | null = null

  constructor(config: BudgetConfig) {
    if (typeof config !== 'object' || config === null) {
      throw new Error(`BudgetTracker requires a configuration object, got ${String(config)}`)
    }
    // A typo'd key would otherwise leave the real limit missing, and "missing" must never be
    // reachable — so an unknown key is an error rather than something quietly ignored.
    for (const key of Object.keys(config)) {
      if (!CONFIG_KEYS.includes(key)) {
        throw new Error(
          `Unrecognised budget config key "${key}". Expected one of: ${CONFIG_KEYS.join(', ')}`,
        )
      }
    }

    const limits = {} as BudgetLimits
    for (const key of LIMIT_KEYS) {
      // `BudgetConfig` has no index signature, so tsc refuses the direct cast to
      // `Record<string, unknown>` as an insufficient-overlap error (TS2352) — go
      // through `unknown` first, exactly as the compiler suggests. No runtime effect;
      // a type assertion is erased at compile time either way.
      limits[key] = assertLimit(key, (config as unknown as Record<string, unknown>)[key])
    }
    this.limits = limits

    const pricing: Record<string, ModelPrice> = {}
    for (const [modelId, price] of Object.entries(config.pricing ?? {})) {
      pricing[modelId] = assertPrice(modelId, price)
    }
    this.pricing = pricing

    // Preflight: refuse a run whose stated dollar ceiling could not be computed for a model
    // it already knows it will use, rather than discovering that only once money is spent.
    if (this.hasUsdLimit && config.models) {
      const missing = config.models.filter((m) => !(m in pricing))
      if (missing.length > 0) {
        throw new Error(
          `A USD budget was set but ${missing.length} roster model(s) have no pricing entry: ` +
            `${missing.join(', ')}. Add pricing for them, or set the USD limits to Infinity and ` +
            `budget in tokens instead.`,
        )
      }
    }
  }

  private get hasUsdLimit(): boolean {
    return (
      this.limits.maxRunUsd !== Infinity ||
      this.limits.maxRoundUsd !== Infinity ||
      this.limits.maxAgentUsd !== Infinity
    )
  }

  get runTokens(): number { return this._runTokens }
  get roundTokens(): number { return this._roundTokens }
  /** USD, matching the original spec's meaning of `runSpend`. */
  get runSpend(): number { return this._runSpend }
  get roundSpend(): number { return this._roundSpend }

  get remainingRun(): number { return Math.max(0, this.limits.maxRunUsd - this._runSpend) }
  get remainingRound(): number { return Math.max(0, this.limits.maxRoundUsd - this._roundSpend) }
  get remainingRunTokens(): number {
    return Math.max(0, this.limits.maxRunTokens - this._runTokens)
  }
  get remainingRoundTokens(): number {
    return Math.max(0, this.limits.maxRoundTokens - this._roundTokens)
  }

  /** True when a USD limit is set that this tracker cannot actually compute. */
  get pricingMissing(): boolean {
    return this.hasUsdLimit && this._unpriced.size > 0
  }

  /**
   * Fold in one completed agent run and return that agent's OWN cap breach, if any.
   *
   * Deliberately synchronous with no `await` anywhere inside: that is what makes it atomic
   * against the concurrent agents in `runPool`. See the class notes on the residual bound for
   * the race that remains, which is a stale-read problem rather than a torn-state one.
   */
  record(usage: AgentUsage): BudgetBreach | null {
    const tokensIn = assertQuantity('tokensIn', usage.tokensIn)
    const tokensOut = assertQuantity('tokensOut', usage.tokensOut)
    const tokensCacheRead = assertQuantity('tokensCacheRead', usage.tokensCacheRead)
    const tokensCacheWrite = assertQuantity('tokensCacheWrite', usage.tokensCacheWrite)
    const reported = assertQuantity('costUsd', usage.costUsd)

    const tokens = tokensIn + tokensOut + tokensCacheRead + tokensCacheWrite

    const price = this.pricing[usage.modelId]
    if (!price) this._unpriced.add(usage.modelId)
    // Bill the higher of the two: the table prices cache tokens the provider's own figure may
    // not, and a provider figure above the table is real money already committed.
    const derived = price
      ? (tokensIn * price.inPerM +
          tokensOut * price.outPerM +
          tokensCacheRead * price.cacheReadPerM +
          tokensCacheWrite * price.cacheWritePerM) /
        1_000_000
      : 0
    const usd = Math.max(derived, reported)

    this._runTokens += tokens
    this._roundTokens += tokens
    this._runSpend += usd
    this._roundSpend += usd

    if (this._runBreached === null) {
      const runBreach = this.checkRun()
      if (runBreach) this._runBreached = runBreach
    }

    const agentBreach = this.checkAgent(usage.agentId, tokens, usd)
    if (agentBreach) this._agentBreaches.push(agentBreach)
    return agentBreach
  }

  /** Clears the round counters. Run totals and any run-level breach deliberately survive. */
  startRound(): void {
    this._roundTokens = 0
    this._roundSpend = 0
  }

  /** The structured form of `exceeded()`. */
  check(): BudgetBreach | null {
    // Checked first: while a USD limit cannot be computed, every dollar figure below is a
    // lower bound, so reporting compliance from them would be a lie rather than a reading.
    if (this.pricingMissing) {
      return {
        scope: 'run',
        kind: 'pricing',
        reason:
          `USD budget is unenforceable: no pricing for ${[...this._unpriced]
            .map((m) => `"${m}"`)
            .join(', ')}. ` +
          `Add pricing for those models, or set the USD limits to Infinity and budget in tokens.`,
      }
    }
    return this._runBreached ?? this.checkRun() ?? this.checkRound()
  }

  /** Null when within budget, otherwise a human-readable reason. */
  exceeded(): string | null {
    return this.check()?.reason ?? null
  }

  /**
   * The dispatch gate for phase B: stop starting NEW agents, let in-flight ones drain, then
   * score what completed. Aborting mid-round would leave an unscorable partial generation.
   */
  shouldStopDispatch(): boolean {
    return this.check() !== null
  }

  /**
   * What could still land after `shouldStopDispatch` turns true.
   *
   * Spend is only observable once a full agent run returns — the agentic loop runs server-side
   * inside the container behind one blocking `client.prompt()` — so enforcement granularity is
   * per-agent-run, and `agentTimeoutMs` bounds time, not spend. The per-agent cap is therefore
   * DETECTIVE, not preventive: it cannot stop an agent mid-flight, but it is what makes this
   * bound finite and names the offender afterwards. With no per-agent cap the honest answer is
   * "unbounded", and the caller should be told that rather than left to assume otherwise.
   */
  worstCaseResidual(inFlight: number): ResidualBound {
    const n = assertQuantity('inFlight', inFlight)
    if (n === 0) return { tokens: 0, usd: 0, unbounded: false }
    const tokens = this.limits.maxAgentTokens * n
    const usd = this.limits.maxAgentUsd * n
    return {
      tokens,
      usd,
      unbounded: tokens === Infinity || (this.hasUsdLimit && usd === Infinity),
    }
  }

  status(): BudgetStatus {
    return {
      runTokens: this._runTokens,
      roundTokens: this._roundTokens,
      runSpend: this._runSpend,
      roundSpend: this._roundSpend,
      remainingRunTokens: this.remainingRunTokens,
      remainingRoundTokens: this.remainingRoundTokens,
      remainingRun: this.remainingRun,
      remainingRound: this.remainingRound,
      agentBreaches: [...this._agentBreaches],
      unpricedModels: [...this._unpriced],
      pricingMissing: this.pricingMissing,
      breach: this.check(),
    }
  }

  private checkRun(): BudgetBreach | null {
    if (this._runTokens > this.limits.maxRunTokens) {
      return {
        scope: 'run',
        kind: 'tokens',
        reason: `run token budget exceeded: ${this._runTokens} tokens against a limit of ${this.limits.maxRunTokens}`,
      }
    }
    if (this._runSpend > this.limits.maxRunUsd) {
      return {
        scope: 'run',
        kind: 'usd',
        reason: `run USD budget exceeded: ${money(this._runSpend)} against a limit of ${money(this.limits.maxRunUsd)}`,
      }
    }
    return null
  }

  private checkRound(): BudgetBreach | null {
    if (this._roundTokens > this.limits.maxRoundTokens) {
      return {
        scope: 'round',
        kind: 'tokens',
        reason: `round token budget exceeded: ${this._roundTokens} tokens against a limit of ${this.limits.maxRoundTokens}`,
      }
    }
    if (this._roundSpend > this.limits.maxRoundUsd) {
      return {
        scope: 'round',
        kind: 'usd',
        reason: `round USD budget exceeded: ${money(this._roundSpend)} against a limit of ${money(this.limits.maxRoundUsd)}`,
      }
    }
    return null
  }

  private checkAgent(agentId: string, tokens: number, usd: number): BudgetBreach | null {
    if (tokens > this.limits.maxAgentTokens) {
      return {
        scope: 'agent',
        kind: 'tokens',
        reason: `agent token budget exceeded: agent ${agentId} used ${tokens} tokens against a per-agent limit of ${this.limits.maxAgentTokens}`,
      }
    }
    if (usd > this.limits.maxAgentUsd) {
      return {
        scope: 'agent',
        kind: 'usd',
        reason: `agent USD budget exceeded: agent ${agentId} spent ${money(usd)} against a per-agent limit of ${money(this.limits.maxAgentUsd)}`,
      }
    }
    return null
  }
}
