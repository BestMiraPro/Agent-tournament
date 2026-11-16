/**
 * A minimal HTML → markdown-ish text extractor for `web_fetch`.
 *
 * In-house rather than a dependency: the readable libraries each bring a parser tree of several
 * packages into the process that holds the search keys, for output an agent reads as plain text.
 * This is one linear pass (input is capped upstream at 2 MiB): no backtracking regex runs over the
 * document, an unterminated tag ends the scan, and skipped elements are tracked by depth.
 *
 * Kept: the title, headings as `#`, paragraphs, list items as `-`, links as `[text](url)` with
 * http(s) targets made absolute, `pre` blocks fenced, table rows as `| a | b |`.
 * Dropped: scripts, styles, head, navigation, asides, footers, forms, embedded documents, images.
 */

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', copy: '©', reg: '®', trade: '™',
  middot: '·', bull: '•', times: '×', divide: '÷', euro: '€', pound: '£', yen: '¥', cent: '¢', deg: '°',
  plusmn: '±', sect: '§', para: '¶', shy: '', larr: '←', rarr: '→', uarr: '↑', darr: '↓', le: '≤', ge: '≥',
  ne: '≠', minus: '−', prime: '′', Prime: '″', thinsp: ' ', ensp: ' ', emsp: ' ',
}

export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text
  return text.replace(/&(#[xX][0-9a-fA-F]{1,8}|#[0-9]{1,8}|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      const valid = code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
      return valid ? String.fromCodePoint(code) : '�'
    }
    return NAMED[body] ?? whole
  })
}

/** Elements whose whole subtree is dropped. */
const SKIP = new Set(['head', 'nav', 'aside', 'footer', 'form', 'svg', 'math', 'iframe', 'object', 'template', 'noscript', 'canvas', 'select', 'button', 'dialog'])
/** Elements whose content is raw text up to their closing tag; never shown. */
const RAW = new Set(['script', 'style', 'title', 'textarea'])
const PARAGRAPH = new Set(['p', 'div', 'section', 'article', 'main', 'header', 'blockquote', 'figure', 'figcaption', 'address', 'ul', 'ol', 'dl', 'table', 'details', 'hr', 'body'])
const LINE = new Set(['dt', 'dd', 'summary', 'caption'])

class Writer {
  readonly parts: string[] = []
  private pending = 0
  private lineEmpty = true
  private spaceOwed = false

  text(s: string): void {
    const collapsed = s.replace(/[ \t\n\r\f ]+/g, ' ')
    if (collapsed === '') return
    let t = collapsed
    if (t.startsWith(' ')) {
      if (!this.lineEmpty) this.spaceOwed = true
      t = t.slice(1)
    }
    if (t === '') return
    const trailing = t.endsWith(' ')
    if (trailing) t = t.slice(0, -1)
    this.flush()
    if (this.spaceOwed && !this.lineEmpty) this.parts.push(' ')
    this.parts.push(t)
    this.lineEmpty = false
    this.spaceOwed = trailing
  }

  /** Verbatim text (inside `pre`). */
  raw(s: string): void {
    if (s === '') return
    this.flush()
    this.parts.push(s)
    this.lineEmpty = s.endsWith('\n')
    this.spaceOwed = false
  }

  /** A line prefix such as `# ` or `- `: leading spaces of the text that follows are dropped. */
  prefix(s: string): void {
    this.flush()
    this.parts.push(s)
    this.lineEmpty = true
    this.spaceOwed = false
  }

  newline(n: 1 | 2): void {
    if (this.parts.length === 0) return
    this.pending = Math.max(this.pending, n)
    this.spaceOwed = false
  }

  private flush(): void {
    if (this.pending === 0) return
    this.parts.push('\n'.repeat(this.pending))
    this.pending = 0
    this.lineEmpty = true
  }
}

function attribute(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag)
  return m ? decodeEntities(m[1] ?? m[2] ?? m[3] ?? '') : null
}

