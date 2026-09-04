import { describe, expect, test } from 'vitest'
import { renderMarkdown } from '../../web/src/lib/markdown.js'

describe('renderMarkdown escape-first', () => {
  test('script tag renders inert: no <script, escaped text present', () => {
    const out = renderMarkdown('<script>alert(1)</script>')
    expect(out).not.toContain('<script')
    expect(out).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  test('img-onerror renders inert: no <img and no tag carrying onerror, escaped text present', () => {
    // NOTE: `onerror=` itself survives as inert escaped text (unsupported syntax
    // renders as plain text per spec); the pin is that no TAG carries it.
    const out = renderMarkdown('<img src=x onerror=alert(1)>')
    expect(out).not.toContain('<img')
    expect(out).not.toMatch(/<[^>]*\bonerror=/)
    expect(out).toContain('&lt;img')
  })
})

describe('renderMarkdown supported constructs', () => {
  test('fenced block with language tag → pre/code, language tag dropped', () => {
    const out = renderMarkdown('```js\nconsole.log(1)\n```')
    expect(out).toContain('<pre><code>console.log(1)</code></pre>')
  })

  test('# → h1', () => {
    expect(renderMarkdown('# Hello')).toContain('<h1>Hello</h1>')
  })

  test('## → h2', () => {
    expect(renderMarkdown('## Hello')).toContain('<h2>Hello</h2>')
  })

  test('### → h3', () => {
    expect(renderMarkdown('### Hello')).toContain('<h3>Hello</h3>')
  })

  test('#### stays literal text, no h4', () => {
    const out = renderMarkdown('#### Hello')
    expect(out).not.toContain('<h4')
    expect(out).toContain('#### Hello')
  })

  test('**x** → strong', () => {
    expect(renderMarkdown('a **bold** b')).toContain('a <strong>bold</strong> b')
  })

  test('*x* → em', () => {
    expect(renderMarkdown('a *ital* b')).toContain('a <em>ital</em> b')
  })

  test('inline code → code element', () => {
    expect(renderMarkdown('a `x` b')).toContain('a <code>x</code> b')
  })

  test('consecutive -/* lines → a single ul', () => {
    const out = renderMarkdown('- a\n- b\n* c')
    expect(out).toContain('<ul><li>a</li><li>b</li><li>c</li></ul>')
    expect(out.match(/<ul>/g)).toHaveLength(1)
  })

  test('consecutive > lines merge into one blockquote', () => {
    const out = renderMarkdown('> a\n> b')
    expect(out).toContain('<blockquote>a\nb</blockquote>')
  })

  test('a line that is exactly --- → hr', () => {
    expect(renderMarkdown('---')).toContain('<hr />')
  })

  test('plain text → paragraph', () => {
    expect(renderMarkdown('just words')).toContain('<p>just words</p>')
  })
})

describe('renderMarkdown code-span protection', () => {
  test('** inside backticks never becomes strong', () => {
    const out = renderMarkdown('`**not bold**`')
    expect(out).not.toContain('<strong>')
    expect(out).toContain('<code>**not bold**</code>')
  })

  test('** inside a fence never becomes strong', () => {
    const out = renderMarkdown('```\n**not bold**\n```')
    expect(out).not.toContain('<strong>')
    expect(out).toContain('<pre><code>**not bold**</code></pre>')
  })
})

describe('renderMarkdown unsupported stays plain text', () => {
  test('[x](http://y) → text, no <a', () => {
    const out = renderMarkdown('[x](http://y)')
    expect(out).not.toContain('<a')
    expect(out).toContain('[x](http://y)')
  })

  test('![a](b) → text, no <img', () => {
    const out = renderMarkdown('![a](b)')
    expect(out).not.toContain('<img')
    expect(out).toContain('![a](b)')
  })

  test('| a | b | → text, no <table', () => {
    const out = renderMarkdown('| a | b |')
    expect(out).not.toContain('<table')
    expect(out).toContain('| a | b |')
  })

  test('empty string → empty string', () => {
    expect(renderMarkdown('')).toBe('')
  })
})
