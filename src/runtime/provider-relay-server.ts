import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { AddressInfo } from 'node:net'
import type { RelayPolicy } from './provider-relay.js'

/** One relay decision, for attribution: which run, which model, what happened, how many bytes. */
export interface RelayRecord {
  runId: string | null
  modelId: string | null
  status: number
  outcome: 'relayed' | 'refused' | 'truncated' | 'upstream_error'
  requestBytes: number
  responseBytes: number
  /** A fixed description, never upstream error text: that can echo request detail. */
  error: string | null
}

export type UpstreamCall = (
  url: string,
  init: { headers: Record<string, string>; body: Buffer; signal: AbortSignal },
) => Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: AsyncIterable<Uint8Array> }>

export interface ProviderRelay {
  host: string
  port: number
  close(): Promise<void>
}

/** Response headers a worker needs; cookies and upstream routing details stay behind. */
const RESPONSE_HEADERS = ['content-type'] as const

/** A streamed reply sends tokens often; one silent this long is a stuck upstream. */
const UPSTREAM_IDLE_MS = 15 * 60_000

/** node:https never follows redirects on its own, which is what the relay needs. */
export const httpsUpstream: UpstreamCall = (url, init) =>
  new Promise((resolve, reject) => {
    const req = httpsRequest(
      url,
      { method: 'POST', headers: { ...init.headers, 'content-length': String(init.body.length) }, signal: init.signal },
      (res) => resolve({ status: res.statusCode ?? 502, headers: res.headers, body: res }),
    )
    req.setTimeout(UPSTREAM_IDLE_MS, () => req.destroy(new Error('upstream idle timeout')))
    req.on('error', reject)
    req.end(init.body)
  })

const sendJson = (res: ServerResponse, status: number, error: string) => {
  res.writeHead(status, { 'content-type': 'application/json', connection: 'close' })
  res.end(JSON.stringify({ error }))
}

/**
 * The relay's HTTP face, on the host. Keys never leave this process: workers reach it through
 * a forwarder container and present only their run token. Loopback by default.
 */
export async function startProviderRelay(opts: {
  policy: RelayPolicy
  host?: string
  port?: number
  upstream?: UpstreamCall
  onRequest?: (record: RelayRecord) => void
}): Promise<ProviderRelay> {
  const host = opts.host ?? '127.0.0.1'
  const upstream = opts.upstream ?? httpsUpstream
  const { maxRequestBytes, maxResponseBytes } = opts.policy.limits
  const report = (record: RelayRecord) => {
    try {
      opts.onRequest?.(record)
    } catch {
      /* a recorder failure must not break a relayed call */
    }
  }

  const handle = (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    let received = 0
    let refused = false
    req.on('data', (chunk: Buffer) => {
      if (refused) return
      received += chunk.length
      if (received > maxRequestBytes) {
        // Refused while reading: the rest is drained, never buffered.
        refused = true
        chunks.length = 0
        sendJson(res, 413, `request body exceeds ${maxRequestBytes} bytes`)
        report({ runId: null, modelId: null, status: 413, outcome: 'refused', requestBytes: received, responseBytes: 0, error: `request body exceeds ${maxRequestBytes} bytes` })
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (refused) return
      void relay(req, res, Buffer.concat(chunks))
    })
    req.on('error', () => res.destroy())
  }

  const relay = async (req: IncomingMessage, res: ServerResponse, body: Buffer) => {
    const decision = opts.policy.authorize({ method: req.method ?? '', path: req.url ?? '', headers: req.headers, body })
    if (!decision.ok) {
      sendJson(res, decision.status, decision.error)
      report({ runId: decision.runId ?? null, modelId: null, status: decision.status, outcome: 'refused', requestBytes: body.length, responseBytes: 0, error: decision.error })
      return
    }
    const base = { runId: decision.runId, modelId: decision.modelId, requestBytes: body.length }
    const controller = new AbortController()
    res.on('close', () => { if (!res.writableFinished) controller.abort() })

    let reply: Awaited<ReturnType<UpstreamCall>>
    try {
      reply = await upstream(decision.url, { headers: decision.headers, body: decision.body, signal: controller.signal })
    } catch {
      sendJson(res, 502, 'upstream unreachable')
      report({ ...base, status: 502, outcome: 'upstream_error', responseBytes: 0, error: 'upstream unreachable' })
      return
    }
    if (reply.status >= 300 && reply.status < 400) {
      controller.abort()
      sendJson(res, 502, 'upstream redirect refused')
      report({ ...base, status: 502, outcome: 'upstream_error', responseBytes: 0, error: 'upstream redirect refused' })
      return
    }

    const headers: Record<string, string> = {}
    for (const name of RESPONSE_HEADERS) {
      const value = reply.headers[name]
      if (typeof value === 'string') headers[name] = value
    }
    res.writeHead(reply.status, headers)
    let sent = 0
    try {
      for await (const chunk of reply.body) {
        if (sent + chunk.length > maxResponseBytes) {
          controller.abort()
          // Flush what was already written, then close without the final chunk: the worker
          // sees an incomplete reply, never one that looks finished.
          if (res.socket) res.socket.end()
          else res.destroy()
          report({ ...base, status: reply.status, outcome: 'truncated', responseBytes: sent, error: `response exceeded ${maxResponseBytes} bytes` })
          return
        }
        sent += chunk.length
        if (!res.write(chunk)) await new Promise<void>((resolve) => res.once('drain', resolve))
      }
    } catch {
      res.destroy()
      report({ ...base, status: reply.status, outcome: 'upstream_error', responseBytes: sent, error: 'upstream stream failed' })
      return
    }
    res.end()
    report({ ...base, status: reply.status, outcome: 'relayed', responseBytes: sent, error: null })
  }

  const server = createServer(handle)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port ?? 0, host, () => resolve())
  })
  return {
    host,
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
