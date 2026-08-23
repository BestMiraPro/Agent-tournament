import { describe, expect, test } from 'vitest'
import { z } from 'zod'
import { extractJson, parseWithRepair } from '../../src/judge/parse.js'

const schema = z.object({ a: z.number() })

describe('extractJson', () => {
  test('parses bare JSON', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 })
  })

  test('parses JSON inside a fenced code block', () => {
    expect(extractJson('here you go:\n```json\n{"a":1}\n```\n')).toEqual({ a: 1 })
  })

  test('parses JSON surrounded by prose', () => {
    expect(extractJson('Sure! {"a":1} hope that helps')).toEqual({ a: 1 })
  })

  test('returns null when there is no JSON', () => {
    expect(extractJson('no json here')).toBeNull()
  })
})

describe('parseWithRepair', () => {
  test('returns parsed value on first success without a retry', async () => {
    let calls = 0
    const out = await parseWithRepair('{"a":1}', schema, async () => {
      calls++
      return '{"a":2}'
    })
    expect(out).toEqual({ a: 1 })
    expect(calls).toBe(0)
  })

  test('retries once when the first output is unparseable', async () => {
    let calls = 0
    const out = await parseWithRepair('garbage', schema, async () => {
      calls++
      return '{"a":2}'
    })
    expect(out).toEqual({ a: 2 })
    expect(calls).toBe(1)
  })

  test('retries once when JSON parses but fails the schema', async () => {
    const out = await parseWithRepair('{"a":"nope"}', schema, async () => '{"a":3}')
    expect(out).toEqual({ a: 3 })
  })

  test('throws when the repair attempt also fails', async () => {
    await expect(parseWithRepair('garbage', schema, async () => 'still garbage'))
      .rejects.toThrow(/repair/i)
  })
})
