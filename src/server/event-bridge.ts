import type { ActivityKind, EngineEvent, EventSink } from '../engine/events.js'

/** Ceiling on an unterminated remainder, so a stream without separators cannot grow forever. */
const MAX_SSE_REMAINDER = 1024 * 1024

/**
 * Splits an SSE buffer into complete event payloads.
 *
 * Two things the naive version got wrong. It split on `'\n\n'` only, so a server using
 * CRLF — which SSE permits — never produced a single match: the buffer grew, no event was
 * ever delivered, and an empty activity feed looked exactly like a run doing nothing. And
 * it pushed every `data:` line as its own payload, when SSE says the data lines of one
 * event concatenate; a pretty-printed JSON body therefore arrived as fragments that each
 * failed to parse and were dropped without a word.
 */
export function parseSseFrames(buffer: string): { frames: string[]; rest: string } {
  const normalized = buffer.replace(/\r\n|\r/g, '\n')
  const blocks = normalized.split('\n\n')
  let rest = blocks.pop() ?? ''
  const frames: string[] = []
  for (const block of blocks) {
    const data: string[] = []
    for (const line of block.split('\n')) {
      if (!line.startsWith('data:')) continue
      const value = line.slice(5)
      // Exactly one optional space is part of the framing; everything after it is payload.
      data.push(value.startsWith(' ') ? value.slice(1) : value)
    }
    if (data.length > 0) frames.push(data.join('\n'))
  }
  if (rest.length > MAX_SSE_REMAINDER) rest = rest.slice(-MAX_SSE_REMAINDER)
  return { frames, rest }
}

/** Reconnect backoff: 1s, 2s, 4s … capped at 10s. Pure, so it is testable directly. */
export function nextBridgeDelay(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 10_000)
}

/** A permission request's patterns are shown on a card; a handful says enough. */
const MAX_PERMISSION_PATTERNS = 5
const MAX_SUMMARY_CHARS = 300
const MAX_ITEM_BYTES = 8 * 1024
const TOOL_STATUSES = new Set(['pending', 'running', 'completed', 'error'])
/** Input fields that name what a tool acted on. Everything else in a tool's input stays private. */
const TOOL_TARGET_KEYS = ['command', 'filePath', 'path', 'pattern', 'url', 'query']

