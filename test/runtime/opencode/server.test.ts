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

  test('extracts the port from a bracketed IPv6 host', () => {
    expect(parseServerPort('opencode server listening on http://[::1]:4599')).toBe(4599)
  })

  test('extracts the port from an https url', () => {
    expect(parseServerPort('listening on https://127.0.0.1:8443')).toBe(8443)
  })

  test('finds the banner inside a multi-line chunk', () => {
    expect(
      parseServerPort(['Warning: unsecured', 'opencode server listening on http://127.0.0.1:7777', ''].join('\n')),
    ).toBe(7777)
  })
})
