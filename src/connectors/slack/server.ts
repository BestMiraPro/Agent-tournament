import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

/**
 * The Slack Web API methods this server can call: reads only. The HTTP client refuses anything else before a request
 * is made, and no tool here calls anything else, so no Slack write is reachable from this code at all.
 */
export const SLACK_READ_METHODS = [
  'search.messages',
  'conversations.list',
  'conversations.history',
  'conversations.replies',
  'users.info',
  'users.list',
] as const
export type SlackReadMethod = (typeof SLACK_READ_METHODS)[number]

export type SlackCall = (method: SlackReadMethod, params: Record<string, string | number | undefined>) => Promise<Record<string, unknown>>

export const SLACK_API_BASE = 'https://slack.com/api'

/**
 * A Slack Web API client limited to SLACK_READ_METHODS, sending GET requests with the token as a bearer header. The
 * token is read per call so a rotated one is picked up; it never appears in a URL or an error.
 */
export function slackApi(opts: { token: () => string | Promise<string>; fetch?: typeof fetch }): SlackCall {
  const doFetch = opts.fetch ?? fetch
  return async (method, params) => {
    if (!(SLACK_READ_METHODS as readonly string[]).includes(method)) {
      throw new Error(`Slack method ${String(method)} is not a read method this connector may call`)
    }
    const query = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') query.set(k, String(v))
    const res = await doFetch(`${SLACK_API_BASE}/${method}?${query}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${await opts.token()}` },
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) throw new SlackError(`http_${res.status}`)
    const body = (await res.json()) as Record<string, unknown>
    // Slack's error field is a fixed identifier (`channel_not_found`), safe to repeat.
    if (body.ok !== true) throw new SlackError(typeof body.error === 'string' ? body.error.slice(0, 80) : 'unknown_error')
    return body
  }
}

export class SlackError extends Error {
  constructor(readonly code: string) {
    super(`Slack refused the request: ${code}`)
  }
}

const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: true } as const
const asText = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] })
const failure = (e: unknown) => ({
  isError: true,
  content: [{ type: 'text' as const, text: e instanceof SlackError ? e.message : 'Slack request failed' }],
})

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {})
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? v.map(obj) : [])
const cursorOf = (body: Obj) => obj(body.response_metadata).next_cursor || null
const message = (m: Obj) => ({
  ts: m.ts, user: m.user ?? m.username ?? null, text: m.text, thread_ts: m.thread_ts ?? null,
  reply_count: m.reply_count ?? 0,
})

/**
 * An in-house, read-only Slack MCP server. Six tools, each a single read method. Works best with a user token (search
 * needs one); every tool is annotated read-only and the bridge's lock exposes exactly these names.
 */
export function createSlackMcpServer(deps: { call: SlackCall }): McpServer {
  const server = new McpServer({ name: 'arena-slack', version: '1.0.0' })
  const run = async (fn: () => Promise<unknown>) => {
    try {
      return asText(await fn())
    } catch (e) {
      return failure(e)
    }
  }

  server.registerTool('search_messages', {
    description: 'Search Slack messages the token can see. Supports Slack search syntax (in:#channel, from:@user, before:, after:).',
    inputSchema: { query: z.string().min(1), count: z.number().int().min(1).max(100).optional(), page: z.number().int().min(1).optional() },
    annotations: READ,
  }, ({ query, count, page }) => run(async () => {
    const body = await deps.call('search.messages', { query, count: count ?? 20, page })
    const messages = obj(body.messages)
    return {
      total: obj(messages.paging).total ?? null,
      matches: arr(messages.matches).map((m) => ({
        channel: obj(m.channel).name ?? obj(m.channel).id ?? null, ...message(m), permalink: m.permalink ?? null,
      })),
    }
  }))

  server.registerTool('list_channels', {
    description: 'List Slack conversations the token can see.',
    inputSchema: {
      types: z.string().optional().describe('Comma-separated: public_channel, private_channel, mpim, im'),
      limit: z.number().int().min(1).max(200).optional(),
      cursor: z.string().optional(),
    },
    annotations: READ,
  }, ({ types, limit, cursor }) => run(async () => {
    const body = await deps.call('conversations.list', { types: types ?? 'public_channel', limit: limit ?? 100, cursor, exclude_archived: 'true' })
    return {
      channels: arr(body.channels).map((c) => ({
        id: c.id, name: c.name ?? null, is_private: c.is_private ?? false, num_members: c.num_members ?? null,
        topic: obj(c.topic).value ?? '', purpose: obj(c.purpose).value ?? '',
      })),
      next_cursor: cursorOf(body),
    }
  }))

  server.registerTool('read_channel', {
    description: 'Read recent messages in a Slack conversation, newest first.',
    inputSchema: {
      channel: z.string().min(1), limit: z.number().int().min(1).max(200).optional(), cursor: z.string().optional(),
      oldest: z.string().optional(), latest: z.string().optional(),
    },
    annotations: READ,
  }, ({ channel, limit, cursor, oldest, latest }) => run(async () => {
    const body = await deps.call('conversations.history', { channel, limit: limit ?? 50, cursor, oldest, latest })
    return { messages: arr(body.messages).map(message), has_more: body.has_more === true, next_cursor: cursorOf(body) }
  }))

  server.registerTool('read_thread', {
    description: 'Read the replies in a Slack thread.',
    inputSchema: { channel: z.string().min(1), ts: z.string().min(1), limit: z.number().int().min(1).max(200).optional(), cursor: z.string().optional() },
    annotations: READ,
  }, ({ channel, ts, limit, cursor }) => run(async () => {
    const body = await deps.call('conversations.replies', { channel, ts, limit: limit ?? 100, cursor })
    return { messages: arr(body.messages).map(message), has_more: body.has_more === true, next_cursor: cursorOf(body) }
  }))

  server.registerTool('get_user', {
    description: 'Look up a Slack user by id.',
    inputSchema: { user: z.string().min(1) },
    annotations: READ,
  }, ({ user }) => run(async () => {
    const u = obj((await deps.call('users.info', { user })).user)
    return { id: u.id, name: u.name, real_name: u.real_name ?? null, title: obj(u.profile).title ?? null, tz: u.tz ?? null, is_bot: u.is_bot ?? false }
  }))

  server.registerTool('list_users', {
    description: 'List members of the Slack workspace.',
    inputSchema: { limit: z.number().int().min(1).max(200).optional(), cursor: z.string().optional() },
    annotations: READ,
  }, ({ limit, cursor }) => run(async () => {
    const body = await deps.call('users.list', { limit: limit ?? 100, cursor })
    return {
      members: arr(body.members).map((u) => ({ id: u.id, name: u.name, real_name: u.real_name ?? null, is_bot: u.is_bot ?? false, deleted: u.deleted ?? false })),
      next_cursor: cursorOf(body),
    }
  }))

  return server
}
