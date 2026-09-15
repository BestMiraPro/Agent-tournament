import { describe, expect, test } from 'vitest'
import { FALLBACK_CRITERIA_MD, Judge } from '../../src/judge/judge.js'
import { MockProvider } from '../../src/runtime/mock-provider.js'
import { DEFAULT_CONFIG } from '../../src/core/types.js'
import type { Provider } from '../../src/runtime/provider.js'

const cfg = DEFAULT_CONFIG.judge
const judge = () => new Judge(new MockProvider(1), cfg, 42)

const sub = (agentId: string, fitness: number, status: 'ok' | 'error' = 'ok') => ({
  agentId,
  submissionMd: `work product FITNESS=${fitness}`,
  files: [],
  status,
})

/** Stub provider that returns a fixed judge response regardless of prompt. */
const stubJudge = (rankings: { ref: string; rank: number; score: number; rationale: string }[]): Provider => ({
  async complete() {
    return JSON.stringify({ rankings, meta_digest: 'digest' })
  },
})

describe('Judge.resolveCriteria', () => {
  test('uses user criteria verbatim when supplied', async () => {
    const r = await judge().resolveCriteria('goal', 'my criteria')
    expect(r).toEqual({ criteriaMd: 'my criteria', source: 'user' })
  })

  test('generates criteria when none are supplied', async () => {
    const r = await judge().resolveCriteria('goal', null)
    expect(r.source).toBe('generated')
    expect(r.criteriaMd).toContain('correctness')
  })

  test('user criteria short-circuits before the provider is ever called', async () => {
    const provider: Provider = {
      async complete() {
        throw new Error('provider must not be called when user criteria are supplied')
      },
    }
    const r = await new Judge(provider, cfg, 42).resolveCriteria('goal', 'my criteria')
    expect(r).toEqual({ criteriaMd: 'my criteria', source: 'user' })
  })

  test('falls back to default criteria when generation fails after retries, and warns', async () => {
    let calls = 0
    const provider: Provider = {
      async complete() {
        calls++
        throw new Error('StructuredOutputError Model did not produce structured output')
      },
    }
    const warnings: string[] = []
    const j = new Judge(provider, cfg, 42, (message) => warnings.push(message))
    const r = await j.resolveCriteria('goal', null)

    expect(r.source).toBe('generated')
    expect(r.criteriaMd).toBe(FALLBACK_CRITERIA_MD)
    expect(warnings.length).toBe(1)
    // withRetry attempts 3 times; each attempt's parseWithRepair may add a repair
    // call on a parse failure, but here the provider always throws before parsing,
    // so exactly 3 calls are made in total.
    expect(calls).toBe(3)
  })

  test('recovers on a later attempt without falling back or warning', async () => {
    let calls = 0
    const provider: Provider = {
      async complete(req) {
        calls++
        if (calls < 3) throw new Error('transient')
        return new MockProvider(1).complete(req)
      },
    }
    const warnings: string[] = []
    const j = new Judge(provider, cfg, 42, (message) => warnings.push(message))
    const r = await j.resolveCriteria('goal', null)

    expect(r.source).toBe('generated')
    expect(r.criteriaMd).toContain('correctness')
    expect(r.criteriaMd).not.toBe(FALLBACK_CRITERIA_MD)
    expect(warnings).toEqual([])
  })
})

describe('Judge.score', () => {
  test('ranks higher-fitness submissions first', async () => {
    const res = await judge().score('goal', 'criteria', [sub('a', 10), sub('b', 90)])
    expect(res.scores[0]!.agentId).toBe('b')
    expect(res.scores[0]!.rank).toBe(1)
  })

  test('assigns contiguous ranks starting at 1', async () => {
    const res = await judge().score('goal', 'criteria', [sub('a', 10), sub('b', 90), sub('c', 50)])
    expect(res.scores.map((s) => s.rank)).toEqual([1, 2, 3])
  })

  test('excludes failed submissions from judging and ranks them last with score 0', async () => {
    const res = await judge().score('goal', 'criteria', [
      sub('a', 90), sub('bad', 0, 'error'), sub('b', 50),
    ])
    const failed = res.scores.find((s) => s.agentId === 'bad')!
    expect(failed.score).toBe(0)
    expect(failed.rank).toBe(3)
  })

  test('returns a meta digest', async () => {
    const res = await judge().score('goal', 'criteria', [sub('a', 10), sub('b', 90)])
    expect(res.metaDigest.length).toBeGreaterThan(0)
  })

  test('all-failed population produces zero scores without calling the model', async () => {
    const res = await judge().score('goal', 'criteria', [sub('a', 0, 'error'), sub('b', 0, 'error')])
    expect(res.scores.every((s) => s.score === 0)).toBe(true)
    expect(res.scores).toHaveLength(2)
  })

  test('selects batched mode above the single-call population threshold', async () => {
    const many = Array.from({ length: 30 }, (_, i) => sub(`a${i}`, i))
    const res = await judge().score('goal', 'criteria', many)
    expect(res.mode).toBe('batched_finals')
    expect(res.scores).toHaveLength(30)
    expect(new Set(res.scores.map((s) => s.rank)).size).toBe(30)
  })

  test('uses single-call mode at or below the threshold', async () => {
    const res = await judge().score('goal', 'criteria', [sub('a', 10), sub('b', 90)])
    expect(res.mode).toBe('single_call')
  })
})

