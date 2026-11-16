/**
 * The team channel: CHANNEL.md in a collaboration workspace, and the engine side of it.
 *
 * Agents append entries through the post helper; the engine tails the file, records every new
 * entry for the round and queues each one into the sessions of the teammates it is for. The
 * file is writable by every agent, so nothing here trusts its shape: entries are recognised by
 * their header line, anything else is body text, and an edited old entry is not news.
 */

export const CHANNEL_FILE = 'CHANNEL.md'
/** Where PREPARE writes the post helper, inside the workspace's runtime plumbing. */
export const POST_HELPER_PATH = '.opencode/arena/post.mjs'

/** Who signs a post the operator writes from the dashboard. */
export const OPERATOR_AUTHOR = 'operator'

/**
 * How an entry signed `operator` that the engine did not write is recorded: the helper takes any
 * label, so a member could sign as the operator, and the record must not pass that off as theirs.
 */
export const UNVERIFIED_OPERATOR = 'operator (unverified)'

export const CHANNEL_PREAMBLE = [
  '# Team channel',
  '',
  'Messages between teammates, oldest first. Post with the helper; never edit this file by hand.',
  '',
].join('\n')

export interface ChannelEntry {
  author: string
  /** The one teammate an `@label` entry is addressed to; null for everybody. */
  target: string | null
  postedAt: string
  body: string
  /** Identity: header plus occurrence, so editing a body does not make it a new entry. */
  key: string
}

const LABEL = '[A-Za-z0-9._-]+'
const HEADER = new RegExp(`^### (${LABEL}) · (\\S+)(?: → @(${LABEL}))?\\s*$`)
const ROUND_LINE = /^## Round \d+\s*$/

/** One entry exactly as the helper writes it. */
export function formatEntry(author: string, body: string, opts: { target?: string | null; at?: Date } = {}): string {
  const at = (opts.at ?? new Date()).toISOString()
  const header = `### ${author} · ${at}${opts.target ? ` → @${opts.target}` : ''}`
  return `\n${header}\n${escapeBody(body)}\n`
}

/** Body lines that would read as an entry header or a round line are escaped, so a post cannot forge one. */
export function escapeBody(body: string): string {
  return body
    .replace(/\r\n?/g, '\n')
    .trim()
    .split('\n')
    .map((line) => (line.startsWith('### ') || ROUND_LINE.test(line) ? `\\${line}` : line))
    .join('\n')
}

/** The line PREPARE appends before a round starts; it separates rounds and is not an entry. */
export function roundLine(roundIdx: number): string {
  return `\n## Round ${roundIdx}\n`
}

export function parseChannel(text: string): ChannelEntry[] {
  const entries: ChannelEntry[] = []
  const seen = new Map<string, number>()
  let current: { author: string; target: string | null; postedAt: string; lines: string[] } | null = null
  const close = () => {
    if (!current) return
    const header = `${current.author}|${current.postedAt}|${current.target ?? ''}`
    const n = (seen.get(header) ?? 0) + 1
    seen.set(header, n)
    entries.push({
      author: current.author,
      target: current.target,
      postedAt: current.postedAt,
      body: current.lines.join('\n').trim(),
      key: `${header}#${n}`,
    })
    current = null
  }
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const m = HEADER.exec(line)
    if (m) {
      close()
      current = { author: m[1]!, postedAt: m[2]!, target: m[3] ?? null, lines: [] }
    } else if (ROUND_LINE.test(line)) {
      close()
    } else if (current) {
      current.lines.push(line)
    }
  }
  close()
  return entries
}

export interface ChannelLimits {
  /** How often the engine reads CHANNEL.md while agents work. */
  pollMs: number
  /** Least time between two deliveries to the same agent; entries in between are coalesced. */
  minGapMs: number
  /** Deliveries per agent per round; the last one says delivery has stopped. */
  maxDeliveriesPerAgent: number
  /** Characters of one entry's body delivered; the rest is left in the file. */
  maxCharsPerEntry: number
  /** Characters in one delivered message. */
  maxCharsPerDelivery: number
  /** Characters of CHANNEL.md read per poll (its tail). */
  maxFileChars: number
}

export const DEFAULT_CHANNEL_LIMITS: ChannelLimits = {
  pollMs: 2000,
  minGapMs: 15_000,
  maxDeliveriesPerAgent: 30,
  maxCharsPerEntry: 2000,
  maxCharsPerDelivery: 6000,
  maxFileChars: 1024 * 1024,
}

