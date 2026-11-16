import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import { DockerPlacementSummary, LocalRunCaution, RunSetup, WebSearchStatusLine } from '../../web/src/components/RunSetup.js'

describe('docker placement choice', () => {
  test('the docker settings offer protected or shared isolation, and App sends the choice', () => {
    const src = readFileSync('web/src/components/RunSetup.tsx', 'utf8')
    expect(src).toContain('id="setup-isolation"')
    expect(src).toContain('<DockerPlacementSummary')
    expect(readFileSync('web/src/App.tsx', 'utf8')).toContain('isolation: value.isolation')
  })

  test('the summary previews placement, refuses an impossible protected plan, and admits unknown capacity', () => {
    const html = renderToStaticMarkup(createElement(DockerPlacementSummary, {
      population: 7, maxContainers: 4, memory: '1g', cpus: 1, isolation: 'protected', concurrency: 8, capacity: null,
    }))
    expect(html).toContain('[1,5] [2,6] [3,7] [4]')
    expect(html).toContain('Protected isolation needs 7 containers for 7 agents')
    expect(html).toContain('Docker capacity could not be read')
    expect(html).toContain('4 containers × 1g + 4 gateways × 64m = 4.25 GiB memory, 5 CPUs')
  })

  test('population and parallel agents stay separate, and restarts between rounds are explained', () => {
    const html = renderToStaticMarkup(createElement(DockerPlacementSummary, {
      population: 7, maxContainers: 4, memory: '1g', cpus: 1, isolation: 'shared', concurrency: 3, capacity: null,
    }))
    expect(html).toContain('7 in the roster, up to 3 running at once')
    expect(html).toContain('never reduced silently')
    expect(html).toContain('Worker runtimes restart between rounds')
  })
})

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

  test('offers a seed strategies folder, and App sends it, blank as null', () => {
    expect(html).toContain('Seed strategies folder (optional)')
    expect(html).toContain('id="setup-seed-strategies"')
    expect(readFileSync('web/src/App.tsx', 'utf8')).toContain('seedStrategiesDir: value.seedStrategiesDir.trim() || null')
  })

  test('the export menu offers the markdown report', () => {
    const src = readFileSync('web/src/App.tsx', 'utf8')
    expect(src).toContain('<option value="md">Markdown report</option>')
    expect(src).toContain("v === 'json' || v === 'csv' || v === 'md'")
  })

  test('the credentials field cannot be mistaken for context', () => {
    const src = readFileSync('web/src/components/RunSetup.tsx', 'utf8')
    expect(src).toContain('Credentials file (auth.json)')
    expect(src).not.toContain('Auth file (bind-mounted read-only)')
  })
})

describe('web access', () => {
  test('a real sandbox offers the toggle, on by default, and App sends it', () => {
    const src = readFileSync('web/src/components/RunSetup.tsx', 'utf8')
    expect(src).toContain('id="setup-web"')
    expect(src).toContain('useState(true)')
    expect(src).toContain('docker workers still have no open network')
    expect(readFileSync('web/src/App.tsx', 'utf8')).toContain('webAccess: value.webAccess')
  })

  test('the status line names the configured provider and the Exa fallback mode', () => {
    const line = (status: Parameters<typeof WebSearchStatusLine>[0]['status']) => renderToStaticMarkup(createElement(WebSearchStatusLine, { status }))
    expect(line({ primary: { id: 'langsearch', name: 'LangSearch', configured: true }, fallback: { id: 'exa', name: 'Exa', mode: 'keyless' } }))
      .toContain('LangSearch (key configured), falling back to Exa without a key')
    expect(line({ primary: { id: 'langsearch', name: 'LangSearch', configured: false }, fallback: { id: 'exa', name: 'Exa', mode: 'keyed' } }))
      .toContain('Exa with your key only — set LANGSEARCH_API_KEY for LangSearch')
    expect(line(null)).toContain('could not be read')
  })
})

describe('local sandbox caution', () => {
  test('says local agents run as the operator and points to docker', () => {
    const html = renderToStaticMarkup(createElement(LocalRunCaution))
    expect(html).toContain('Local agents run as you on this computer')
    expect(html).toContain('your home folder included')
    expect(html).toContain('Use docker')
  })

  test('is not shown for the default mock sandbox', () => {
    expect(renderToStaticMarkup(createElement(RunSetup, { busy: false, error: null, onCreate: () => {} }))).not.toContain('Local agents run as you')
  })
})

describe('agent time limits in the setup form', () => {
  const html = renderToStaticMarkup(createElement(RunSetup, { busy: false, error: null, onCreate: () => {} }))
  test('offers a hard limit, blank for none, and the wrap-up time, an hour by default', () => {
    expect(html).toContain('Agent time limit (minutes)')
    expect(html).toMatch(/id="setup-agent-timeout"[^>]*placeholder="none"/)
    expect(html).toContain('Ask agents to wrap up after (minutes)')
    expect(html).toMatch(/id="setup-steer-after"[^>]*value="60"/)
  })
})
