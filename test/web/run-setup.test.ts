import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import { RunSetup } from '../../web/src/components/RunSetup.js'

/**
 * The September 14 run: a research folder typed into "Auth file" was mounted where the
 * credentials belong. The form now has a field for exactly that intent, and the
 * credentials field says what it is.
 */
describe('run setup form', () => {
  const html = renderToStaticMarkup(createElement(RunSetup, { busy: false, error: null, onCreate: () => {} }))

  test('offers a context folder and says what it is for and what not to put there', () => {
    expect(html).toContain('Context folder (read-only, optional)')
    expect(html).toContain('id="setup-context"')
    expect(html).toContain('do not put secrets')
  })

  test('App sends the context folder, blank as null', () => {
    expect(readFileSync('web/src/App.tsx', 'utf8')).toContain('contextDir: value.contextDir.trim() || null')
  })

  test('the credentials field cannot be mistaken for context', () => {
    const src = readFileSync('web/src/components/RunSetup.tsx', 'utf8')
    expect(src).toContain('Credentials file (auth.json)')
    expect(src).not.toContain('Auth file (bind-mounted read-only)')
  })
})