/** Mock runs finish in milliseconds, so their channel is read often and never held back. */
export const MOCK_CHANNEL_LIMITS: Partial<ChannelLimits> = { pollMs: 20, minGapMs: 0 }

/** Bodies stored per entry; the file keeps everything, the database a bounded copy. */
export const MAX_STORED_BODY_CHARS = 20_000

export interface ChannelMember {
  agentId: string
  label: string
}

export interface RecordedEntry extends ChannelEntry {
  /** Round-local order, starting at 1. */
  seq: number
  /** The member whose label wrote it; null for a label that is not on the team. */
  agentId: string | null
}

export interface ChannelTailOptions {
  /** CHANNEL.md as it is now, or null when it does not exist. */
  read: () => Promise<string | null>
  members: readonly ChannelMember[]
  /** Whether an agent is still working and may be sent messages. */
  isLive: (agentId: string) => boolean
  /** Queues `text` into the agent's session; false when it could not be delivered. */
  deliver: (agentId: string, text: string) => Promise<boolean>
  /** A new entry this round, in file order. */
  onEntry: (entry: RecordedEntry) => void
  /** The author an entry is recorded and forwarded under; its own header's label when absent. */
  relabel?: (entry: ChannelEntry) => string
  /** Entries delivered to one agent in one message. */
  onDelivered?: (agentId: string, seqs: number[]) => void
  limits?: Partial<ChannelLimits>
  now?: () => number
}

interface Recipient {
  pending: RecordedEntry[]
  deliveries: number
  lastAt: number | null
  closed: boolean
}

/**
 * Tails one round's channel. `prime` marks what the file already holds (earlier rounds) as
 * seen; `start` polls until `stop`; `drain` reads one last time without delivering.
 */
export class ChannelTail {
  private readonly limits: ChannelLimits
  private readonly now: () => number
  private seen = new Set<string>()
  private seq = 0
  private recipients = new Map<string, Recipient>()
  private byLabel: Map<string, string>
  private timer: ReturnType<typeof setInterval> | null = null
  private inFlight: Promise<void> | null = null

  constructor(private readonly opts: ChannelTailOptions) {
    this.limits = { ...DEFAULT_CHANNEL_LIMITS, ...opts.limits }
    this.now = opts.now ?? Date.now
    this.byLabel = new Map(opts.members.map((m) => [m.label, m.agentId]))
    for (const m of opts.members) this.recipients.set(m.agentId, { pending: [], deliveries: 0, lastAt: null, closed: false })
  }