describe('Judge.score — hardening against malformed judge rankings', () => {
  // anonymize: false makes ref assignment order-stable (S1 -> inputs[0], S2 -> inputs[1], ...)
  // so tests can address specific refs deterministically without depending on rng.shuffle.
  const unanon = { ...cfg, anonymize: false }
  const inputs = [sub('a', 90), sub('b', 50), sub('c', 10)]

  test('judge omitting a ref: that agent is appended at the bottom with score 0, never dropped', async () => {
    const provider = stubJudge([
      { ref: 'S1', rank: 1, score: 90, rationale: 'great' },
      // S2 (agent b) is never mentioned by the judge.
      { ref: 'S3', rank: 2, score: 40, rationale: 'ok' },
    ])
    const res = await new Judge(provider, unanon, 42).score('goal', 'criteria', inputs)

    expect(res.scores.map((s) => s.agentId).sort()).toEqual(['a', 'b', 'c'])
    expect(res.scores.map((s) => s.rank).sort((x, y) => x - y)).toEqual([1, 2, 3])
    expect(new Set(res.scores.map((s) => s.rank)).size).toBe(3)

    const omitted = res.scores.find((s) => s.agentId === 'b')!
    expect(omitted.score).toBe(0)
    expect(omitted.rank).toBe(3)
    expect(omitted.rationaleMd).toContain('no ranking')
  })

  test('judge duplicating a ref: that agent is scored once, not twice', async () => {
    const provider = stubJudge([
      { ref: 'S1', rank: 1, score: 90, rationale: 'first mention, kept' },
      { ref: 'S1', rank: 2, score: 10, rationale: 'duplicate, discarded' },
      { ref: 'S2', rank: 3, score: 40, rationale: 'ok' },
      { ref: 'S3', rank: 4, score: 20, rationale: 'meh' },
    ])
    const res = await new Judge(provider, unanon, 42).score('goal', 'criteria', inputs)

    expect(res.scores).toHaveLength(3)
    expect(new Set(res.scores.map((s) => s.agentId)).size).toBe(3)
    expect(res.scores.map((s) => s.rank).sort((x, y) => x - y)).toEqual([1, 2, 3])

    const a = res.scores.find((s) => s.agentId === 'a')!
    expect(a.score).toBe(90)
    expect(a.rationaleMd).toContain('first mention')
  })

  test('judge returning a ref never shown: it is ignored, not inserted as a phantom agent', async () => {
    const provider = stubJudge([
      { ref: 'S1', rank: 1, score: 90, rationale: 'great' },
      { ref: 'S99', rank: 2, score: 99, rationale: 'phantom — never shown to the judge' },
      { ref: 'S2', rank: 3, score: 40, rationale: 'ok' },
      { ref: 'S3', rank: 4, score: 20, rationale: 'meh' },
    ])
    const res = await new Judge(provider, unanon, 42).score('goal', 'criteria', inputs)

    expect(res.scores).toHaveLength(3)
    expect(res.scores.map((s) => s.agentId).sort()).toEqual(['a', 'b', 'c'])
    expect(res.scores.map((s) => s.rank).sort((x, y) => x - y)).toEqual([1, 2, 3])
  })

  test('postcondition: output agentId set always equals input agentId set, with ranks 1..N exactly once', async () => {
    // Combine all three malformations in a single malformed response.
    const provider = stubJudge([
      { ref: 'S1', rank: 1, score: 90, rationale: 'first' },
      { ref: 'S1', rank: 5, score: 5, rationale: 'dup' },
      { ref: 'S404', rank: 2, score: 77, rationale: 'phantom' },
      // S2 and S3 both omitted.
    ])
    const res = await new Judge(provider, unanon, 42).score('goal', 'criteria', inputs)

    const inputIds = new Set(inputs.map((i) => i.agentId))
    const outputIds = new Set(res.scores.map((s) => s.agentId))
    expect(outputIds).toEqual(inputIds)

    const ranks = res.scores.map((s) => s.rank).sort((x, y) => x - y)
    expect(ranks).toEqual(Array.from({ length: inputs.length }, (_, i) => i + 1))
  })
})

