import { afterEach, describe, expect, test, vi } from 'vitest'
import { mapOpenCodeEvent, parseSseFrames, startEventBridge } from '../../src/server/event-bridge.js'

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

describe('startEventBridge', () => {
  afterEach(() => vi.unstubAllGlobals())

  const sseBody = (frames: string[]) => {
    const encoder = new TextEncoder()
    return new ReadableStream<Uint8Array>({
      start(controller) {
        for (const f of frames) controller.enqueue(encoder.encode(`data: ${f}\n\n`))
        controller.close()
      },
    })
  }

  const runBridge = (frames: string[], baseUrl = 'http://127.0.0.1:4096') => {
    const urls: string[] = []
    const fetchSpy = vi.fn(async (url: string) => {
      urls.push(String(url))
      return { body: sseBody(frames) }
    })
    vi.stubGlobal('fetch', fetchSpy)
    const emitted: unknown[] = []
    const bridge = startEventBridge({
      baseUrl,
      runId: 'run-1',
      lookupAgent: (sid: string) => (sid === 'ses_1' ? 'agent-1' : null),
      emit: (e) => emitted.push(e),
    })
    return { urls, emitted, bridge }
  }

  // The silent-empty-stream trap, pinned against the new contract: the bridge must
  // subscribe to /global/event (no directory filter) and unwrap its envelope frames.
  test('subscribes to /global/event and unwraps envelope frames', async () => {
    const { urls, emitted, bridge } = runBridge([
      JSON.stringify({
        directory: '/work/agent-1',
        payload: { type: 'message.part.updated', properties: { sessionID: 'ses_1', part: { type: 'tool', tool: 'bash' } } },
      }),
      JSON.stringify({ payload: { type: 'server.heartbeat', properties: {} } }),
    ])
    await vi.waitFor(() => expect(emitted).toHaveLength(1))
    bridge.stop()
    expect(urls).toEqual(['http://127.0.0.1:4096/global/event'])
    expect(emitted).toEqual([
      { type: 'agent.activity', runId: 'run-1', agentId: 'agent-1', kind: 'tool', detail: 'bash' },
    ])
  })

  test('emits nothing for a stream that carries only heartbeats', async () => {
    const { emitted, bridge } = runBridge([
      JSON.stringify({ payload: { type: 'server.heartbeat', properties: {} } }),
    ])
    await new Promise((r) => setTimeout(r, 50))
    bridge.stop()
    expect(emitted).toEqual([])
  })

  test('still maps legacy top-level frames without an envelope', async () => {
    const { emitted, bridge } = runBridge([
      JSON.stringify({ type: 'file.edited', properties: { sessionID: 'ses_1', file: 'SUBMISSION.md' } }),
    ])
    await vi.waitFor(() => expect(emitted).toHaveLength(1))
    bridge.stop()
    expect((emitted[0] as { kind: string }).kind).toBe('file')
  })
})
