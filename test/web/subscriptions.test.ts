import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import type { SubscriptionStatus } from '../../web/src/api.js'
import { RosterBuilder } from '../../web/src/components/RosterBuilder.js'
import { SubscriptionsPanel } from '../../web/src/components/SubscriptionsPanel.js'
import { isSubscriptionModel, pickerModels, subscriptionSummary } from '../../web/src/lib/subscriptions.js'

const status = (over: { claude?: Partial<SubscriptionStatus['claude']>; chatgpt?: Partial<SubscriptionStatus['chatgpt']> } = {}): SubscriptionStatus => ({
  claude: { cli: { found: true, version: '2.1.325 (Claude Code)' }, tokenSet: false, hostLogin: true, mode: 'host', usage: null, models: ['claude-subscription/claude-opus-5-5', 'claude-subscription/opus'], ...over.claude },
  chatgpt: { credentialsFile: '/h/auth.json', signedIn: true, expired: false, expiresAt: 1, modelPrefix: 'openai/', ...over.chatgpt },
})

describe('subscription models in the pickers', () => {
  test('Claude subscription models are offered and labelled; openai models only while a ChatGPT login exists', () => {
    const { models, labels } = pickerModels(['openai/gpt-5.5', 'wandb/x/y'], status())
    expect(models).toEqual(['claude-subscription/claude-opus-5-5', 'claude-subscription/opus', 'openai/gpt-5.5', 'wandb/x/y'])
    expect(labels).toEqual({ 'claude-subscription/claude-opus-5-5': 'subscription', 'claude-subscription/opus': 'subscription', 'openai/gpt-5.5': 'subscription' })
    expect(isSubscriptionModel('openai/gpt-5.5', status({ chatgpt: { signedIn: false } }))).toBe(false)
    expect(isSubscriptionModel('claude-subscription/sonnet', null)).toBe(true)
    expect(pickerModels(['wandb/x/y'], null)).toEqual({ models: ['wandb/x/y'], labels: {} })
  })

  test('the roster builder shows the badge on a subscription row and labels the options', () => {
    const html = renderToStaticMarkup(createElement(RosterBuilder, {
      value: [{ modelId: 'claude-subscription/opus', count: 1, temperature: 0.7 }, { modelId: 'wandb/x/y', count: 1, temperature: 0.7 }],
      onChange: () => {}, models: ['claude-subscription/opus', 'wandb/x/y'], labels: { 'claude-subscription/opus': 'subscription' },
    }))
    expect(html.match(/badge--subscription/g)).toHaveLength(1)
    expect(html).toContain('label="claude-subscription/opus (subscription)"')
  })

  test('run setup offers the panel, the badges and the merged model list', () => {
    const src = readFileSync('web/src/components/RunSetup.tsx', 'utf8')
    expect(src).toContain('<SubscriptionsPanel')
    expect(src).toContain('labels={picker.labels}')
    expect(src).toContain('{picker.labels[judgeModel] && <SubscriptionBadge />}')
    expect(src).toContain('{picker.labels[reflectModel] && <SubscriptionBadge />}')
  })
})

describe('subscriptions panel', () => {
  test('says what each sign-in allows, with the commands to run, and never shows a token', () => {
    const html = renderToStaticMarkup(createElement(SubscriptionsPanel, { status: status({ claude: { tokenSet: true, mode: 'token' } }), onChange: () => {} }))
    expect(html).toContain('setup token saved')
    expect(html).toContain('<code>claude setup-token</code>')
    expect(html).toContain('<code>opencode auth login</code>, choose OpenAI, then ChatGPT Plus/Pro')
    expect(html).toContain('type="password"')
    expect(html).toContain('Remove token')
  })

  test('reports a missing CLI, an expired ChatGPT token and an exhausted Claude limit', () => {
    expect(subscriptionSummary(status({ claude: { cli: { found: false, version: null }, mode: null } })).claude).toMatch(/not installed/)
    expect(subscriptionSummary(status({ chatgpt: { expired: true } })).chatgpt).toMatch(/expired and is refreshed/)
    expect(subscriptionSummary(status({ claude: { mode: 'host' } })).claude).toMatch(/local runs only; Docker needs a setup token/)
    const html = renderToStaticMarkup(createElement(SubscriptionsPanel, {
      status: status({ claude: { usage: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: 2_000_000_000, utilization: 1 } } }), onChange: () => {},
    }))
    expect(html).toContain('Claude usage limit reached')
    expect(renderToStaticMarkup(createElement(SubscriptionsPanel, { status: null, onChange: () => {} }))).toContain('not available from this server')
  })
})