describe('Judge resilience', () => {
  const subs = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      agentId: `a${i}`, submissionMd: `work FITNESS=${i * 5}`, files: [], status: 'ok' as const,
    }))

  test('falls back to batched mode when the single call throws', async () => {
    let calls = 0
    const provider = {
      complete: async (req: { prompt: string }) => {
        calls++
        // The single-call prompt contains every submission; batches contain few.
        const count = (req.prompt.match(/<submission ref=/g) ?? []).length
        if (count > 5) throw new Error('context overflow')
        return new MockProvider(1).complete({ purpose: 'judge', prompt: req.prompt, modelId: 'm' })
      },
    }
    const j = new Judge(provider as never, { ...cfg, mode: 'auto' }, 42)
    const res = await j.score('goal', 'criteria', subs(10))
    expect(res.mode).toBe('batched_finals')
    expect(res.scores).toHaveLength(10)
    expect(calls).toBeGreaterThan(1)
  })

  test('retries the single call before falling back', async () => {
    let attempts = 0
    const provider = {
      complete: async (req: { prompt: string }) => {
        attempts++
        if (attempts === 1) throw new Error('transient')
        return new MockProvider(1).complete({ purpose: 'judge', prompt: req.prompt, modelId: 'm' })
      },
    }
    const j = new Judge(provider as never, cfg, 42)
    const res = await j.score('goal', 'criteria', subs(3))
    expect(res.mode).toBe('single_call')
    expect(attempts).toBeGreaterThanOrEqual(2)
  })

  test('a grading context reaches both the criteria and the scoring prompts', async () => {
    const prompts: { purpose: string; prompt: string }[] = []
    const provider: Provider = {
      complete: async (req) => {
        prompts.push({ purpose: req.purpose, prompt: req.prompt })
        return new MockProvider(1).complete(req)
      },
    }
    const j = new Judge(provider, cfg, 42, undefined, { contextPath: '/ctx' })
    const { criteriaMd } = await j.resolveCriteria('goal', null)
    await j.score('goal', criteriaMd, subs(3), 1)
    expect(prompts.map((p) => p.purpose)).toEqual(expect.arrayContaining(['criteria', 'judge']))
    for (const p of prompts) expect(p.prompt).toContain('Reference material (read-only) is in /ctx')
  })

  test('different rounds produce different anonymization orders', async () => {
    const prompts: string[] = []
    const provider = {
      complete: async (req: { prompt: string }) => {
        prompts.push(req.prompt)
        return new MockProvider(1).complete({ purpose: 'judge', prompt: req.prompt, modelId: 'm' })
      },
    }
    const j = new Judge(provider as never, cfg, 42)
    await j.score('goal', 'criteria', subs(5), 1)
    await j.score('goal', 'criteria', subs(5), 2)
    expect(prompts[0]).not.toBe(prompts[1])
  })

  test('the same round index reproduces the same order', async () => {
    const prompts: string[] = []
    const provider = {
      complete: async (req: { prompt: string }) => {
        prompts.push(req.prompt)
        return new MockProvider(1).complete({ purpose: 'judge', prompt: req.prompt, modelId: 'm' })
      },
    }
    const j = new Judge(provider as never, cfg, 42)
    await j.score('goal', 'criteria', subs(5), 3)
    const j2 = new Judge(provider as never, cfg, 42)
    await j2.score('goal', 'criteria', subs(5), 3)
    expect(prompts[0]).toBe(prompts[1])
  })
})

