# Web search and page fetch for agents — design

**Date:** 2026-11-15 · **Branch:** `phase8-web-search`

Agents get two tools, `web_search` and `web_fetch`, served by the host. Keys stay on the host, every
call is limited and recorded as evidence, and protected Docker workers stay offline: they will reach
these tools only through the connectors bridge (section 8), never through egress or a proxy.

## 1. Search backend comparison (checked 2026-11-15)

Criteria, in the order the decision used them: recurring free volume, rate limit, result quality for
research and technical queries, whether results carry content, terms for programmatic agent use,
signup friction. Prices and limits change often; every figure below was read on 2026-11-15 from the
linked page, and third-party figures are marked as such.

| Provider | Free volume | Rate limit | Content | Terms / signup | Notes |
|---|---|---|---|---|---|
| **LangSearch** | $0 plan with a **daily** token allowance (query + returned text), reset 00:00 UTC; the base allowance is shown only in the account dashboard, each referral adds 1M tokens/day. The earlier published plan was 1,000 requests/day. | 5 req/s for new accounts | Title, URL, snippet, date; optional full page text (`contents.text`), up to 50 results | Free-access licence, no clause against agent use; scraping of LangSearch itself is banned. Free key from the dashboard, no card stated | Quality for technical queries not independently verified here (no key was used). [pricing](https://langsearch.com/pricing), [limits](https://docs.langsearch.com/limits/api-limits), [API](https://docs.langsearch.com/api/web-search-api), [referrals](https://langsearch.com/blog/more-search-more-rewards), [terms](https://langsearch.com/terms-of-service) |
| Brave Search API | $5 credit/month ≈ 1,000 searches ($5 per 1,000) | 50 req/s | Snippets + up to 5 extra snippets | Card required (anti-fraud). Storing results needs a custom plan | Best independent index of the set; the old 2,000/month free plan is gone. [brave.com/search/api](https://brave.com/search/api/) |
| Tavily | 1,000 credits/month (basic search = 1 credit) | 100 RPM on the free plan | Content snippets, optional raw content | No card | Keyless use exists at an unpublished lower limit. [credits](https://docs.tavily.com/documentation/api-credits), [rate limits](https://docs.tavily.com/documentation/rate-limits) |
| Serper | 2,500 queries, **one-time** | not published for the free grant (paid packs 50+ QPS, third-party) | Google SERP snippets | No card | Not recurring. [serper.dev](https://serper.dev/), [third-party pricing](https://websearchapi.space/blog/serper-pricing) |
| Jina `s.jina.ai` | 10M tokens per new key, one-time; search costs ≥10k tokens ⇒ ≤1,000 searches (third-party) | 100 RPM on a free key; no keyless search | Full page content | Free tokens are non-commercial (third-party) | [third-party summary](https://agentdeals.dev/vendor/jina-ai) |
| Google Programmable Search JSON API | 100/day for existing customers only | — | Snippets | **Closed to new customers; discontinued 2027-01-01** | Not viable. [Google](https://developers.google.com/custom-search/v1/overview) |
| Linkup | $20/month ≈ 4,000 standard searches (third-party, from Linkup's pricing page) | 10 req/s | Snippets / sourced answers | Needs a professional email, otherwise a card | [third-party summary](https://agentdeals.dev/vendor/linkup) |
| You.com | 100 queries/day through its MCP server with no key; API: $10 signup credit ≈ 2,000 searches, $5 per 1,000 | not published | Snippets; Contents API extra | No card for the keyless MCP tier | Keyless tier is MCP-only and 100/day. [you.com/pricing](https://you.com/pricing) |
| SearXNG | Unlimited in principle | Whatever the upstream engines tolerate | Upstream snippets | Self-hosted; public instances mostly disable JSON and rate-limit bots | A service to run and keep unblocked. [LangChain notes](https://docs.langchain.com/oss/python/integrations/providers/searx) |
| Exa (keyed API) | $10 credit/month ≈ 1,400 `auto` / 2,500 `lite` searches | 10 QPS free (third-party) | Highlights, text, summaries | No card | [exa.ai/pricing](https://exa.ai/pricing), [API](https://docs.exa.ai/reference/search) |
| Exa (keyless MCP, `https://mcp.exa.ai/mcp`) | Free at an unpublished rate limit; search and fetch only | unpublished | Highlights per result | Keyless needs a direct IPv4 connection; a key goes in the `x-api-key` header | What OpenCode's own `websearch` uses. [docs](https://docs.exa.ai/reference/exa-mcp) |

**Decision: LangSearch is the primary; Exa is the fallback** (keyless MCP endpoint by default, the
operator's `EXA_API_KEY` in the `x-api-key` header when set).

- **Free volume** decides it: LangSearch's allowance is daily, the others are monthly or one-time.
  Even at the old published 1,000 requests/day that is ~30,000/month against ~1,000–4,000/month for
  the best recurring alternatives. Confidence: medium — the current base allowance is not published,
  so the real figure is whatever the owner's dashboard shows.
- **Rate limit:** 5 req/s is enough for a population searching in parallel; bursts beyond it get
  429 and fall back to Exa automatically, which is the designed path, not an error.
- **Quality** is the open risk: LangSearch runs its own index and was not tested here (no account was
  created). The Exa fallback is a strong research index, and a 429/5xx/timeout from LangSearch costs
  the agent nothing but latency. If quality proves poor, Brave is the runner-up (best index, 50 QPS,
  but ~1,000 searches/month and a card); the provider interface makes the swap one client.
- **Content:** snippets are enough for a search result list; agents read pages with `web_fetch`.
- **Terms/signup:** free key, no card, no clause against programmatic agent use.

Live check, 2026-11-15: two keyless calls to `https://mcp.exa.ai/mcp` (`tools/list`, then
`tools/call web_search_exa`) answered in under 0.5 s over IPv4 with `Title:/URL:/Published:/
Highlights:` blocks separated by `---`. Its current schema lists `query` and `objective` as required;
OpenCode 1.18.21's own argument set (`query`, `type`, `numResults`, `livecrawl`) is still accepted.
LangSearch was called once with an obviously invalid key (no account was created): it refused, the
client classified it `unauthorized` and Exa answered. An end-to-end check through the loopback
endpoint (SDK client → `web_search` via keyless Exa, `web_fetch` of an RFC page over TLS through the
pinned lookup, `web_fetch http://localhost:4300/…` refused as `blocked_host`) produced three records
with the right run, agent, outcome and provider.

## 2. Shape

```
src/connectors/web/
  ssrf.ts          address policy, DNS resolution, pinned lookups
  html-to-text.ts  minimal HTML → markdown-ish text extractor
  fetch-page.ts    web_fetch: guarded, pinned, capped HTTP(S) GET + conversion
  search.ts        web_search: LangSearch client, Exa client, fallback
  config.ts        keys from env / the repo .env; provider status for the dashboard
  limits.ts        per-agent and per-run call limits
  evidence.ts      WebCallRecord, summaries, the EngineEvent it becomes
  mcp-server.ts    createWebMcpServer(deps): McpServer; webConnector() for many runs/agents
  http-server.ts   loopback Streamable HTTP endpoint with per-run grants (local wiring)
  opencode.ts      the per-agent OpenCode config, tool names, prompt lines
  stdio.ts         stdio entrypoint serving the same tools
```

## 3. `web_fetch(url)`

- http/https only; no credentials in the URL; at most 2,048 characters.
- **Address policy** (`ssrf.ts`), IPv4: `0/8`, `10/8`, `100.64/10` (CGNAT, includes Alibaba's
  `100.100.100.200` metadata), `127/8`, `169.254/16` (link-local, includes `169.254.169.254`),
  `172.16/12`, `192.0.0/24`, `192.0.2/24`, `192.88.99/24`, `192.168/16`, `198.18/15`,
  `198.51.100/24`, `203.0.113/24`, `224/4` (multicast), `240/4` (incl. broadcast), plus Azure's
  host endpoint `168.63.129.16/32`. IPv6: `::/128`, `::1/128`, `100::/64`, `2001::/23` (Teredo,
  benchmarking, ORCHID), `2001:db8::/32`, `64:ff9b:1::/48`, `fc00::/7` (incl. AWS `fd00:ec2::254`),
  `fe80::/10`, `fec0::/10`, `ff00::/8`; IPv4-mapped `::ffff:0:0/96`, IPv4-compatible `::/96`, NAT64
  `64:ff9b::/96` and 6to4 `2002::/16` are judged by the IPv4 address they embed. `localhost` and
  `*.localhost` are refused before DNS.
- **Resolution and pinning:** the host name is resolved once per hop (all addresses); if any answer is
  blocked the hop is refused. The connection is made to the checked address through a `lookup` that
  returns only it, so no second resolution can rebind. TLS still verifies the certificate against
  the host name. A fresh agent per hop (`agent: false`), so no pooled socket or proxy is reused.
- **Redirects:** followed manually, at most 5; every hop is re-validated, re-resolved and re-pinned.
- **Caps:** reading stops after 2 MiB of body, counted after decompression (gzip/deflate/br, so a
  compression bomb stops at the cap too), and the result says it was cut; 20 s for the whole call
  including lookups, redirects and body reads; 64,000 characters of text returned.
- **Content:** HTML/XHTML converted to text; `text/*`, JSON and XML passed through; everything else
  (PDF, images, archives, octet-stream) refused. A missing type is sniffed: NUL bytes ⇒ refused.
- **HTML conversion: in-house** (`html-to-text.ts`, ~150 lines, linear tokenizer). It drops
  `script/style/noscript/template/svg/iframe/head/nav/aside/footer/form`, keeps headings as `#`,
  list items as `-`, links as `[text](absolute-url)`, `pre` blocks fenced, table cells separated by
  `|`, and decodes numeric and common named entities. Why not a dependency: the candidates
  (`turndown` + a DOM, `html-to-text`, `node-html-markdown`) each add a parser tree of several
  packages to the one process that holds the keys, for output an agent reads as plain text anyway;
  input is capped at 2 MiB, so a linear pass is fast and fully testable.

## 4. `web_search(query, maxResults)`

- `query` 1–400 characters; `maxResults` 1–10, default 5.
- LangSearch first when `LANGSEARCH_API_KEY` is configured (`POST /v1/web-search`, snippets mode,
  12 s). **Any** primary failure falls back to Exa, and the reason is recorded: `missing_key`,
  `unauthorized` (401/403), `rate_limited` (429), `quota_exhausted` (402/432/433, or a 429 whose
  message names the allowance), `server_error` (5xx), `timeout`, `network`, `bad_response`,
  `client_error` (other 4xx). The brief's list is the first seven; the last two also fall back
  (deviation, deliberate): a 400 or malformed body from one provider says nothing about the other,
  and the agent gets an answer either way.
- Exa: JSON-RPC `tools/call web_search_exa` `{query, numResults, objective}` to the MCP endpoint over
  IPv4, 25 s; `x-api-key` when `EXA_API_KEY` is set. The text blocks are parsed into results.
- The result names the provider that answered and, after a fallback, which one failed and why.
- Snippets are capped at 1,000 characters each.

## 5. Keys

`LANGSEARCH_API_KEY` and `EXA_API_KEY`, read by the app from its environment, or else from the
repository folder's `.env` (gitignored; the file `docker compose` already reads, and compose passes
both through). Read on every search call and status request, so a key added to `.env` applies
without a restart. Keys never reach worker config, mounts, env or argv, SQLite,
exports, logs or events: the OpenCode server the app spawns has both names scrubbed from its
environment (local agents' shell commands inherit that environment), provider errors are reduced to
fixed reason codes, and tests assert the key string appears in no record, result or error.

Side effect, accepted: the grader's OpenCode `websearch` stays keyless Exa (`OPENCODE_ENABLE_EXA=1`),
as documented today, even when `EXA_API_KEY` is set for the fallback.

## 6. Limits and evidence

Per run, per agent: 200 searches and 500 fetches. Per run in total: 2,000 searches and 5,000 fetches
(they protect the free quotas). Counted when a call is admitted; a refused call is still recorded.
After the run stops its grant is revoked: requests get 401 and in-process servers refuse.

Every call produces one `WebCallRecord` — tool, run, agent, target (search: the query, redacted and
capped at 200 characters; fetch: host + path, no query string or fragment, plus the final host + path
after redirects), provider and fallback reason, outcome (`completed`/`denied`/`failed`), HTTP status,
bytes, result count, start time and duration, and a fixed error code. Never page text, snippets or
provider error bodies.

In the dashboard process a record becomes an `agent.web` engine event. The audit collector stores it
as kind `network`, source `host_tool` (redacted and capped like every record), so it is part of the
sealed evidence the grader sees; the activity cache shows it as a tool item on the agent's card. The
`network` sensor text now says host web tool calls are recorded. OpenCode's own event stream also
reports the MCP tool call (as `arena_web_search: <query>`); the host record is the authoritative one.

## 7. Local wiring (now)

- A process-wide loopback server (`127.0.0.1`, random port), like the provider relay. `POST /mcp`
  only, stateless Streamable HTTP; `Host` must be the loopback address it listens on; bodies ≤ 64 KiB.
- `composeRun` (local sandbox, `webAccess` on) grants the run: a random 32-byte secret, the limits,
  the provider config. Each agent's bearer token is `<grant>.<agentId>.<HMAC-SHA256(secret, agentId)>`,
  so the server attributes calls without per-agent state and one agent cannot mint another's token
  without the secret. (Locally an agent can read sibling workspaces, so this is attribution, not
  isolation — the same honesty as the rest of local mode.)
- The runner writes `.opencode/opencode.json` into the agent's workspace before its session starts:
  one remote MCP server named `arena` with that URL, the bearer header, `oauth: false` and a 60 s
  timeout. OpenCode loads `.opencode/opencode.json` per directory instance (verified in the 1.18.21
  source), names the tools `arena_web_search` / `arena_web_fetch`, and asks permission under those
  names. `.opencode` is already excluded from the judged file manifest. Later OpenCode releases
  document a different MCP config shape (`mcp.servers`, a timeout object); local mode uses whatever
  OpenCode the host has, so the operator guide says to check the version if the tools do not appear.
- The competitor profile, for local runs, allows `arena_web_search` and `arena_web_fetch` when web
  access is on, and denies OpenCode's built-in `websearch` either way, so every search a local agent
  makes through tools is the audited, limited one. `webfetch: deny` is unchanged. Docker profiles are
  unchanged. (Local agents can still use `curl` from bash: local mode has no isolation.)
- The agent prompt names both tools and the limits.
- The dashboard attaches the run's evidence sink right after `createRun` (POST and resume); calls
  before that are refused. `cleanup()` revokes the grant first.
- Why loopback HTTP rather than the stdio entrypoint for OpenCode: a stdio server is spawned by
  OpenCode, so the keys would have to be in its config or environment, and its records and counters
  would live in a process the app does not own. In-process HTTP keeps keys, limits and evidence in the
  app — the provider relay's discipline.
- The CLI's local real runs use the same path: `cliRunSpec` carries `webAccess` (on unless
  `--no-web-access`), the CLI attaches the run's evidence to the engine's audit after `createRun`
  (it has no live view), and its stop is the composition's cleanup, so the grant is revoked.

## 8. Docker (at integration — not built here)

Protected workers keep their internal network and their two gateway routes. The connectors work
provides a host-side MCP tool bridge reached through a new gateway route and a registration hook.
This module's factory is built for it:

```ts
import { webConnector } from './connectors/web/mcp-server.js'

const web = webConnector()          // per-run limiters, keys read from env/.env per run
registerBuiltinConnector({
  id: 'web',
  title: 'Web search and fetch',
  readOnly: true,
  createServer: (ctx) => web.createServer({ runId: ctx.runId, agentId: ctx.agentId, evidence: ctx.evidence }),
})
// and when a run stops: web.endRun(runId)
```

`ctx.evidence` receives `WebCallRecord`s; `webCallEvent(record)` turns one into the `agent.web`
engine event if the bridge feeds the engine's audit. The integrator also allows the bridge's tool
names in the Docker competitor profile and lists the tools in `TOOLS.md`.

## 9. Run config and dashboard

- `webAccess: boolean` in the run spec, default **true** (a research tool), validated as a boolean,
  stored in `RunConfig`, carried through PATCH and resume. Stored configs without it resume with
  web access off — what they ran with.
- RunSetup: a "Web access" checkbox for local and docker sandboxes, with help text saying it applies
  to local runs in this version, and a status line from `GET /api/web-search`: which primary is
  configured (LangSearch with a key, or not) and the Exa fallback mode (keyed or keyless). No key is
  ever sent to the browser.
- Operator guide: how to get a LangSearch key and where to put it.

## 10. Tests (no network)

Fallback matrix (each failure mode → Exa, result names the provider); SSRF guard (every blocked
range, mapped/embedded forms, mixed DNS answers, redirect to a private address, DNS rebinding with a
pinned connection, the real pinned lookup against a local server); caps (redirects, bytes, time,
decompression); content types; HTML conversion; key non-leakage; evidence records; limits;
MCP tool schemas through an in-memory client; the loopback server's auth, revocation and attribution;
the stdio entrypoint's tool list; compose/runner/profile/prompt wiring; run-spec; audit and activity
handling of `agent.web`; the status endpoint and the setup form.
