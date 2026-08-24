import { describe, expect, test } from 'vitest'
import { parseServerPort } from '../../../src/runtime/opencode/server.js'

describe('parseServerPort', () => {
  test('extracts the port from the startup banner', () => {
    expect(parseServerPort('opencode server listening on http://127.0.0.1:4599')).toBe(4599)
  })

  test('ignores unrelated lines', () => {
    expect(parseServerPort('Warning: OPENCODE_SERVER_PASSWORD is not set')).toBeNull()
  })

  test('handles a different host', () => {
    expect(parseServerPort('opencode server listening on http://0.0.0.0:1234')).toBe(1234)
  })

  test('returns null for empty input', () => {
    expect(parseServerPort('')).toBeNull()
  })
})
