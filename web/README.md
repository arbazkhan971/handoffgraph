# HandoffGraph web — Local Session Debugger (v0.5.0)

React + TypeScript + Vite app for browsing workstreams, turn traces, and
span waterfalls captured by the HandoffGraph event spine.

## Views

1. **Workstream list** (`#/workstreams`) — entry page; per-workstream event
   and trace counts.
2. **Trace list** (`#/traces[?workstream=…]`) — status chips, span/failed
   counts, durations, verification state.
3. **Trace detail** (`#/traces/<id>`) — virtualized span **tree** with
   parent/child collapse, a **waterfall** timeline (bars aligned to the
   trace start; overlaps and idle gaps visible), and a span detail drawer
   with kind, status, exit code, timings, object-hash references and a
   visually distinct evidence level (`OBSERVED` / `DECLARED` / `INFERRED`).

## Data

All data comes from same-origin `/api/*` endpoints served by
`internal/webui` (started with `handoffgraph open`). When the API is not
reachable — e.g. `npm run dev` without the Go server — the app falls back to
deterministic mock data and shows a `MOCK DATA` badge; live and mock data
are never mixed within one view.

## Commands

```bash
npm install       # first time
npm run dev       # dev server with HMR (mock data unless Go server is up)
npm run test      # vitest unit tests (pure helpers + mock integrity)
npm run build     # tsc + vite build into dist/, then copy to ../internal/webui/dist for go:embed
```

## Security notes

- Strict CSP meta tag in `index.html` (relaxed only for the dev server via
  `vite.config.ts`, never in the build).
- All dynamic content is rendered through React's default escaping; there is
  **no** `dangerouslySetInnerHTML` anywhere in this app.
- Dynamic bar/row positions use React's `style` prop (CSSOM), which is not
  blocked by `style-src 'self'`.
