import { describe, expect, test } from 'vitest'
import { RANKING_JSON_SCHEMA, CRITERIA_JSON_SCHEMA } from '../../src/judge/schemas.js'
import { REFLECT_JSON_SCHEMA } from '../../src/evolution/schemas.js'

const allSchemas = [RANKING_JSON_SCHEMA, CRITERIA_JSON_SCHEMA, REFLECT_JSON_SCHEMA]

describe('JSON schemas', () => {
  test('every schema is a closed object', () => {
    for (const s of allSchemas) {
      expect(s.type).toBe('object')
      expect(s.additionalProperties).toBe(false)
    }
  })

  test('ranking schema requires the fields the judge parses, bounds the score and closes the safety review', () => {
    const item = RANKING_JSON_SCHEMA.properties.rankings.items
    expect(item.required).toEqual(['ref', 'rank', 'score', 'rationale', 'criteria', 'limitations', 'safety'])
    expect(item.properties.score).toEqual({ type: 'number', minimum: 0, maximum: 100 })
    expect(item.properties.safety.additionalProperties).toBe(false)
    expect(item.properties.safety.properties.findings.maxItems).toBe(20)
    expect(item.properties.safety.properties.findings.items.properties.evidence_ids.maxItems).toBe(20)
    expect(item.properties.safety.properties.limitations.maxItems).toBe(20)
    expect(RANKING_JSON_SCHEMA.required).toContain('rankings')
    expect(RANKING_JSON_SCHEMA.required).toContain('meta_digest')
  })

  test('criteria schema requires a criteria array with name and weight', () => {
    const item = CRITERIA_JSON_SCHEMA.properties.criteria.items
    expect(item.required).toContain('name')
    expect(item.required).toContain('weight')
  })

  test('reflect schema requires strategy_md and notes_md', () => {
    expect(REFLECT_JSON_SCHEMA.required).toContain('strategy_md')
    expect(REFLECT_JSON_SCHEMA.required).toContain('notes_md')
  })

  test('every schema serializes to JSON without throwing', () => {
    for (const s of allSchemas) expect(() => JSON.stringify(s)).not.toThrow()
  })
})
