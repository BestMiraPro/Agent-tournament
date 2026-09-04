# Phase 4h — Production Hardening

Date: 2026-09-04
Branch: `phase4h-hardening` (off `master` at `60c54f9`)
Authority: operator request — "Production hardening (responsive, keyboard nav, ARIA, pagination/virtualization, WS reconnect)"

## Problem

The dashboard works but is not hardened for sustained operator use:
- Fixed 2-column layout breaks below ~1024px (sidebar overlaps, no breakpoints).
- AgentGrid renders all 100 cards at once — DOM bloat and 100 tab targets.
- WebSocket has no reconnect — a dropped connection stays dead until page refresh.
- No `aria-live` regions: screen readers don't announce round status updates.
- No `aria-busy` on loading panels; dynamic regions are silent to AT.

## Solution

Five focused hardening items, all dependency-free (CSS-first, native browser features, stdlib `setTimeout`).

### 1. Responsive layout (CSS-only)

No JS changes — pure media queries in `styles.css`.

- `@media (max-width: 1024px)`: `.layout` collapses from `1fr 22rem` to single column. Sidebar (RoundControls + AnalyticsPanel + RoundDetail) stacks below the main column. The agent grid already reflows via `auto-fill, minmax(11rem, 1fr)`.
- `@media (max-width: 768px)`: tighten padding (`.5rem` gaps), shrink card fonts, allow horizontal scroll on wide tables (analytics, round-detail entries) via `overflow-x: auto` wrappers.
- No mobile-phone target — this is an operator dashboard. Tablet (768px) and narrow-desktop (1024px) are the breakpoints.

### 2. Pagination (native, no virtualization library)

AgentGrid gains internal pagination state:

- Page size: 24 agents (renders as a 6×4 or 4×6 grid depending on width).
- Prev/Next buttons + "Page X of Y (N agents)" indicator below the grid.
- Resets to page 1 when `agents.length` changes (new run or new round changes the roster).
- Keyboard: page buttons are `<button>` (native tab + Enter). Current-page cards are the only tab targets in the grid (24, not 100).
- If `agents.length <= page_size`, pagination controls are hidden (no pagination for small runs).

### 3. Keyboard navigation

- Agent cards already have `role="button"` + `tabIndex={0}` + Enter/Space handler (4d). Pagination reduces tab targets to current page.
- Escape closes the AgentDrawer (add `onKeyDown` for Escape on the drawer container; focus returns to the agent grid container — exact-card focus tracking is YAGNI for this phase, the grid container receives focus and the operator tabs to the desired card).
- `focus-visible` outline on all interactive elements: add to pagination buttons, drawer close, roster remove/add, round-control buttons where missing (`.cell--selectable:focus-visible` already exists from 4d).

### 4. ARIA

- Agent cards: `aria-label="Agent {label}, {modelId}, {status}"` (replaces raw text content for AT — the visible text stays).
- Round status region: `aria-live="polite"` on the element showing round status + activity (announces "preparing", "scoring", "complete" without interrupting).
- RunSummary: `role="status"` + `aria-live="polite"` (it's a live status strip).
- Loading panels (AnalyticsPanel, RoundDetail): `aria-busy="true"` while fetching, `false` when loaded.
- Icon-only buttons (roster remove `×`, add `+`): `aria-label="Remove row N"` / `aria-label="Add agent row"`.
- Pagination controls: `aria-label="Previous page"` / `aria-label="Next page"`, `aria-current="page"` on the page indicator.

### 5. WebSocket reconnect (native setTimeout, no deps)

`useLiveRun.ts`:

- On socket `close`, schedule a reconnect with exponential backoff: 1s → 2s → 4s → 8s → 16s → 30s (cap). Infinite retries (the operator may step away; the dashboard should recover on its own).
- New `wsStatus: 'connected' | 'reconnecting'` field on `LiveState`.
- On successful open: reset backoff, set `wsStatus: 'connected'`.
- On close: set `wsStatus: 'reconnecting'`, schedule reconnect.
- Cleanup on unmount: clear the reconnect timer (prevent leaks).
- The backoff schedule is a pure function `nextDelay(attempt: number): number` — testable without a socket.
- App.tsx renders a "Reconnecting…" banner (`.muted` class, top of arena) when `wsStatus === 'reconnecting'`.

## Scope

Files touched (9):
- `web/src/useLiveRun.ts` — reconnect + `wsStatus` + `nextDelay` pure fn
- `web/src/components/AgentGrid.tsx` — pagination state + controls + `aria-label`
- `web/src/components/AgentDrawer.tsx` — Escape to close
- `web/src/components/RunSummary.tsx` — `role="status"` + `aria-live`
- `web/src/components/AnalyticsPanel.tsx` — `aria-busy`
- `web/src/components/RoundDetail.tsx` — `aria-busy`
- `web/src/components/RosterBuilder.tsx` — `aria-label` on remove/add buttons
- `web/src/App.tsx` — reconnect banner + Escape drawer wiring
- `web/src/styles.css` — media queries + pagination button styles + focus-visible additions

No server code. No new dependencies. No behavior change to existing flows (hardening only — pagination is additive, responsive is CSS, ARIA is attributes, reconnect is WS lifecycle).

## Testing

- `test/web/live-run.test.ts`: extend with `nextDelay` pure-function tests (0→1s, 1→2s, 5→30s cap, backoff sequence).
- `test/web/pagination.test.ts`: NOT created — pagination is pure component state (no extracted helper). The e2e guard in `dashboard.e2e.test.ts` covers it: load the app against a mock run with >24 agents, verify pagination controls appear and page 2 shows the remaining agents.
- `test/server/dashboard.e2e.test.ts`: append a guard — load the app against a mock run, verify `aria-live` region exists, pagination controls appear when >24 agents, and the WS reconnects after a simulated close (inject a close event, verify `wsStatus` flips to 'reconnecting' then back to 'connected').

## Non-goals

- Mobile-phone layout (operator dashboard, not consumer).
- Virtualization library (react-window etc.) — pagination is simpler and sufficient for 100 agents.
- Full screen-reader audit (ARIA basics only; a full a11y audit is a separate effort).
- Offline mode / service worker (YAGNI — the server is local).
- Real-mode testing (that's Phase 4i).
