// WHY escape-first: HTML is escaped BEFORE any markup runs, and fenced/inline
// code is extracted to placeholders BEFORE bold/italic — so raw tags can never
// reach the output as tags and `**` inside code never fires. Pinned by the
// XSS tests in test/web/markdown.test.ts. Closed subset: no links, images,
// tables, or raw HTML are ever generated (structurally impossible, not filtered).
export function renderMarkdown(md: string): string {
  if (md === '') return ''

  // 1. Escape HTML first (& first so entity semicolons survive intact).
  let text = md
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

  // 2. Extract fenced blocks, then inline code, to placeholders (code content is
  // already escaped above, so restoring it later is safe).
  const fences: string[] = []
  text = text.replace(/```[\s\S]*?```/g, (m) => {
    let code = m.slice(3, -3)
    if (code.includes('\n')) code = code.slice(code.indexOf('\n') + 1)
    if (code.endsWith('\n')) code = code.slice(0, -1)
    fences.push(code)
    return `\u0000FENCE${fences.length - 1}\u0000`
  })
  const spans: string[] = []
  text = text.replace(/`([^`\n]+)`/g, (_, code: string) => {
    spans.push(code)
    return `\u0000SPAN${spans.length - 1}\u0000`
  })

  // Inline markup on code-free text: bold before italic (order matters).
  const inline = (s: string): string =>
    s
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')

  // 3. Block structure, line by line (note: `>` arrives here as `&gt;`).
  const out: string[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (line.trim() === '') continue
    const fence = line.match(/^\u0000FENCE(\d+)\u0000$/)
    if (fence) {
      out.push(`<pre><code>${fences[Number(fence[1])]}</code></pre>`)
      continue
    }
    const heading = line.match(/^(#{1,3}) (.*)$/)
    if (heading) {
      out.push(`<h${heading[1]!.length}>${inline(heading[2]!)}</h${heading[1]!.length}>`)
      continue
    }
    if (line === '---') {
      out.push('<hr />')
      continue
    }
    if (/^[-*] /.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^[-*] /.test(lines[i]!)) { items.push(inline(lines[i]!.slice(2))); i++ }
      out.push(`<ul>${items.map((t) => `<li>${t}</li>`).join('')}</ul>`)
      i--
      continue
    }
    if (line.startsWith('&gt;')) {
      const quotes: string[] = []
      while (i < lines.length && lines[i]!.startsWith('&gt;')) {
        quotes.push(inline(lines[i]!.replace(/^&gt; ?/, '')))
        i++
      }
      out.push(`<blockquote>${quotes.join('\n')}</blockquote>`)
      i--
      continue
    }
    out.push(`<p>${inline(line)}</p>`)
  }

  // 4. Restore inline code placeholders.
  return out.join('\n').replace(/\u0000SPAN(\d+)\u0000/g, (_, n: string) => `<code>${spans[Number(n)]}</code>`)
}
