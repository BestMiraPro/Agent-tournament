import type { EngineEvent, EventSink } from '../engine/events.js'

export function parseSseFrames(buffer: string): { frames: string[]; rest: string } {
  const frames: string[] = []
  const parts = buffer.split('\n\n')
  const rest = parts.pop() ?? ''
  for (const block of parts) {
    for (const line of block.split('\n')) {
      if (line.startsWith('data:')) frames.push(line.slice(5).trim())
    }
  }
  return { frames, rest }
}

interface RawEvent {
  type?: string
  properties?: Record<string, unknown>
}

/**
 * Re-keys an OpenCode event from sessionID onto an agent.
 *
 * Wire types are lowercase-dotted (`message.part.updated`), NOT the OpenAPI schema
 * names (`EventMessagePartUpdated`). Matching schema names matches nothing.
 */
export function mapOpenCodeEvent(
  raw: RawEvent,
  runId: string,
  lookupAgent: (sessionId: string) => string | null,
): Extract<EngineEvent, { type: 'agent.activity' }> | null {
  const sessionId = raw.properties?.sessionID
  if (typeof sessionId !== 'string') return null
  const agentId = lookupAgent(sessionId)
  if (!agentId) return null

  const activity = (kind: 'tool' | 'text' | 'file', detail: string) =>
    ({ type: 'agent.activity' as const, runId, agentId, kind, detail })

  switch (raw.type) {
    case 'message.part.updated': {
      const part = raw.properties?.part as { type?: string; tool?: string; text?: string } | undefined
      if (part?.type === 'tool') return activity('tool', part.tool ?? 'tool')
      if (part?.type === 'text') return activity('text', (part.text ?? '').slice(0, 200))
      return null
    }
    case 'file.edited':
      return activity('file', String(raw.properties?.file ?? 'file'))
    default:
      return null
  }
}

export interface BridgeHandle {
  stop(): void
}

/**
 * Subscribes to one OpenCode server's event stream and relays agent activity.
 *
 * `directory` is REQUIRED. Verified: subscribing without it yields only
 * `server.connected` and `server.heartbeat` — the connection succeeds and frames
 * arrive, so the failure is silent and a grid would show nothing forever.
 */
export function startEventBridge(opts: {
  baseUrl: string
  directory: string
  runId: string
  lookupAgent: (sessionId: string) => string | null
  emit: EventSink
  onError?: (e: Error) => void
}): BridgeHandle {
  const controller = new AbortController()

  void (async () => {
    try {
      const url = `${opts.baseUrl}/event?directory=${encodeURIComponent(opts.directory)}`
      const res = await fetch(url, {
        headers: { accept: 'text/event-stream' },
        signal: controller.signal,
      })
      if (!res.body) return
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) return
        buffer += decoder.decode(value, { stream: true })
        const { frames, rest } = parseSseFrames(buffer)
        buffer = rest
        for (const frame of frames) {
          let raw: RawEvent
          try {
            raw = JSON.parse(frame)
          } catch {
            continue
          }
          const mapped = mapOpenCodeEvent(raw, opts.runId, opts.lookupAgent)
          if (mapped) opts.emit(mapped)
        }
      }
    } catch (e) {
      if (!controller.signal.aborted) {
        opts.onError?.(e instanceof Error ? e : new Error(String(e)))
      }
    }
  })()

  return { stop: () => controller.abort() }
}
