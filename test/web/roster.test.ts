import { describe, expect, test } from 'vitest'
import { summarizeRoster } from '../../web/src/lib/roster.js'

describe('summarizeRoster', () => {
  test('valid multi-row sums counts exactly', () => {
    expect(summarizeRoster([
      { modelId: 'a', count: 4, temperature: 0.7 },
      { modelId: 'b', count: 2, temperature: 1 },
    ])).toEqual({ total: 6, errors: [] })
  })

  test('empty model names its 1-based row', () => {
    const { errors } = summarizeRoster([
      { modelId: 'a', count: 1, temperature: 0.7 },
      { modelId: '  ', count: 1, temperature: 0.7 },
    ])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/row 2.*model is empty/)
  })

  test('count 0 is an error', () => {
    const { errors } = summarizeRoster([{ modelId: 'a', count: 0, temperature: 0.7 }])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/row 1.*count must be/)
  })

  test('non-integer count is an error', () => {
    const { errors } = summarizeRoster([{ modelId: 'a', count: 1.5, temperature: 0.7 }])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/row 1.*count must be/)
  })

  test('temperature above 2 is an error', () => {
    const { errors } = summarizeRoster([{ modelId: 'a', count: 1, temperature: 2.5 }])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/row 1.*temperature/)
  })

  test('NaN temperature is an error', () => {
    const { errors } = summarizeRoster([{ modelId: 'a', count: 1, temperature: NaN }])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/row 1.*temperature/)
  })

  test('all-valid single row has no errors', () => {
    expect(summarizeRoster([{ modelId: 'mock/model', count: 4, temperature: 0.7 }]))
      .toEqual({ total: 4, errors: [] })
  })
})