describe('Judge.score — batched mode preserves rationales and finals digest', () => {
  /**
   * Stub provider for the batched-mode rationale/digest defect. Extracts the
   * agentId embedded in each submission body (`AGENT=<id>`) and returns a
   * rationale keyed to that agentId, plus a meta_digest keyed to call order,
   * so the test can assert exactly whose rationale survived and which call's
   * digest survived — without depending on rng.shuffle's actual batch/ref
   * assignment (batching and anonymization both reorder inputs).
   */
  const distinctiveJudge = (digests: string[]): Provider => ({
    async complete(req) {
      const re = /<submission ref="([^"]+)">([\s\S]*?)<\/submission>/g
      const items: { ref: string; agentId: string; fitness: number }[] = []
      for (const m of req.prompt.matchAll(re)) {
        const body = m[2] ?? ''
        items.push({
          ref: m[1]!,
          agentId: /AGENT=(\S+)/.exec(body)?.[1] ?? 'unknown',
          fitness: Number(/FITNESS=([\d.]+)/.exec(body)?.[1] ?? '0'),
        })
      }
      items.sort((a, b) => b.fitness - a.fitness)
      const digest = `digest-call-${digests.length + 1}`
      digests.push(digest)
      return JSON.stringify({
        rankings: items.map((it, i) => ({
          ref: it.ref,
          rank: i + 1,
          score: 100 - i,
          rationale: `distinctive-rationale-for-${it.agentId}`,
        })),
        meta_digest: digest,
      })
    },
  })

  const markedPopulation = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      agentId: `agent-${i}`,
      submissionMd: `work product FITNESS=${i} AGENT=agent-${i}`,
      files: [],
      status: 'ok' as const,
    }))

  test('surfaces the real per-agent rationale, not a synthesized placement string', async () => {
    const digests: string[] = []
    const res = await new Judge(distinctiveJudge(digests), cfg, 42)
      .score('goal', 'criteria', markedPopulation(30))

    expect(res.mode).toBe('batched_finals')
    expect(res.scores).toHaveLength(30)
    for (const s of res.scores) {
      expect(s.rationaleMd).toBe(`distinctive-rationale-for-${s.agentId}`)
      expect(s.rationaleMd).not.toMatch(/^Placed \d+ of \d+/)
    }
  })

  test('meta digest is non-empty and comes from the finals call, not the first batch', async () => {
    const digests: string[] = []
    const res = await new Judge(distinctiveJudge(digests), cfg, 42)
      .score('goal', 'criteria', markedPopulation(30))

    // 6 batches (population 30 / batchSize 5) plus one finals call among the
    // 6 batch winners.
    expect(digests.length).toBe(7)
    expect(res.metaDigest.length).toBeGreaterThan(0)
    expect(res.metaDigest).toBe(digests[digests.length - 1])
    expect(res.metaDigest).not.toBe(digests[0])
  })
})

