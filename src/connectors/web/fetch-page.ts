import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { pipeline, Readable } from 'node:stream'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'
import { htmlToText } from './html-to-text.js'
import { BlockedTargetError, parseTargetUrl, pinnedLookup, resolvePublicAddress, systemLookup, type LookupFn } from './ssrf.js'

/**
 * `web_fetch`: one page, read for an agent. Every hop is validated, resolved once, checked and
 * pinned (`ssrf.ts`); redirects are followed by hand; the body, the time and the returned text are
 * capped. HTML becomes readable text, text-like types pass through, binaries are refused.
 */

export interface FetchLimits {
  maxRedirects: number
  /** Body bytes read, after decompression; reading stops here and the result says so. */
  maxBytes: number
  /** The whole call: every lookup, hop and body read. */
  timeoutMs: number
  /** Characters of text returned. */
  maxChars: number
}

export const DEFAULT_FETCH_LIMITS: FetchLimits = { maxRedirects: 5, maxBytes: 2 * 1024 * 1024, timeoutMs: 20_000, maxChars: 64_000 }

export type FetchErrorCode = 'too_many_redirects' | 'timeout' | 'unsupported_content_type' | 'network' | 'bad_response'

export class WebFetchError extends Error {
  constructor(public readonly code: FetchErrorCode, message: string) {
    super(message)
    this.name = 'WebFetchError'
  }
}

export interface RawResponse {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: AsyncIterable<Uint8Array>
}

/** One GET to `url`, connected to `address` and nowhere else. */
export type PinnedRequester = (target: { url: URL; address: string; family: 4 | 6; signal: AbortSignal }) => Promise<RawResponse>

export interface FetchDeps {
  lookup?: LookupFn
  request?: PinnedRequester
}

export interface FetchedPage {
  /** Where the content came from, after redirects. */
  url: string
  status: number
  contentType: string
  title: string | null
  text: string
  /** Body bytes read (decompressed). */
  bytes: number
  /** The body or the text was cut at its cap. */
  truncated: boolean
  redirects: number
}

const USER_AGENT = 'Mozilla/5.0 (compatible; agent-tournament-web-fetch/1.0)'
const ACCEPT = 'text/html,application/xhtml+xml,text/plain;q=0.9,application/json;q=0.9,text/*;q=0.8,*/*;q=0.1'
const REDIRECTS = new Set([301, 302, 303, 307, 308])

/** node:http(s) with a fresh agent per hop (no pooled socket, no proxy) and the pinned lookup. */
export const nodeRequester: PinnedRequester = ({ url, address, family, signal }) =>
  new Promise((resolve, reject) => {
    const request = url.protocol === 'https:' ? httpsRequest : httpRequest
    const req = request(url, {
      method: 'GET',
      agent: false,
      lookup: pinnedLookup(address, family),
      headers: { 'user-agent': USER_AGENT, accept: ACCEPT, 'accept-encoding': 'gzip, deflate, br' },
      signal,
    }, (res) => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: res }))
    req.on('error', reject)
    req.end()
  })

function header(headers: RawResponse['headers'], name: string): string {
  const value = headers[name]
  return (Array.isArray(value) ? value[0] : value) ?? ''
}

/** Releases a body that will not be read. */
function discard(body: AsyncIterable<Uint8Array>): void {
  const destroy = (body as { destroy?: () => void }).destroy
  if (typeof destroy === 'function') destroy.call(body)
  else void body[Symbol.asyncIterator]().return?.()
}

function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v) },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e) },
    )
  })
}

type Kind = 'html' | 'text'

function kindOf(type: string): Kind | null | 'sniff' {
  if (type === '') return 'sniff'
  if (type === 'text/html' || type === 'application/xhtml+xml') return 'html'
  if (type.startsWith('text/')) return 'text'
  if (['application/json', 'application/xml', 'application/javascript', 'application/x-ndjson'].includes(type)) return 'text'
  if (type.endsWith('+json') || type.endsWith('+xml')) return 'text'
  return null
}

function decoderFor(encoding: string): NodeJS.ReadWriteStream | null {
  switch (encoding.trim().toLowerCase()) {
    case 'gzip':
    case 'x-gzip':
      return createGunzip()
    case 'deflate':
      return createInflate()
    case 'br':
      return createBrotliDecompress()
    default:
      return null
  }
}