function linkTarget(href: string | null, base: URL | null): string | null {
  if (!href) return null
  let url: URL
  try {
    url = base ? new URL(href, base) : new URL(href)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (base && url.hash && url.href.slice(0, -url.hash.length) === base.href.replace(/#.*$/, '')) return null
  return url.href
}

export function htmlToText(html: string, baseUrl?: string): { title: string | null; text: string } {
  let base: URL | null = null
  try {
    base = baseUrl ? new URL(baseUrl) : null
  } catch {
    base = null
  }
  const lower = html.toLowerCase()
  const titleAt = lower.indexOf('<title')
  let title: string | null = null
  if (titleAt !== -1) {
    const open = lower.indexOf('>', titleAt)
    const close = open === -1 ? -1 : lower.indexOf('</title', open)
    if (close !== -1) title = decodeEntities(html.slice(open + 1, close)).replace(/\s+/g, ' ').trim() || null
  }

  const w = new Writer()
  const skip: string[] = []
  const links: { mark: number; href: string | null }[] = []
  let pre = 0
  let preFresh = false
  let cell = 0
  const n = html.length
  let i = 0

  const emit = (s: string) => {
    if (skip.length > 0 || s === '') return
    if (pre > 0) {
      let t = decodeEntities(s)
      if (preFresh && t.startsWith('\n')) t = t.slice(1)
      preFresh = false
      w.raw(t)
    } else {
      w.text(decodeEntities(s))
    }
  }

  while (i < n) {
    const lt = html.indexOf('<', i)
    if (lt === -1) {
      emit(html.slice(i))
      break
    }
    if (lt > i) emit(html.slice(i, lt))
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4)
      i = end === -1 ? n : end + 3
      continue
    }
    if (html[lt + 1] === '!' || html[lt + 1] === '?') {
      const end = html.indexOf('>', lt)
      i = end === -1 ? n : end + 1
      continue
    }
    const head = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]{0,31})/.exec(html.slice(lt, lt + 40))
    if (!head) {
      emit('<')
      i = lt + 1
      continue
    }
    const end = html.indexOf('>', lt)
    if (end === -1) break
    const tag = html.slice(lt, end + 1)
    i = end + 1
    const closing = head[1] === '/'
    const name = head[2]!.toLowerCase()

    if (RAW.has(name)) {
      if (closing) continue
      const close = lower.indexOf(`</${name}`, i)
      if (close === -1) break
      const after = html.indexOf('>', close)
      i = after === -1 ? n : after + 1
      continue
    }

    if (skip.length > 0) {
      const top = skip[skip.length - 1]
      if (name === 'body' && !closing && top === 'head') skip.length = 0
      else if (name === top && !closing && !tag.endsWith('/>')) skip.push(name)
      else if (name === top && closing) skip.pop()
      continue
    }
    if (SKIP.has(name)) {
      if (!closing && !tag.endsWith('/>')) skip.push(name)
      continue
    }

    const level = /^h([1-6])$/.exec(name)
    if (level) {
      w.newline(2)
      if (!closing) w.prefix(`${'#'.repeat(Number(level[1]))} `)
    } else if (name === 'li') {
      w.newline(1)
      if (!closing) w.prefix('- ')
    } else if (name === 'br') {
      if (pre > 0) w.raw('\n')
      else w.newline(1)
    } else if (name === 'pre') {
      if (!closing) {
        w.newline(2)
        w.raw('```\n')
        pre++
        preFresh = true
      } else if (pre > 0) {
        pre--
        w.raw('\n```')
        w.newline(2)
      }
    } else if (name === 'code') {
      if (pre === 0) w.text('`')
    } else if (name === 'tr') {
      if (!closing) {
        w.newline(1)
        cell = 0
      } else {
        if (cell > 0) w.text(' |')
        w.newline(1)
      }
    } else if (name === 'td' || name === 'th') {
      if (!closing) {
        w.text(cell === 0 ? '| ' : ' | ')
        cell++
      }
    } else if (name === 'a') {
      if (!closing) {
        links.push({ mark: w.parts.length, href: linkTarget(attribute(tag, 'href'), base) })
      } else {
        const link = links.pop()
        if (link?.href) {
          const inner = w.parts.splice(link.mark).join('')
          const lead = /^\s*/.exec(inner)![0]
          const label = inner.trim().replace(/\s*\n+\s*/g, ' ')
          w.parts.push(label ? `${lead}[${label}](${link.href})` : inner)
        }
      }
    } else if (PARAGRAPH.has(name)) {
      w.newline(2)
    } else if (LINE.has(name)) {
      w.newline(1)
    }
  }

  return { title, text: w.parts.join('').replace(/[ \t]+$/gm, '').trim() }
}
