import { describe, expect, test } from 'vitest'
import { classifyTool, exposedToolNames, policySubjectFor, type UpstreamTool } from '../../src/connectors/policy.js'
import { GMAIL_READ_TOOLS, READ_VERBS, SLACK_READ_TOOLS, WRITE_VERBS, lockFor } from '../../src/connectors/presets.js'
import { assertConnectorId } from '../../src/connectors/types.js'

const tool = (name: string, readOnlyHint?: boolean): UpstreamTool => ({
  name,
  inputSchema: { type: 'object' },
  ...(readOnlyHint === undefined ? {} : { annotations: { readOnlyHint } }),
})

/** Every write-shaped tool a Slack or Gmail server could plausibly offer, read-only annotation or not. */
const HOSTILE_WRITES = [
  'send_message', 'post_message', 'chat_postMessage', 'reply', 'reply_to_thread', 'add_reaction', 'react',
  'schedule_message', 'create_draft', 'update_draft', 'send_draft', 'label_message', 'modify_labels', 'delete_message',
  'trash_thread', 'archive_channel', 'mark_read', 'upload_file', 'invite_user', 'forward', 'set_topic',
]

describe('locked connectors (Slack, Gmail)', () => {
  for (const kind of ['slack', 'gmail'] as const) {
    const allow = kind === 'slack' ? SLACK_READ_TOOLS : GMAIL_READ_TOOLS
    const upstream = [
      ...allow.map((n) => tool(n, true)),
      // Annotated read-only on purpose: an annotation must never widen a locked connector.
      ...HOSTILE_WRITES.map((n) => tool(n, true)),
      ...HOSTILE_WRITES.map((n) => tool(`${n}_v2`)),
    ]

    test(`${kind}: no stored policy, run opt-in or annotation exposes a write tool`, () => {
      const policies = [
        { disabledTools: [], writeTools: [] },
        { disabledTools: [], writeTools: HOSTILE_WRITES },
        { disabledTools: ['nope'], writeTools: [...HOSTILE_WRITES, ...allow] },
      ]
      const optIns = [[], HOSTILE_WRITES, [...HOSTILE_WRITES, 'send_message_v2']]
      for (const policy of policies) {
        for (const runWriteOptIns of optIns) {
          const subject = policySubjectFor({ kind, policy })
          const exposed = exposedToolNames(subject, upstream, runWriteOptIns)
          expect([...exposed].sort()).toEqual([...allow].sort())
          for (const name of HOSTILE_WRITES) {
            expect(exposed.has(name)).toBe(false)
            expect(classifyTool(subject, tool(name, true))).toBe('locked')
          }
        }
      }
    })

    test(`${kind}: the operator can switch read tools off, never on beyond the allowlist`, () => {
      const subject = policySubjectFor({ kind, policy: { disabledTools: [allow[0]!], writeTools: [] } })
      const exposed = exposedToolNames(subject, upstream, [])
      expect(exposed.has(allow[0]!)).toBe(false)
      expect(exposed.size).toBe(allow.length - 1)
    })

    test(`${kind}: every allowlisted tool starts with a read verb and names no write verb`, () => {
      for (const name of allow) {
        const words = name.split('_')
        expect(READ_VERBS).toContain(words[0])
        for (const word of words) expect(WRITE_VERBS).not.toContain(word)
      }
      expect(lockFor(kind)).toEqual({ lock: 'read-only', readAllowlist: allow })
    })

    test(`${kind}: a tool missing upstream is not invented`, () => {
      const subject = policySubjectFor({ kind, policy: { disabledTools: [], writeTools: [] } })
      expect([...exposedToolNames(subject, [tool(allow[0]!)], [])]).toEqual([allow[0]])
    })
  }
})

describe('unlocked connectors (GitHub, imported)', () => {
  const upstream = [tool('search_code', true), tool('get_me', true), tool('create_issue', false), tool('mystery')]

  test('default: annotated read tools only; unannotated tools count as writes', () => {
    for (const kind of ['github', 'custom'] as const) {
      const subject = policySubjectFor({ kind, policy: { disabledTools: [], writeTools: [] } })
      expect([...exposedToolNames(subject, upstream, ['create_issue', 'mystery'])].sort()).toEqual(['get_me', 'search_code'])
      expect(classifyTool(subject, tool('mystery'))).toBe('write')
      expect(classifyTool(subject, tool('get_me', true))).toBe('read')
    }
  })

  test('a write tool needs both the connector permission and the run opt-in', () => {
    const subject = policySubjectFor({ kind: 'github', policy: { disabledTools: ['get_me'], writeTools: ['create_issue'] } })
    expect([...exposedToolNames(subject, upstream, [])].sort()).toEqual(['search_code'])
    expect([...exposedToolNames(subject, upstream, ['create_issue', 'mystery'])].sort()).toEqual(['create_issue', 'search_code'])
  })

  test('built-ins treat every tool as read', () => {
    const subject = policySubjectFor({ kind: 'builtin', policy: { disabledTools: [], writeTools: [] } })
    expect([...exposedToolNames(subject, upstream, [])].sort()).toEqual(['create_issue', 'get_me', 'mystery', 'search_code'])
  })
})

describe('connector ids', () => {
  test('are plain names that cannot widen a built-in OpenCode permission', () => {
    for (const ok of ['github', 'slack-work', 'a1']) expect(() => assertConnectorId(ok)).not.toThrow()
    for (const bad of ['', 'GitHub', '1abc', 'git_hub', 'a'.repeat(33), 'external', 'doom', 'apply', 'a/b']) {
      expect(() => assertConnectorId(bad)).toThrow()
    }
  })
})