describe('Judge.score — batched mode never rewards unjudged submissions', () => {
  /**
   * Parses the refs out of a prompt so a stub can answer a real batch, then lets the
   * test corrupt that answer the way a model does: dropping a ref, repeating one,
   * inventing one, or numbering ranks from something other than 1.
   */
  const refsIn = (prompt: string): { ref: string; agentId: string }[] => {
    const re = /<submission ref="([^"]+)">([\s\S]*?)<\/submission>/g
    return [...prompt.matchAll(re)].map((m) => ({
      ref: m[1]!,
      agentId: /AGENT=(\S+)/.exec(m[2] ?? '')?.[1] ?? 'unknown',
    }))
  }

  const rank = (ref: string, i: number) => ({
    ref, rank: i + 1, score: 100 - i, rationale: `rationale-for-${ref}`,
  })

  const corruptingJudge = (
    corrupt: (entries: { ref: string; agentId: string }[], call: number) =>
      { ref: string; rank: number; score: number; rationale: string }[],
  ): Provider => {
    let call = 0
    return {
      async complete(req) {
        call++
        return JSON.stringify({ rankings: corrupt(refsIn(req.prompt), call), meta_digest: 'd' })
      },
    }
  }

  const population = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      agentId: `agent-${i}`,
      submissionMd: `work product FITNESS=${i} AGENT=agent-${i}`,
      files: [],
      status: 'ok' as const,
    }))

  test('an omitted submission scores 0, the way the single-call path already treats it', async () => {
    // The first batch answers for everyone but its last ref. That agent was never
    // judged, so a positive score derived purely from where it landed in the ordering
    // is a score the judge never gave — and it is enough to keep the agent in the
    // middle band that gets bred instead of culled.
    let omitted: string | null = null
    const provider = corruptingJudge((entries, call) => {
      if (call !== 1) return entries.map((e, i) => rank(e.ref, i))
      omitted = entries[entries.length - 1]!.agentId
      return entries.slice(0, -1).map((e, i) => rank(e.ref, i))
    })
    const res = await new Judge(provider, cfg, 42).score('goal', 'criteria', population(30))

    expect(res.mode).toBe('batched_finals')
    expect(omitted).not.toBeNull()
    const unjudged = res.scores.find((s) => s.agentId === omitted)!
    expect(unjudged.score).toBe(0)
    expect(unjudged.rationaleMd).toMatch(/no ranking/i)
    // Last place, and the only zero: nobody else loses their judged score.
    expect(unjudged.rank).toBe(30)
    expect(res.scores.filter((s) => s.score === 0)).toHaveLength(1)
  })

  test('complete rankings are scored exactly as before', async () => {
    // The guard must not touch valid output: every agent ranked, no zeros, and the
    // same rank-derived scale batched mode has always used.
    const provider = corruptingJudge((entries) => entries.map((e, i) => rank(e.ref, i)))
    const res = await new Judge(provider, cfg, 42).score('goal', 'criteria', population(30))

    expect(res.scores).toHaveLength(30)
    expect(res.scores.some((s) => s.score === 0)).toBe(false)
    expect(res.scores.map((s) => s.rank)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1))
    expect(res.scores[0]!.score).toBe(100)
    for (const s of res.scores) expect(s.rationaleMd).not.toMatch(/no ranking/i)
  })

  test('a duplicated ref keeps its first placing rather than its last', async () => {
    // A second entry for the same ref used to overwrite the first, so a model that
    // repeated itself silently replaced a real placing with whatever came later.
    let repeated: string | null = null
    const provider = corruptingJudge((entries, call) => {
      const ranked = entries.map((e, i) => rank(e.ref, i))
      if (call !== 1) return ranked
      // Deliberately NOT the batch winner: a finalist's rationale comes from the finals
      // call, which would hide an overwrite in the batch placings.
      const last = entries[entries.length - 1]!
      repeated = last.agentId
      return [...ranked, { ref: last.ref, rank: 99, score: 0, rationale: 'second-entry-wins' }]
    })
    const res = await new Judge(provider, cfg, 42).score('goal', 'criteria', population(30))

    expect(res.scores).toHaveLength(30)
    expect(new Set(res.scores.map((s) => s.agentId)).size).toBe(30)
    const first = res.scores.find((s) => s.agentId === repeated)!
    expect(first.rationaleMd).not.toBe('second-entry-wins')
    expect(res.scores.some((s) => s.score === 0)).toBe(false)
  })

  test('a ref the judge was never shown cannot invent an agent', async () => {
    const provider = corruptingJudge((entries, call) => {
      const ranked = entries.map((e, i) => rank(e.ref, i))
      return call === 1
        ? [...ranked, { ref: 'never-shown', rank: 1, score: 100, rationale: 'ghost' }]
        : ranked
    })
    const res = await new Judge(provider, cfg, 42).score('goal', 'criteria', population(30))

    expect(res.scores).toHaveLength(30)
    expect(res.scores.every((s) => s.agentId.startsWith('agent-'))).toBe(true)
  })

  test('a batch whose ranks do not start at 1 still sends its best to the finals', async () => {
    // Looking for the exact value 1 found no winner when a model numbered from 2, so
    // the batch contributed nobody to the finals and every one of its agents was
    // ordered behind every finalist regardless of how good it was.
    let calls = 0
    const provider = corruptingJudge((entries) => {
      calls++
      return entries.map((e, i) => ({ ...rank(e.ref, i), rank: i + 2 }))
    })
    const res = await new Judge(provider, cfg, 42).score('goal', 'criteria', population(30))

    expect(res.scores).toHaveLength(30)
    expect(res.scores.some((s) => s.score === 0)).toBe(false)
    // 30 agents at batchSize 5 is 6 batches; the 7th call is the finals among their
    // winners. Six calls would mean no batch produced one.
    expect(calls).toBe(7)
  })
})

describe('Judge schema usage', () => {
  test('passes the ranking schema to the provider', async () => {
    let seenSchema: unknown = null
    const provider = {
      complete: async (req: { prompt: string; schema?: unknown }) => {
        seenSchema = req.schema
        return new MockProvider(1).complete({ purpose: 'judge', prompt: req.prompt, modelId: 'm' })
      },
    }
    await new Judge(provider as never, cfg, 42).score('goal', 'criteria', [
      { agentId: 'a', submissionMd: 'work FITNESS=10', files: [], status: 'ok' },
      { agentId: 'b', submissionMd: 'work FITNESS=90', files: [], status: 'ok' },
    ])
    expect(seenSchema).toBeTruthy()
    expect((seenSchema as { required: string[] }).required).toContain('rankings')
  })

  test('passes the criteria schema when generating criteria', async () => {
    let seenSchema: unknown = null
    const provider = {
      complete: async (req: { prompt: string; schema?: unknown }) => {
        seenSchema = req.schema
        return new MockProvider(1).complete({ purpose: 'criteria', prompt: req.prompt, modelId: 'm' })
      },
    }
    await new Judge(provider as never, cfg, 42).resolveCriteria('goal', null)
    expect((seenSchema as { required: string[] }).required).toContain('criteria')
  })
})
