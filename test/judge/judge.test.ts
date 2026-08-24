import { describe, expect, test } from 'vitest'
import { Judge } from '../../src/judge/judge.js'
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
