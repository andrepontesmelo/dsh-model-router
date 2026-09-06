# Development

## Layout

```
lib/index.js      plugin entry: apply(ctx, config), settings, failover listener
lib/shim.js       RouterShim — the virtual adapter + per-request candidate state
lib/routing.js    algorithm factory contract + priority / round-robin + registry
lib/backoff.js    global exponential-backoff store (30s doubling, 8h cap)
lib/routes.js     route normalization, grouping, group signatures
examples/         least-dispatched.js — a complete custom-algorithm example
scripts/smoke.mjs two-mode smoke suite (LOCAL in-memory / DEPLOYED against a profile)
test/             unit suite (node --test), pins seam mechanics
```

## The local gate

Everything must pass before a commit is considered done:

```bash
npm test          # unit suite — currently 71 tests
npm run smoke     # LOCAL mode: 5 failover drills, in-memory, zero network
```

CI (`.github/workflows/ci.yml`) runs exactly this gate on Node 22 for pushes to `main`
and every pull request.

## Running the smoke suite's DEPLOYED mode

`LOCAL` (default) needs nothing. `DEPLOYED` talks to a real DSH profile:

```bash
npm run smoke -- deployed <profile>
```

It parses the composed config, reports which provider/model the profile's
agent-default-model points at, then answers one task through the live profile. Needs
network plus whatever credentials the profile's providers require.

## Writing your own algorithm

1. Read the factory contract in [lib/routing.js](../lib/routing.js) and the walkthrough
   in the [README](../README.md#writing-your-own-algorithm).
2. Copy [examples/least-dispatched.js](../examples/least-dispatched.js) as the shape.
3. Rules that the tests will catch:
   - `select` must be PURE (no state advance) — the shim probes it as a predicate.
   - Advance state in `onDispatch` (first dispatch, before the stream) or `onSuccess`
     (terminal).
   - Namespace any custom `callCtx` keys; they die with the request's records.
4. Register it into `defaultRegistry` and add a unit test under `test/`.

## Conventions

- ESM only (`"type": "module"`), tabs in `lib/`, Node ≥ 22 — no transpile step.
- Tests use `node --test` + `node:assert/strict`; no test framework dependency.
- The smoke suite doubles as executable documentation of the failover drills.
- Glossary terms ([CONTEXT.md](../CONTEXT.md)) are used verbatim in code comments, tests
  and errors — keep them consistent.

## Before you push

- [ ] `npm test` green
- [ ] `npm run smoke` green (LOCAL at minimum)
- [ ] New behavior covered by a test in `test/`
- [ ] Docs updated if the config surface or a contract changed
