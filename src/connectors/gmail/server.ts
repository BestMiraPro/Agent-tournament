import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

export const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1'

/**
 * The only Gmail API paths this server reads: messages (list, one), threads (one), labels (list). Message and thread ids
 * are hexadecimal, so no id can spell an action path such as `messages/send`.
 */
const GMAIL_ID = /^[0-9a-fA-F]{1,32}$/
const READ_PATH = /^users\/me\/(messages|messages\/[0-9a-fA-F]{1,32}|threads\/[0-9a-fA-F]{1,32}|labels)$/

export type GmailGet = (path: string, query?: Record<string, string | number | string[] | undefined>) => Promise<Record<string, unknown>>

/**
 * A Gmail API client that can only GET the read paths above. With the gmail.readonly scope Google would refuse a write
 * anyway; this makes the code unable to ask.
 */
export function gmailApi(opts: { accessToken: () => Promise<string>; fetch?: typeof fetch }): GmailGet {
  const doFetch = opts.fetch ?? fetch
  return async (path, query = {}) => {
    if (!READ_PATH.test(path)) throw new Error(`Gmail path ${path} is not a read path this connector may call`)
    const params = new URLSearchParams()
    for (const [k, v] of Object.entries(query)) {
      if (Array.isArray(v)) for (const item of v) params.append(k, item)
      else if (v !== undefined && v !== '') params.set(k, String(v))
    }
    const res = await doFetch(`${GMAIL_API_BASE}/${path}${params.size > 0 ? `?${params}` : ''}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${await opts.accessToken()}` },
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) throw new GmailError(res.status)
    return (await res.json()) as Record<string, unknown>
  }
}

export class GmailError extends Error {
  constructor(readonly status: number) {
    super(`Gmail refused the request (HTTP ${status})`)
  }
}

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {})
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? v.map(obj) : [])

const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: true } as const
const SUMMARY_HEADERS = ['From', 'To', 'Cc', 'Subject', 'Date']
const MAX_BODY_CHARS = 50_000

function headersOf(payload: Obj): Record<string, string> {
  const out: Record<string, string> = {}
  for (const h of arr(payload.headers)) {
    if (typeof h.name === 'string' && typeof h.value === 'string' && SUMMARY_HEADERS.includes(h.name)) out[h.name.toLowerCase()] = h.value
  }
  return out
}

function decode(data: unknown): string {
  return typeof data === 'string' ? Buffer.from(data, 'base64url').toString('utf8') : ''
}

/** The readable text of a message: its text/plain parts, or its HTML with tags stripped when there are none. */
export function bodyText(payload: Obj, maxChars = MAX_BODY_CHARS): string {
  const plain: string[] = []
  const html: string[] = []
  const walk = (part: Obj) => {
    const mime = typeof part.mimeType === 'string' ? part.mimeType : ''
    if (mime === 'text/plain') plain.push(decode(obj(part.body).data))
    else if (mime === 'text/html') html.push(decode(obj(part.body).data))
    for (const child of arr(part.parts)) walk(child)
  }
  walk(payload)
  const text = plain.length > 0
    ? plain.join('\n')
    : html.join('\n').replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, ' ').replace(/[ \t]+/g, ' ')
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n[truncated]` : text
}

function message(m: Obj, withBody: boolean, maxChars = MAX_BODY_CHARS) {
  const payload = obj(m.payload)
  return {
    id: m.id, threadId: m.threadId, labelIds: Array.isArray(m.labelIds) ? m.labelIds : [], snippet: m.snippet ?? '',
    ...headersOf(payload),
    ...(withBody ? { body: bodyText(payload, maxChars) } : {}),
  }
}

/**
 * An in-house, read-only Gmail MCP server: four GET-only tools. The access token comes from the host, which refreshes
 * it; nothing here ever sees the refresh token or the client secret.
 */
export function createGmailMcpServer(deps: { get: GmailGet }): McpServer {
  const server = new McpServer({ name: 'arena-gmail', version: '1.0.0' })
  const run = async (fn: () => Promise<unknown>) => {
    try {
      return { content: [{ type: 'text' as const, text: JSON.stringify(await fn()) }] }
    } catch (e) {
      return { isError: true, content: [{ type: 'text' as const, text: e instanceof GmailError ? e.message : 'Gmail request failed' }] }
    }
  }

  server.registerTool('search_messages', {
    description: 'Search Gmail with Gmail search syntax (from:, subject:, after:, has:attachment …). Returns headers and snippets.',
    inputSchema: { query: z.string().min(1), maxResults: z.number().int().min(1).max(25).optional(), pageToken: z.string().optional() },
    annotations: READ,
  }, ({ query, maxResults, pageToken }) => run(async () => {
    const list = await deps.get('users/me/messages', { q: query, maxResults: maxResults ?? 10, pageToken })
    const messages = await Promise.all(arr(list.messages).map(async (m) =>
      message(await deps.get(`users/me/messages/${String(m.id)}`, { format: 'metadata', metadataHeaders: SUMMARY_HEADERS }), false)))
    return { messages, nextPageToken: list.nextPageToken ?? null, resultSizeEstimate: list.resultSizeEstimate ?? null }
  }))

  server.registerTool('get_message', {
    description: 'Read one Gmail message: headers and its text body.',
    inputSchema: { id: z.string().regex(GMAIL_ID) },
    annotations: READ,
  }, ({ id }) => run(async () => message(await deps.get(`users/me/messages/${id}`, { format: 'full' }), true)))

  server.registerTool('get_thread', {
    description: 'Read a Gmail thread: every message with headers and text body.',
    inputSchema: { id: z.string().regex(GMAIL_ID) },
    annotations: READ,
  }, ({ id }) => run(async () => {
    const thread = await deps.get(`users/me/threads/${id}`, { format: 'full' })
    return { id: thread.id, messages: arr(thread.messages).map((m) => message(m, true, 20_000)) }
  }))

  server.registerTool('list_labels', {
    description: 'List Gmail labels.',
    inputSchema: {},
    annotations: READ,
  }, () => run(async () => ({ labels: arr((await deps.get('users/me/labels')).labels).map((l) => ({ id: l.id, name: l.name, type: l.type })) })))

  return server
}