/** Strips credentials an agent may have typed into a command before it is relayed anywhere. */
export function redactSecrets(text: string): string {
  return text
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/(authorization\s*[:=]\s*)[^"'\n]*/gi, '$1[redacted]')
    .replace(/\bbearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\b(api[_-]?key|token|secret|password)(\s*[:=]\s*)[^\s"']+/gi, '$1$2[redacted]')
}

function capChars(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

function capBytes(text: string, max: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text) <= max) return { text, truncated: false }
  return { text: Buffer.from(text).subarray(0, max).toString('utf8').replace(/�+$/, ''), truncated: true }
}

function toolSummary(tool: string, input: unknown, title: unknown): string {
  const fields = typeof input === 'object' && input !== null ? input as Record<string, unknown> : {}
  const target = TOOL_TARGET_KEYS.map((k) => fields[k]).find((v): v is string => typeof v === 'string' && v.length > 0)
  const detail = target ?? (typeof title === 'string' ? title : '')
  return capChars(redactSecrets(detail ? `${tool}: ${detail}` : tool), MAX_SUMMARY_CHARS)
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
  now: () => number = Date.now,
): Extract<EngineEvent, { type: 'agent.activity' | 'agent.permission' }> | null {
  const sessionId = raw.properties?.sessionID
  if (typeof sessionId !== 'string') return null
  const agentId = lookupAgent(sessionId)
  if (!agentId) return null

  const activity = (kind: ActivityKind, detail: string) =>
    ({ type: 'agent.activity' as const, runId, agentId, kind, detail })

  switch (raw.type) {
    // Shapes verified against opencode 1.18.21's EventPermissionAsked / EventPermissionReplied.
    case 'permission.asked': {
      const p = raw.properties ?? {}
      if (typeof p.id !== 'string' || typeof p.permission !== 'string') return null
      const patterns = Array.isArray(p.patterns)
        ? p.patterns.filter((x): x is string => typeof x === 'string').slice(0, MAX_PERMISSION_PATTERNS).map((x) => x.slice(0, 200))
        : []
      return {
        type: 'agent.permission', runId, agentId, requestId: p.id, state: 'asked',
        permission: p.permission.slice(0, 80), patterns, at: now(),
      }
    }
    case 'permission.replied': {
      const p = raw.properties ?? {}
      if (typeof p.requestID !== 'string') return null
      if (p.reply !== 'once' && p.reply !== 'always' && p.reply !== 'reject') return null
      return { type: 'agent.permission', runId, agentId, requestId: p.requestID, state: 'replied', reply: p.reply, at: now() }
    }
    // Shapes verified against opencode 1.18.21's EventMessagePartUpdated / ToolPart / TextPart.
    case 'message.part.updated': {
      const part = raw.properties?.part as {
        id?: unknown; type?: string; tool?: string; callID?: unknown; text?: string
        state?: { status?: string; input?: unknown; title?: unknown; output?: unknown; error?: unknown }
      } | undefined
      if (part?.type === 'tool') {
        const state = part.state ?? {}
        const summary = toolSummary(part.tool ?? 'tool', state.input, state.title)
        const id = typeof part.callID === 'string' ? part.callID : typeof part.id === 'string' ? part.id : null
        if (id === null) return activity('tool', summary)
        const status = typeof state.status === 'string' && TOOL_STATUSES.has(state.status)
          ? state.status as 'pending' | 'running' | 'completed' | 'error'
          : undefined
        const rawOutput = status === 'completed' ? state.output : status === 'error' ? state.error : undefined
        const output = typeof rawOutput === 'string' ? capBytes(redactSecrets(rawOutput), MAX_ITEM_BYTES) : null
        return {
          ...activity('tool', summary),
          item: {
            id, sessionId, kind: 'tool', ...(status ? { status } : {}), summary,
            ...(output ? { output: output.text, ...(output.truncated ? { truncated: true } : {}) } : {}),
            observedAt: now(),
          },
        }
      }
      if (part?.type === 'text') {
        const text = part.text ?? ''
        if (typeof part.id !== 'string') return activity('text', text.slice(0, 200))
        const body = capBytes(redactSecrets(text), MAX_ITEM_BYTES)
        return {
          ...activity('text', body.text.slice(0, 200)),
          item: { id: part.id, sessionId, kind: 'text', summary: body.text, ...(body.truncated ? { truncated: true } : {}), observedAt: now() },
        }
      }
      // Reasoning and every other part type stay private.
      return null
    }
    case 'message.part.delta': {
      const p = raw.properties ?? {}
      if (p.field !== 'text' || typeof p.partID !== 'string' || typeof p.delta !== 'string') return null
      // The delta may belong to a reasoning part; the cache only extends parts it has shown.
      const delta = capBytes(redactSecrets(p.delta), MAX_ITEM_BYTES).text
      return {
        ...activity('text', delta.slice(-200)),
        item: { id: p.partID, sessionId, kind: 'text', summary: delta, append: true, observedAt: now() },
      }
    }
    case 'session.error': {
      const error = raw.properties?.error as { name?: unknown; data?: { message?: unknown } } | undefined
      const name = typeof error?.name === 'string' ? error.name : 'Error'
      const message = typeof error?.data?.message === 'string' ? error.data.message : ''
      const summary = capChars(redactSecrets(message ? `${name}: ${message}` : name), MAX_SUMMARY_CHARS)
      return {
        ...activity('error', summary),
        item: { id: `error:${sessionId}`, sessionId, kind: 'error', status: 'error', summary, observedAt: now() },
      }
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
 * Uses `/global/event`, which streams EVERY event of the server without a directory
 * filter. `/event?directory=D` filters by EXACT equality (`event.location?.directory ===
 * instance.directory`, verified in opencode v1.18.21), and agent sessions live in
 * per-agent subdirectories (`/work/<agentId>` under Docker, `<root>/<agentId>` locally),
 * so no single parent-dir subscription ever receives them — a directory that does not
 * match exactly degrades to the silent-heartbeat trap: the connection succeeds and
 * `server.heartbeat` frames arrive, but a grid would show nothing forever. Each run owns
 * its own server (per-run composition), so every frame on its stream belongs to that run
 * and no client-side filtering is needed.
 *
 * Frame shape: `data: {"directory": "<agent workspace | 'global' | absent>",
 * "payload": {"id", "type", "properties"}}`; heartbeats are `{"payload":
 * {"type": "server.heartbeat"}}`. The payload (or, for legacy top-level frames, the frame
 * itself) is the event `mapOpenCodeEvent` consumes.
 */
export function startEventBridge(opts: {
  baseUrl: string
  runId: string
  lookupAgent: (sessionId: string) => string | null
  emit: EventSink
  onError?: (e: Error) => void
  /** A subscription was accepted; evidence can flow again. */
  onConnected?: () => void
}): BridgeHandle {
  const controller = new AbortController()
  let retry: ReturnType<typeof setTimeout> | undefined
  let stopped = false

  const done = (): boolean => stopped || controller.signal.aborted

  /**
   * One subscription attempt, then a reconnect.
   *
   * A dropped stream used to end the bridge for good: the grid went quiet for the rest of
   * the run with nothing logged, because a clean EOF was indistinguishable from a run with
   * no activity. An HTTP refusal was worse — a 401 from inherited server-auth env, or a
   * 404, still has a body, so the loop was entered and reported success while delivering
   * nothing at all.
   */
  const connect = async (attempt: number): Promise<void> => {
    if (done()) return
    let progressed = false
    try {
      const res = await fetch(`${opts.baseUrl}/global/event`, {
        headers: { accept: 'text/event-stream' },
        signal: controller.signal,
      })
      if (!res.ok) throw new Error(`OpenCode event stream refused the subscription: ${res.status}`)
      if (!res.body) throw new Error('OpenCode event stream returned no body')
      try {
        opts.onConnected?.()
      } catch {
        /* a health subscriber must never break the stream */
      }

      const reader = res.body.getReader()
      try {
        const decoder = new TextDecoder()
        let buffer = ''
        for (;;) {
          const chunk = await reader.read()
          if (chunk.done) break
          progressed = true
          buffer += decoder.decode(chunk.value, { stream: true })
          const { frames, rest } = parseSseFrames(buffer)
          buffer = rest
          for (const frame of frames) {
            let parsed: { payload?: RawEvent; type?: string; properties?: Record<string, unknown> }
            try {
              parsed = JSON.parse(frame)
            } catch {
              continue
            }
            // /global/event wraps each event as {directory, project, payload}; anything
            // without a payload object is consumed at the top level instead.
            const raw = parsed.payload ?? parsed
            const mapped = mapOpenCodeEvent(raw, opts.runId, opts.lookupAgent)
            if (mapped) opts.emit(mapped)
          }
        }
      } finally {
        // Release the body even when we leave through an error or an abort.
        await reader.cancel().catch(() => {})
      }
    } catch (e) {
      if (done()) return
      opts.onError?.(e instanceof Error ? e : new Error(String(e)))
      schedule(progressed ? 0 : attempt + 1)
      return
    }
    // A clean end of stream is not an error — the server simply closed it — but the run
    // is not over, so resubscribe rather than going silent.
    schedule(progressed ? 0 : attempt + 1)
  }

  function schedule(attempt: number): void {
    if (done()) return
    retry = setTimeout(() => { void connect(attempt) }, nextBridgeDelay(attempt))
  }

  void connect(0)

  return {
    stop: () => {
      // Set before aborting so an in-flight attempt's catch cannot schedule another.
      stopped = true
      if (retry) clearTimeout(retry)
      controller.abort()
    },
  }
}
