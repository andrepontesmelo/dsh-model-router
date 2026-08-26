# dsh-model-router

DSH plugin: declare **virtual model ids** in config, each bound to a routing
**algorithm** (`priority`, `round-robin`; pluggable) over a list of real
provider/model candidates. Using the virtual id anywhere — agent options,
model picker — transparently dispatches to a real provider chosen by the
algorithm, with failover.

## Config

```jsonc
{
  "routes": [
    {
      "id": "virtual-a",                    // unique route id
      "provider": "routed",                // optional: virtual provider id to register under
                                            // (defaults to the route id). Routes sharing a
                                            // provider form ONE picker group
      "model": "routed-chat",               // optional: advertised virtual model id
                                            // (defaults to the route id -> "virtual-a")
      "algorithm": "priority",              // "priority" | "round-robin"
      "candidates": [
        { "provider": "deepseek-official", "model": "deepseek-v4-flash" },
        { "provider": "pi-ai", "model": "..." }
      ]
    }
  ]
}
```

`routes` defaults to `[]`. The schema is `schemastery` (the DSH fork of zod):
callable, so the same `Config` feeds `installSettingsSection` (settings
provider) and the cordis loader (`~standard.validate`). `model` is optional
and backward compatible: routes without it parse identically and advertise
`<route-id>/<route-id>` (e.g. route `pool` advertises `pool/pool`) in the
model picker; with it, the route advertises exactly one model under
`<route-id>/<model>`. `provider` is likewise optional: routes sharing one
`provider` id register as a single virtual provider whose picker group
advertises one model per route (e.g. `routed/routed` + `routed/strong`),
and the request's model id selects the route. Advertised model ids must be
unique within a provider group.

## The RoutingAlgorithm extension point

An algorithm is a **factory**:

```js
factory(ctx, routes) => {
  select(route, callCtx)    // -> candidate | undefined
  onFailure(route, candidate, callCtx)
  onDispatch?(route, candidate, callCtx) // first dispatch of a request
  onSuccess?(route, candidate, callCtx)   // optional; shim calls it on success
}
```

- `select` returns one candidate from `route.candidates` to dispatch now
  (`undefined` = exhausted, failover stops, error surfaces). It must be PURE:
  the shim probes it for boolean checks (`peek()`), so no state may advance.
- `onFailure` records a failed candidate so the next `select` skips it.
- `onDispatch` (optional) is called by the shim in `prepareCall` the moment a
  candidate is picked for a request's FIRST dispatch — BEFORE the stream
  starts. Allocation-style algorithms spend their slot here.
- `onSuccess` (optional) is called by the shim when a dispatch finishes
  successfully; kept for custom algorithms (round-robin rotates in
  `onDispatch` instead).
- `callCtx` carries per-request state (`{ failed }`, a set keyed by
  `provider\0model`; round-robin adds a `dispatched` marker the shim clears
  on terminal finish); algorithms may extend it.

The registry maps name → factory (`lib/routing.js`): `register(name, factory)`,
`resolve(name)`, `has(name)`, `names()`. Both built-ins are implemented:
`'priority'` (ordered failover — first candidate whose provider has a live
registered adapter and has not failed this request) and `'round-robin'`
(rotating cursor over live candidates; each REQUEST consumes its slot at
DISPATCH time — `onDispatch`, before the stream starts — so two prompts sent
back-to-back land on different candidates even while the first is still
answering; retries within one request never consume an extra slot). A future
algorithm registers into the same registry — no restructuring of the shim or
plugin entry.

## Seam mechanics (proven by the test suite)

- A shim `LlmAdapter` (`lib/shim.js`) registers under each virtual route id
  and delegates `prepareCall`/`stream` to the real adapter via **direct
  registry lookup** (`ctx.llm.registration(realProvider).adapter...`), never
  re-entering the `llm/stream` waterfall (one fire per request).
- The prepared `config` stays **virtual** (`callConfigEquals` gate); only the
  stream-forwarding closure rewrites provider/model.
- The shim declares its own `providerRetryPolicy` (never-matching) so
  dsh-llm-retry does not consume retryable codes before this plugin's
  `agent/request-error` failover listener, which marks the failed candidate
  and returns `{ kind: "retry" }` while candidates remain. Exhaustion → no
  retry → the error surfaces.

## Global backoff for failing candidates

- A real `provider + model` that fails dispatch is **suppressed from selection**
  for a cooldown starting at **30s**, doubling per successive failure, capped
  at **8 hours**.
- The cooldown key is the concrete **provider + model** (same `\0`-joined key
  as the routing algorithms), and it is **global across all routes** of one
  plugin instance: a candidate failing in route A is suppressed in route B too.
- A **successful dispatch of that same provider+model fully resets** the
  cooldown (the escalation restarts at 30s). A success on any *other*
  candidate does not re-enable a cooled one.
- The backoff is **hardcoded** (`lib/backoff.js`), no config surface.
- When every candidate is cooled (or otherwise unusable), `select` returns
  `undefined`, the shim throws **`NO_CANDIDATE`** and the failover listener
  stops retrying — same exhaustion behavior as today.

### Sleep windows in provenance

The backoff ladder is made visible on both failure surfaces the shim owns, so
the durable `llm/attempt` events (rendered by the web provenance view) carry
the cost of each failure:

- A failed attempt's error message gains a suffix with the window that failure
  earns, human-readable via `formatWindow`: e.g. `alpha down (sleep 30s)`,
  escalating to `(sleep 1m0s)`, `(sleep 2m0s)`, ... capped at `(sleep 8h0m)`.
- Full exhaustion names the sleepers with their **remaining** time (a live
  number, unlike the historical earned window):
  `... has no live candidates — sleeping: a/m 29.9s, b/n 1m0s`.
- Aborted streams are never annotated; with no store (`noopBackoff`) every
  suffix is omitted and messages stay byte-identical to the unannotated era.

## Test

```sh
npm test          # node --test
```

No network, no API keys: an in-memory Cordis `Context` + real `LlmRuntime` +
mock adapters prove config parsing, per-route shim registration, registry
resolution, delegation, priority failover/exhaustion/reset, and cycle
rejection.

## Known limitations

- **Round-robin changes the real model across requests**: resume/retry can
  land on a different real model than produced earlier history (breaks the
  KV-cache prefix). Accepted for v1.
- **Failed-candidate state is per shim instance**, shared by all in-flight
  requests on that route. A concurrent success can clear failure marks a
  still-running failover chain relies on — the worst case is one redundant
  retry of a down candidate (bounded). Fine for the single-user local
  harness; per-request keying via `callCtx` is the ready-made hardening seam.
- **Delegation cycles are rejected at config time** (`apply()` throws on any
  route graph whose candidates delegate back into a virtual provider,
  directly or transitively) — otherwise such a config would recurse in the
  shim until `RangeError`.
