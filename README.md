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
      "id": "virtual-a",                    // the virtual provider/model id
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
provider) and the cordis loader (`~standard.validate`).

## The RoutingAlgorithm extension point

An algorithm is a **factory**:

```js
factory(ctx, routes) => {
  select(route, callCtx)    // -> candidate | undefined
  onFailure(route, candidate, callCtx)
}
```

- `select` returns one candidate from `route.candidates` to dispatch now
  (`undefined` = exhausted, failover stops, error surfaces).
- `onFailure` records a failed candidate so the next `select` skips it.
- `callCtx` carries per-request state (`{ failed }`, a set keyed by
  `provider\0model`); algorithms may extend it.

The registry maps name → factory (`lib/routing.js`): `register(name, factory)`,
`resolve(name)`, `has(name)`, `names()`. `'priority'` and `'round-robin'` are
registered by default with **placeholder** semantics (first-not-failed /
rotating index); two later slices replace them with properly tested
semantics. A future algorithm registers into the same registry — no
restructuring of the shim or plugin entry.

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
mock adapters prove config parsing, per-route shim registration, and registry
resolution of both built-in algorithms.
