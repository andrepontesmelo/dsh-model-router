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
      "id": "virtual-a",                    // the virtual provider id
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
`<route-id>/<model>`.

## The RoutingAlgorithm extension point

An algorithm is a **factory**:

```js
factory(ctx, routes) => {
  select(route, callCtx)    // -> candidate | undefined
  onFailure(route, candidate, callCtx)
  onSuccess?(route, candidate, callCtx)   // optional; shim calls it on success
}
```

- `select` returns one candidate from `route.candidates` to dispatch now
  (`undefined` = exhausted, failover stops, error surfaces). It must be PURE:
  the shim probes it for boolean checks (`peek()`), so no state may advance.
- `onFailure` records a failed candidate so the next `select` skips it.
- `onSuccess` (optional) is called by the shim when a dispatch finishes
  successfully — e.g. round-robin advances its rotation cursor there.
- `callCtx` carries per-request state (`{ failed }`, a set keyed by
  `provider\0model`); algorithms may extend it.

The registry maps name → factory (`lib/routing.js`): `register(name, factory)`,
`resolve(name)`, `has(name)`, `names()`. Both built-ins are implemented:
`'priority'` (ordered failover — first candidate whose provider has a live
registered adapter and has not failed this request) and `'round-robin'`
(rotating cursor over live candidates; advances only on successful dispatch,
so retries within one request never consume a rotation slot). A future
algorithm registers into the same registry — no restructuring of the shim or
plugin entry.

## Seam mechanics (proven by prototype/)

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
