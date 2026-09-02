import { describe, expect, test } from 'vitest'
import { parseSseFrames, mapOpenCodeEvent } from '../../src/server/event-bridge.js'

describe('parseSseFrames', () => {
  test('extracts complete data frames and keeps the remainder', () => {
    const r = parseSseFrames('data: {"a":1}\n\ndata: {"b":2}\n\ndata: {"c"')
    expect(r.frames).toEqual(['{"a":1}', '{"b":2}'])
    expect(r.rest).toBe('data: {"c"')
  })

  test('ignores non-data lines', () => {
    expect(parseSseFrames(': keepalive\n\ndata: {"a":1}\n\n').frames).toEqual(['{"a":1}'])
  })

  test('returns nothing for a partial first frame', () => {
    const r = parseSseFrames('data: {"partial"')
    expect(r.frames).toEqual([])
    expect(r.rest).toBe('data: {"partial"')
  })
})

describe('mapOpenCodeEvent', () => {
  const lookup = (sessionId: string) => (sessionId === 'ses_1' ? 'agent-1' : null)

  test('maps a tool part to an activity event', () => {
    const e = mapOpenCodeEvent(
      { type: 'message.part.updated', properties: { sessionID: 'ses_1', part: { type: 'tool', tool: 'bash' } } },
      'run-1', lookup,
    )
    expect(e).toEqual({ type: 'agent.activity', runId: 'run-1', agentId: 'agent-1', kind: 'tool', detail: 'bash' })
  })

  test('maps a file edit to an activity event', () => {
    const e = mapOpenCodeEvent(
      { type: 'file.edited', properties: { sessionID: 'ses_1', file: 'SUBMISSION.md' } },
      'run-1', lookup,
    )
    expect(e?.kind).toBe('file')
  })

  test('returns null for an unmapped session', () => {
    expect(mapOpenCodeEvent(
      { type: 'file.edited', properties: { sessionID: 'ses_unknown' } }, 'run-1', lookup,
    )).toBeNull()
  })

  test('returns null for transport noise', () => {
    expect(mapOpenCodeEvent({ type: 'server.heartbeat', properties: {} }, 'run-1', lookup)).toBeNull()
  })

  test('returns null for an event with no session id', () => {
    expect(mapOpenCodeEvent({ type: 'file.edited', properties: {} }, 'run-1', lookup)).toBeNull()
  })
})
