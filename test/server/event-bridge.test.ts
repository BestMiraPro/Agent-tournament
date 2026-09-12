import { afterEach, describe, expect, test, vi } from 'vitest'
import { mapOpenCodeEvent, nextBridgeDelay, parseSseFrames, startEventBridge } from '../../src/server/event-bridge.js'

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

  test('handles CRLF terminators', () => {
    // SSE permits CRLF, and a split on LF pairs alone never matched one: the buffer just
    // grew and not a single event was ever delivered, which looks like an idle run.
    const r = parseSseFrames('data: {"a":1}\r\n\r\ndata: {"b":2}\r\n\r\n')
    expect(r.frames).toEqual(['{"a":1}', '{"b":2}'])
    expect(r.rest).toBe('')
  })

  test('handles bare CR terminators', () => {
    expect(parseSseFrames('data: {"a":1}\r\rdata: {"b":2}\r\r').frames)
      .toEqual(['{"a":1}', '{"b":2}'])
  })

  test('joins multiple data lines into one payload', () => {
    // Per SSE, the data lines of one event concatenate. Emitting them separately turned
    // a pretty-printed JSON body into fragments that each failed to parse and were
    // silently dropped.
    const r = parseSseFrames('data: {\ndata:   "a": 1\ndata: }\n\n')
    expect(r.frames).toHaveLength(1)
    expect(JSON.parse(r.frames[0]!)).toEqual({ a: 1 })
  })

  test('strips exactly one space after the colon, not meaningful whitespace', () => {
    expect(parseSseFrames('data:  {"a":1}\n\n').frames).toEqual([' {"a":1}'])
  })

  test('bounds the retained remainder', () => {
    const r = parseSseFrames(`data: ${'x'.repeat(4_000_000)}`)
    expect(r.frames).toEqual([])
    expect(r.rest.length).toBeLessThan(2_000_000)
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
      return { ok: true, status: 200, body: sseBody(frames) }
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

  test('reports an HTTP refusal instead of silently delivering nothing', async () => {
    // A 401 (the auth-env trap) or a 404 still has a body, so the old code entered the
    // read loop and showed an empty activity feed forever with nothing logged.
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 401, body: new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
    })))
    const errors: Error[] = []
    const bridge = startEventBridge({
      baseUrl: 'http://127.0.0.1:4096', runId: 'run-1',
      lookupAgent: () => null, emit: () => {}, onError: (e) => errors.push(e),
    })
    await vi.waitFor(() => expect(errors).toHaveLength(1))
    bridge.stop()
    expect(errors[0]!.message).toMatch(/401/)
  })

  test('reconnects after the stream ends and stops retrying once stopped', async () => {
    // A run is not over because its event stream dropped; without a retry the grid went
    // quiet for the rest of the run with no indication.
    vi.useFakeTimers()
    try {
      const fetchSpy = vi.fn(async () => ({
        ok: true, status: 200, body: sseBody([]),
      }))
      vi.stubGlobal('fetch', fetchSpy)
      const bridge = startEventBridge({
        baseUrl: 'http://127.0.0.1:4096', runId: 'run-1',
        lookupAgent: () => null, emit: () => {},
      })
      await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1))
      // This stream closes without delivering a byte, so the attempt did not progress and
      // the backoff advances rather than resetting to its first step.
      await vi.advanceTimersByTimeAsync(nextBridgeDelay(1))
      await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2))

      bridge.stop()
      const afterStop = fetchSpy.mock.calls.length
      await vi.advanceTimersByTimeAsync(60_000)
      expect(fetchSpy).toHaveBeenCalledTimes(afterStop)
    } finally {
      vi.useRealTimers()
    }
  })

  test('reconnects after a transport failure', async () => {
    vi.useFakeTimers()
    try {
      let attempt = 0
      const emitted: unknown[] = []
      const fetchSpy = vi.fn(async () => {
        attempt++
        if (attempt === 1) throw new TypeError('connection refused')
        return {
          ok: true, status: 200,
          body: sseBody([JSON.stringify({
            payload: {
              type: 'message.part.updated',
              properties: { sessionID: 'ses_1', part: { type: 'tool', tool: 'bash' } },
            },
          })]),
        }
      })
      vi.stubGlobal('fetch', fetchSpy)
      const bridge = startEventBridge({
        baseUrl: 'http://127.0.0.1:4096', runId: 'run-1',
        lookupAgent: (sid: string) => (sid === 'ses_1' ? 'agent-1' : null),
        emit: (e) => emitted.push(e),
        onError: () => {},
      })
      await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1))
      await vi.advanceTimersByTimeAsync(nextBridgeDelay(1))
      // The retry carries real activity through, so the feed recovers.
      await vi.waitFor(() => expect(emitted).toHaveLength(1))
      bridge.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('nextBridgeDelay', () => {
  test('backs off exponentially and caps', () => {
    expect(nextBridgeDelay(0)).toBe(1000)
    expect(nextBridgeDelay(1)).toBe(2000)
    expect(nextBridgeDelay(2)).toBe(4000)
    expect(nextBridgeDelay(50)).toBe(10_000)
  })
})
