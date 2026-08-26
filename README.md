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
  `provider\0model`; round-robin adds a `dispatched` marker); algorithms may
  extend it. On terminal success the shim swaps in fresh call records
  (replace-on-success) instead of mutating live ones — a running failover
  chain keeps its private snapshot even if a sibling request succeeds
  concurrently.

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

## Writing your own algorithm

Two steps, plus one seam note.

1. **Write a factory** (one module). `examples/least-dispatched.js` is a
   complete, working example — a fair-share spreader that hands each first
   dispatch to the usable candidate dispatched least often — and
   `test/examples.test.js` proves it composes through the real shim +
   failover path, wired exactly the way `apply()` wires built-ins. Skeleton:

   ```js
   export function myFactory(ctx, routes) {            // ctx: plugin Cordis context
     const crossRequestState = new Map();              // OUTLIVES one request: put it HERE
     return {
       select(route, callCtx) {
         // PURE scan of route.candidates: skip dead providers, entries in
         // callCtx.failed, cooled candidates; return ONE candidate object
         // (or undefined to exhaust failover and surface the error).
         // Must NOT advance anything - the shim re-runs it as a probe.
       },
       onFailure(route, candidate, callCtx) {
         callCtx.failed.add(`${candidate.provider}\u0000${candidate.model}`);
       },
       onDispatch?(route, candidate, callCtx) {
         // Slot for this request is consumed NOW (first dispatch, before
         // the stream starts). Allocation lives here, never in onSuccess.
       },
       onSuccess?(route, candidate, callCtx) {
         // Dispatch finished successfully - outcome bookkeeping only
         // (e.g. reset backoff). Fires after the stream ends.
       }
     };
   }
   ```

2. **Register it against the existing registry** (`lib/routing.js`) before
   the plugin resolves its routes; names are unique and duplicates throw:

   ```js
   import { defaultRegistry } from "dsh-model-router/routing";
   defaultRegistry.register("my-algo", myFactory);
   ```

Seam note: the plugin resolves every configured `route.algorithm` from this
same `defaultRegistry` (`lib/index.js`) — registry in, instance attached to
the route, `RouterShim` over the virtual provider. One caveat today: the
Config schema still ENUMERATES shipped names
(`z.union(["priority", "round-robin"])`, `lib/index.js`), so routing config
itself cannot reference a third-party name until that union widens. The
registry/shim/failover machinery accepts any registered algorithm right now
— `test/examples.test.js` drives the example through `RouterShim` exactly
as config-driven requests flow.

### Factory contract — the fine print

- **`select` must be pure.** After each failure the shim calls `onFailure`
  and then RE-RUNS `select` just as a boolean probe ("anyone left?" —
  `lib/shim.js requestFailed`). A `select` that mutates state answers the
  probe differently than the real pick and corrupts the chain: same
  arguments in, same answer out, however many times it runs.
- **Failure keying** is the string `${provider}\0${model}` inside the
  shim-owned `callCtx.failed` Set. Filter with the same key shape;
  `examples/least-dispatched.js` shows the convention.
- **Allocation timing.** Anything meaning "this candidate was taken for
  this request" belongs in `onDispatch`: it fires inside `prepareCall`
  BEFORE the stream starts, so a second request issued while the first is
  still answering sees the slot gone. `onSuccess` fires only when a
  dispatch SUCCEEDS — too late for allocation; right for outcomes.
- **`callCtx` extension etiquette.** Per-request extras go under your own
  key (round-robin uses `callCtx.dispatched`; prefer
  `callCtx.yourAlgo = {...}`): never reassign or delete the shim-owned
  `{ failed, current }` fields. On terminal success the shim swaps in
  FRESH records that carry ONLY `{ failed, current }` (replace-on-success,
  `lib/shim.js`) — custom keys intentionally die with their record, so
  anything that must survive past one request lives on the factory closure,
  not on `callCtx`.

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

## Smoke

```sh
npm run smoke                              # LOCAL: in-memory drills, no network/keys
npm run smoke -- deployed <profile>        # DEPLOYED: named dsh profile
npm run smoke -- deployed <profile> --patch ./overlay.yml   # overlay layers
npm run smoke -- deployed <profile> --dump-only             # composition report, no dispatch
```

LOCAL re-runs the drill minimum through the real plugin code (shim,
algorithms, backoff store): priority exhaustion surfaces an error; escalating
sleep windows annotate failures (`30s -> 1m0s -> 2m0s`); cooldown resets on
own success; round-robin alternates dispatches; `NO_CANDIDATE` stops retry
cleanly. Same zero-network guarantee as `npm test`.

DEPLOYED parses the profile's composed configuration
(`dsh --profile <name> --dump-config`) for the plugin's routes and where
`agent-default-model` points, then answers ONE task through the live profile
so the routes actually dispatch. Needs network plus whatever credentials the
profile's providers require. Knobs: `DSH_HOME`, `DSH_BIN`,
`SMOKE_TIMEOUT_S`, `SMOKE_VERBOSE=1`.

This command is the pre-install/deploy ritual: run LOCAL everywhere before
installing; run DEPLOYED against a configured profile before relying on its
routes.

## Known limitations

- **Round-robin changes the real model across requests**: resume/retry can
  land on a different real model than produced earlier history (breaks the
  KV-cache prefix). Accepted for v1.
- **Delegation cycles are rejected at config time** (`apply()` throws on any
  route graph whose candidates delegate back into a virtual provider,
  directly or transitively) — otherwise such a config would recurse in the
  shim until `RangeError`.