async function readCapped(res: RawResponse, maxBytes: number, signal: AbortSignal): Promise<{ body: Buffer; truncated: boolean }> {
  const source = Readable.from(res.body, { objectMode: false })
  const decoder = decoderFor(header(res.headers, 'content-encoding'))
  const stream: Readable = decoder ? (pipeline(source, decoder, () => {}) as unknown as Readable) : source
  const chunks: Buffer[] = []
  let total = 0
  let truncated = false
  // Each read races the deadline: a source stuck mid-await cannot be destroyed into returning.
  const reader = stream[Symbol.asyncIterator]()
  try {
    for (;;) {
      const next = await untilAborted(reader.next(), signal)
      if (next.done) break
      const chunk = next.value as Buffer | Uint8Array
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      if (total + buf.length > maxBytes) {
        chunks.push(buf.subarray(0, maxBytes - total))
        total = maxBytes
        truncated = true
        break
      }
      chunks.push(buf)
      total += buf.length
    }
  } catch {
    if (signal.aborted) throw signal.reason
    throw new WebFetchError('bad_response', `could not read the response${decoder ? ' (decompression failed)' : ''}`)
  } finally {
    stream.destroy()
    source.destroy()
  }
  return { body: Buffer.concat(chunks), truncated }
}

function charsetOf(contentType: string, body: Buffer, kind: Kind): string {
  const declared = /charset\s*=\s*"?([\w.:-]+)/i.exec(contentType)?.[1]
  if (declared) return declared
  if (kind === 'html') {
    const head = body.subarray(0, 2048).toString('latin1')
    const meta = /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(head)?.[1]
    if (meta) return meta
  }
  return 'utf-8'
}

function decode(body: Buffer, charset: string): string {
  try {
    return new TextDecoder(charset).decode(body)
  } catch {
    return new TextDecoder('utf-8').decode(body)
  }
}

export async function fetchPage(rawUrl: string, deps: FetchDeps = {}, limits: Partial<FetchLimits> = {}): Promise<FetchedPage> {
  const lim = { ...DEFAULT_FETCH_LIMITS, ...limits }
  const lookup = deps.lookup ?? systemLookup
  const request = deps.request ?? nodeRequester
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new WebFetchError('timeout', `the fetch took longer than ${lim.timeoutMs} ms`)), lim.timeoutMs)
  const { signal } = controller
  try {
    let url = parseTargetUrl(rawUrl)
    for (let redirects = 0; ; redirects++) {
      const { address, family } = await untilAborted(resolvePublicAddress(url.hostname, lookup), signal)
      let res: RawResponse
      try {
        res = await untilAborted(request({ url, address, family, signal }), signal)
      } catch (e) {
        if (signal.aborted) throw signal.reason
        const code = (e as NodeJS.ErrnoException).code
        throw new WebFetchError('network', `the connection failed${code && /^[A-Z0-9_]+$/.test(code) ? ` (${code})` : ''}`)
      }
      const location = header(res.headers, 'location')
      if (REDIRECTS.has(res.status) && location) {
        discard(res.body)
        if (redirects >= lim.maxRedirects) throw new WebFetchError('too_many_redirects', `more than ${lim.maxRedirects} redirects`)
        let next: URL
        try {
          next = new URL(location, url)
        } catch {
          throw new WebFetchError('bad_response', 'the redirect location is not a valid URL')
        }
        url = parseTargetUrl(next.href)
        continue
      }

      const contentType = header(res.headers, 'content-type')
      const type = contentType.split(';')[0]!.trim().toLowerCase()
      let kind = kindOf(type)
      if (kind === null) {
        discard(res.body)
        throw new WebFetchError('unsupported_content_type', `${type} is not text; only web pages, text, JSON and XML can be fetched`)
      }
      const { body, truncated: cut } = await readCapped(res, lim.maxBytes, signal)
      if (kind === 'sniff') {
        if (body.subarray(0, 4096).includes(0)) {
          throw new WebFetchError('unsupported_content_type', 'the response has no content type and looks binary')
        }
        kind = /^\s*<(!doctype html|html)/i.test(body.subarray(0, 512).toString('latin1')) ? 'html' : 'text'
      }
      const decoded = decode(body, charsetOf(contentType, body, kind))
      const converted = kind === 'html' ? htmlToText(decoded, url.href) : { title: null, text: decoded }
      let text = converted.text
      let truncated = cut
      if (text.length > lim.maxChars) {
        text = `${text.slice(0, lim.maxChars)}\n\n[truncated: ${text.length - lim.maxChars} more characters]`
        truncated = true
      }
      return {
        url: url.href,
        status: res.status,
        contentType: kind === 'html' && type === '' ? 'text/html' : type || 'text/plain',
        title: converted.title,
        text,
        bytes: body.length,
        truncated,
        redirects,
      }
    }
  } finally {
    clearTimeout(timer)
  }
}

export { BlockedTargetError }