  prime(text: string | null): void {
    for (const e of parseChannel(text ?? '')) this.seen.add(e.key)
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => { void this.poll(true) }, this.limits.pollMs)
    ;(this.timer as { unref?: () => void }).unref?.()
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    await this.inFlight
  }

  /** The final read at the barrier: every remaining entry is recorded, nothing is delivered. */
  async drain(): Promise<void> {
    await this.stop()
    await this.poll(false)
  }

  /** One read. Overlapping calls join the one already running. */
  poll(deliver: boolean): Promise<void> {
    if (this.inFlight) return this.inFlight
    const attempt = this.readOnce(deliver).finally(() => {
      if (this.inFlight === attempt) this.inFlight = null
    })
    this.inFlight = attempt
    return attempt
  }

  private async readOnce(deliver: boolean): Promise<void> {
    let text: string | null
    try {
      text = await this.opts.read()
    } catch {
      return
    }
    if (text === null) return
    if (text.length > this.limits.maxFileChars) text = text.slice(-this.limits.maxFileChars)
    for (const e of parseChannel(text)) {
      if (this.seen.has(e.key)) continue
      this.seen.add(e.key)
      const entry: RecordedEntry = { ...e, author: this.opts.relabel?.(e) ?? e.author, seq: ++this.seq, agentId: this.byLabel.get(e.author) ?? null }
      try {
        this.opts.onEntry(entry)
      } catch {
        /* recording must never stop the channel */
      }
      for (const m of this.opts.members) {
        if (m.label === entry.author) continue
        if (entry.target !== null && entry.target !== m.label) continue
        this.recipients.get(m.agentId)!.pending.push(entry)
      }
    }
    if (!deliver) return
    await Promise.all(this.opts.members.map((m) => this.flush(m.agentId)))
  }

  private async flush(agentId: string): Promise<void> {
    const r = this.recipients.get(agentId)!
    if (r.closed || r.pending.length === 0) return
    if (!this.opts.isLive(agentId)) {
      r.pending = []
      return
    }
    const at = this.now()
    if (r.lastAt !== null && at - r.lastAt < this.limits.minGapMs) return
    const last = r.deliveries + 1 >= this.limits.maxDeliveriesPerAgent
    const { text, seqs } = this.compose(r.pending, last)
    r.pending = []
    let ok = false
    try {
      ok = await this.opts.deliver(agentId, text)
    } catch {
      ok = false
    }
    if (!ok) return
    r.deliveries++
    r.lastAt = at
    if (last) r.closed = true
    try {
      this.opts.onDelivered?.(agentId, seqs)
    } catch {
      /* recording must never stop the channel */
    }
  }

  private compose(entries: readonly RecordedEntry[], last: boolean): { text: string; seqs: number[] } {
    const parts: string[] = []
    const seqs: number[] = []
    let used = 0
    let omitted = 0
    for (const e of entries) {
      const body = e.body.length > this.limits.maxCharsPerEntry
        ? `${e.body.slice(0, this.limits.maxCharsPerEntry)}\n[… cut here; the full post is in ${CHANNEL_FILE}]`
        : e.body
      const block = `### ${e.author} · ${e.postedAt}${e.target ? ` → @${e.target}` : ''}\n${body}`
      if (parts.length > 0 && used + block.length > this.limits.maxCharsPerDelivery) {
        omitted++
        continue
      }
      parts.push(block)
      seqs.push(e.seq)
      used += block.length
    }
    return {
      seqs,
      text: [
        `New on the team channel (${CHANNEL_FILE}):`,
        '',
        parts.join('\n\n'),
        ...(omitted > 0 ? ['', `${omitted} more new post(s) did not fit here; read ${CHANNEL_FILE}.`] : []),
        '',
        last
          ? `Channel messages will no longer be forwarded to you this round; read ${CHANNEL_FILE} for anything newer.`
          : 'Keep working; reply with the post helper if you need to. Never edit the channel file by hand.',
      ].join('\n'),
    }
  }
}

/**
 * The post helper PREPARE writes to POST_HELPER_PATH. Plain Node (every runtime here has it:
 * the host for local runs, the agent image for docker). One `O_APPEND` write per entry under a
 * `mkdir` lock with a bounded wait, so concurrent posts never lose each other.
 */
export const POST_HELPER_SOURCE = `// Team channel helper. Usage:
//   node post.mjs <your-label> [@teammate] <message...>     (or pipe the message on stdin)
import { appendFileSync, mkdirSync, readFileSync, rmdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const LABEL = /^[A-Za-z0-9._-]+$/
const args = process.argv.slice(2)
const label = args.shift()
if (!label || !LABEL.test(label)) {
  console.error('usage: node post.mjs <your-label> [@teammate] <message>')
  process.exit(2)
}
let target = null
if (args[0] && args[0].startsWith('@')) target = args.shift().slice(1)
if (target !== null && !LABEL.test(target)) {
  console.error('usage: node post.mjs <your-label> [@teammate] <message>')
  process.exit(2)
}
let body = args.join(' ')
if (body.trim() === '' && !process.stdin.isTTY) body = readFileSync(0, 'utf8')
body = body.replace(/\\r\\n?/g, '\\n').trim()
if (body === '') {
  console.error('nothing to post')
  process.exit(2)
}
body = body.split('\\n').map((l) => (l.startsWith('### ') || /^## Round \\d+\\s*$/.test(l) ? '\\\\' + l : l)).join('\\n')

const file = fileURLToPath(new URL('../../${CHANNEL_FILE}', import.meta.url))
const lock = file + '.lock'
const pause = new Int32Array(new SharedArrayBuffer(4))
const deadline = Date.now() + 5000
let locked = false
while (!locked) {
  try {
    mkdirSync(lock)
    locked = true
  } catch (e) {
    if (e.code !== 'EEXIST') break
    try {
      if (Date.now() - statSync(lock).mtimeMs > 10000) { rmdirSync(lock); continue }
    } catch {}
    if (Date.now() > deadline) break
    Atomics.wait(pause, 0, 0, 25)
  }
}
try {
  const header = '### ' + label + ' · ' + new Date().toISOString() + (target ? ' → @' + target : '')
  appendFileSync(file, '\\n' + header + '\\n' + body + '\\n')
} finally {
  if (locked) { try { rmdirSync(lock) } catch {} }
}
console.log('posted to ${CHANNEL_FILE}')
`
