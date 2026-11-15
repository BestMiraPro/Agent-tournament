import { describe, expect, test } from 'vitest'
import { decodeEntities, htmlToText } from '../../../src/connectors/web/html-to-text.js'

describe('htmlToText', () => {
  test('keeps the readable structure: title, headings, paragraphs, lists, links', () => {
    const html = `<!doctype html><html><head><title>Rust &amp; Go</title><style>p{color:red}</style>
      <script>var secret = "x"</script></head><body>
      <nav><a href="/">Home</a> | <a href="/about">About</a></nav>
      <h1>Memory   safety</h1>
      <p>Both languages are <b>safe</b>.<br>Second line.</p>
      <ul><li>Rust: <a href="/rust?x=1">ownership</a></li><li>Go: GC</li></ul>
      <footer>© 2026 Someone</footer>
      </body></html>`
    const out = htmlToText(html, 'https://example.com/post/1')
    expect(out.title).toBe('Rust & Go')
    expect(out.text).toBe([
      '# Memory safety',
      '',
      'Both languages are safe.',
      'Second line.',
      '',
      '- Rust: [ownership](https://example.com/rust?x=1)',
      '- Go: GC',
    ].join('\n'))
    expect(out.text).not.toContain('secret')
    expect(out.text).not.toContain('color:red')
    expect(out.text).not.toContain('About')
  })

  test('preformatted code keeps its whitespace inside a fence; tables become rows of cells', () => {
    const html = '<pre><code>fn main() {\n    println!("hi &lt;3");\n}</code></pre><table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table>'
    expect(htmlToText(html).text).toBe('```\nfn main() {\n    println!("hi <3");\n}\n```\n\n| a | b |\n| 1 | 2 |')
  })

  test('links that are not http(s), or point at the page itself, stay plain text', () => {
    const html = '<p><a href="javascript:alert(1)">click</a> <a href="#top">top</a> <a href="mailto:a@b.c">mail</a></p>'
    expect(htmlToText(html, 'https://example.com/').text).toBe('click top mail')
  })

  test('comments, nested svg and unclosed tags do not leak or hang', () => {
    const html = '<!-- <p>hidden</p> --><svg><svg><text>drawn</text></svg><text>more</text></svg><p>shown<p>also <i>shown'
    expect(htmlToText(html).text).toBe('shown\n\nalso shown')
  })

  test('a large hostile input finishes quickly (linear scan)', () => {
    const html = `${'<div '.repeat(50_000)}${'<'.repeat(200_000)}${'&#'.repeat(100_000)}`
    const started = Date.now()
    htmlToText(html)
    expect(Date.now() - started).toBeLessThan(2000)
  })
})

describe('decodeEntities', () => {
  test('numeric and common named entities; unknown ones stay as written', () => {
    expect(decodeEntities('&lt;a&gt; &amp;amp; &quot;q&quot; &#39;s&#x27; &nbsp;&mdash;&hellip; &notanentity; &#x1F600;'))
      .toBe('<a> &amp; "q" \'s\'  —… &notanentity; 😀')
    expect(decodeEntities('&#0; &#x110000;')).toBe('� �')
  })
})
