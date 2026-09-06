# Architecture

How dsh-model-router wires into [DSH](https://www.npmjs.com/package/@deepseek-ai/dsh).
Read [CONTEXT.md](../CONTEXT.md) first for the glossary (virtual route, model attempt,
provenance, global cooldown, sleep window, dispatch slot).

## One diagram

```
 model picker / agent options
        │  virtual id  e.g. routed-chat
        ▼
 ┌─────────────────────┐  one RouterShim per VIRTUAL PROVIDER
 │ RouterShim          │  (routes sharing a provider id = one group)
 │  byModel: route map │
 │  requests: per-call │
 │  state (WeakMap)    │
 └─────────┬───────────┘
           │ select() via the route's algorithm instance
           ▼
 ┌─────────────────────┐     ┌──────────────────────────────┐
 │ RoutingAlgorithm    │     │ Global backoff store          │
 │  priority           │◄────│ ctx[BACKOFF] — 30s doubling   │
 │  round-robin        │     │ cooldown, 8h cap, reset on    │
 │  ...yours           │     │ success, shared by ALL routes │
 └─────────┬───────────┘     └──────────────────────────────┘
           │ direct registry lookup (never re-enters the waterfall)
           ▼
 real registered adapter  e.g. deepseek-official/deepseek-v4-flash
```

## Pieces

- **`lib/index.js` — plugin entry.** `apply(ctx, config)` validates routes, installs the
  shared backoff store on `ctx[BACKOFF]`, registers one shim per virtual provider, mounts
  the settings section, and adds the `agent/request-error` failover listener that makes
  retry happen. Own teardown disposes the listener and every registration handle.
- **`lib/shim.js` — `RouterShim`.** The virtual adapter the runtime sees. Picks a candidate
  through the route's algorithm, resolves the real adapter by DIRECT registry lookup (one
  `llm/stream` per request — no waterfall re-entry), rewrites provider/model only in the
  stream-forwarding closure, and keeps per-request candidate state per `(signal, route)`.
  Declares a never-matching retry policy so dsh-llm-retry does not pre-empt this plugin's
  own failover listener. `requestFailed` records the failure and answers whether a live
  candidate remains.
- **`lib/routing.js` — the extension point.** An algorithm is a factory
  `(ctx, routes) => { select, onFailure, onDispatch?, onSuccess? }`. `select` must be
  PURE — the shim probes it as a predicate; state advances only in the `on*` callbacks.
  Built-ins: `priority`, `round-robin` (cursor advances at first dispatch, so concurrent
  requests never share a candidate). Custom algorithms register into the same
  `defaultRegistry`; see [examples/least-dispatched.js](../examples/least-dispatched.js).
- **`lib/backoff.js` — global cooldown.** One store per plugin instance, shared by every
  route and algorithm. A failed `provider\0model` cools for 30s, doubling per successive
  failure, capped at 8h; only a successful dispatch of that candidate clears it. Feeds the
  provenance: the shim stamps failed attempts with their earned sleep window and the
  exhaustion error lists sleepers via `remainingMs`.
- **`lib/routes.js` — config normalization + group signatures.** Routes sharing a
  `provider` id form one shim group; `groupSignature` hashes the group SHAPE so a settings
  edit swaps only the providers whose shape changed, keeping live shims (and algorithm
  state) untouched otherwise.
- **Settings.** `installSettingsSection` (dsh-settings) mirrors the composition entry, so a
  mounted settings provider can override routes live; edits are validated at write time —
  a schema-valid but router-invalid section is rejected before persisting.

## Failover sequence

1. Request arrives for virtual id `routed-chat`.
2. Shim's route algorithm `select`s a candidate (skipping per-request failures and
   globally cooling candidates).
3. Real adapter dispatches. First dispatch consumes the request's dispatch slot.
4. On stream failure: `agent/request-error` fires, the shim records the failed candidate
   (and stamps the sleep window), and the listener returns `{ kind: "retry" }` while a
   live candidate remains.
5. Retry re-selects within the SAME request (no new slot). Exhaustion: the request fails
   with `NO_CANDIDATE`, listing who is sleeping and for how long.
6. On terminal success the provenance records the concrete model that answered — and the
   backoff store resets for that candidate.
