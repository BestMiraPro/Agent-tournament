import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { readWebSearchKeys, webSearchStatus, WEB_KEY_ENV } from '../../../src/connectors/web/config.js'

let dir: string | null = null
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = null })

function envFile(text: string): string {
  dir = mkdtempSync(join(tmpdir(), 'web-config-'))
  const path = join(dir, '.env')
  writeFileSync(path, text)
  return path
}

describe('readWebSearchKeys', () => {
  test('the environment wins over the .env file', () => {
    const file = envFile('LANGSEARCH_API_KEY=from-file\nEXA_API_KEY=exa-file\n')
    expect(readWebSearchKeys({ env: { LANGSEARCH_API_KEY: 'from-env' }, envFile: file })).toEqual({ langsearch: 'from-env', exa: 'exa-file' })
  })

  test('reads only the two keys from .env, with export, quotes and comments', () => {
    const file = envFile([
      '# keys for web search',
      'export LANGSEARCH_API_KEY="sk-quoted"',
      "EXA_API_KEY='exa single' # trailing comment",
      'OTHER=ignored',
      '',
    ].join('\n'))
    expect(readWebSearchKeys({ env: {}, envFile: file })).toEqual({ langsearch: 'sk-quoted', exa: 'exa single' })
  })

  test('blank values and a missing file mean no key', () => {
    expect(readWebSearchKeys({ env: { LANGSEARCH_API_KEY: '  ' }, envFile: '/nonexistent/.env' })).toEqual({ langsearch: null, exa: null })
  })

  test('names the variables the spawned OpenCode server must not inherit', () => {
    expect(WEB_KEY_ENV).toEqual(['LANGSEARCH_API_KEY', 'EXA_API_KEY'])
  })
})

describe('webSearchStatus', () => {
  test('says which provider is configured and how Exa is reached, never the keys', () => {
    expect(webSearchStatus({ langsearch: 'secret', exa: null })).toEqual({
      primary: { id: 'langsearch', name: 'LangSearch', configured: true },
      fallback: { id: 'exa', name: 'Exa', mode: 'keyless' },
    })
    const none = webSearchStatus({ langsearch: null, exa: 'secret' })
    expect(none).toEqual({
      primary: { id: 'langsearch', name: 'LangSearch', configured: false },
      fallback: { id: 'exa', name: 'Exa', mode: 'keyed' },
    })
    expect(JSON.stringify(none)).not.toContain('secret')
  })
})
