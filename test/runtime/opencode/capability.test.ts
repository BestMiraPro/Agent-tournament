import { describe, expect, test } from 'vitest'
import { classifyProbe, summarizeValidation } from '../../../src/runtime/opencode/capability.js'

describe('classifyProbe', () => {
  test('reports ok when structured output came back', () => {
    expect(classifyProbe({ structured: { a: 1 }, text: '', error: null }, 'structured')).toEqual({
      ok: true, reason: null,
    })
  })

  test('reports failure when structured output was required but absent', () => {
    const r = classifyProbe({ structured: null, text: 'hello', error: null }, 'structured')
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/structured/i)
  })

  test('accepts text-only output for a worker probe', () => {
    expect(classifyProbe({ structured: null, text: 'hello', error: null }, 'text')).toEqual({
      ok: true, reason: null,
    })
  })

  test('reports failure when a worker probe returned nothing', () => {
    const r = classifyProbe({ structured: null, text: '', error: null }, 'text')
    expect(r.ok).toBe(false)
  })

  test('surfaces a provider error with its status code', () => {
    const r = classifyProbe(
      { structured: null, text: '', error: { name: 'APIError', data: { statusCode: 404, message: 'Not Found' } } },
      'text',
    )
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('404')
  })
})

describe('summarizeValidation', () => {
  test('separates usable from unusable models', () => {
    const s = summarizeValidation([
      { modelId: 'a/b', role: 'worker', ok: true, reason: null },
      { modelId: 'c/d', role: 'judge', ok: false, reason: '404' },
    ])
    expect(s.usable).toEqual(['a/b'])
    expect(s.unusable).toEqual([{ modelId: 'c/d', role: 'judge', reason: '404' }])
  })

  test('reports all usable when nothing failed', () => {
    const s = summarizeValidation([{ modelId: 'a/b', role: 'worker', ok: true, reason: null }])
    expect(s.unusable).toEqual([])
  })
})
