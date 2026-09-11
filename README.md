# dsh-model-router

[![CI](https://github.com/andrepontesmelo/dsh-model-router/actions/workflows/ci.yml/badge.svg)](https://github.com/andrepontesmelo/dsh-model-router/actions/workflows/ci.yml)
[![Version](https://img.shields.io/github/package-json/v/andrepontesmelo/dsh-model-router/main?label=version)](package.json)
![local gate](https://img.shields.io/badge/local%20gate-76%20tests%20%2B%20smoke-brightgreen)

![dsh-model-router banner](docs/images/banner.png)

A [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) (DSH) plugin that
turns model selection into **intelligent routing**: declare a virtual model id in config,
bind it to a routing algorithm over a list of real provider/model candidates, and use the
virtual id anywhere — agent options, model picker. Every call is transparently dispatched
to a real model chosen by the algorithm, with automatic failover.

## What it does

- **Virtual model ids.** A route such as `routed-chat` behaves like any real model in the
  picker, but is a facade over a candidate pool you define.
- **Transparent failover.** When a candidate fails, the next one is tried — same request,
  no user-visible error — and the plugin records which real model served each call, so a
  failover is always visible in the provenance instead of silent.
- **Two routing algorithms** (pluggable extension point):
  - `priority` — always try the first candidate; skip it only on failure. Failed
    candidates get **exponential backoff**, giving a struggling model time to recover
    before it is tried again.
  - `round-robin` — distribute calls across the pool.
- **Per-candidate reasoning levels.** A candidate can declare a `reasoning` effort that
  is applied when that candidate serves the request; a model without a matching level
  simply keeps its provider default.
- **Your own algorithm.** `RoutingAlgorithm` is a factory contract (`select`, `onFailure`,
  optional `onDispatch`/`onSuccess`) — implement one and register it.

Failover for a single turn — a candidate fails, the next one serves, and the
provenance records who answered:

```mermaid
flowchart LR
    V["request: routed-chat"] --> P["algorithm selects<br>the first live candidate"]
    P --> C1["candidate 1<br>alpha/alpha-model"]
    C1 -- "stream error" --> F["mark failed +<br>backoff cooldown"]
    F --> R["retry: select the<br>next live candidate"]
    R --> C2["candidate 2<br>beta/beta-model"]
    C2 -- "stop" --> OK["success — provenance<br>records beta as the model that served"]
```

## Why it exists

Model pools are the reality: a cheap fast model, a strong one, a spare. Hardcoding one id
means a provider outage becomes your outage. Routing at the plugin layer means the rest of
the harness never learns about failure — and never has to.

## Install

Requires Node ≥ 22 and a DSH profile to install into.

```bash
npm pack
dsh plugin --profile <your-profile> add file:/path/to/dsh-model-router-<version>.tgz
```

Or straight from GitHub:

```bash
dsh plugin --profile <your-profile> add github:andrepontesmelo/dsh-model-router
```

> [!WARNING]
> Routing is config-driven and bypasses nothing you did not declare — but every candidate
> you list is a real provider that your prompts and completions will be sent to. Audit the
> `candidates` list before installing a route config you did not write, and pin the
> install (tag or local tarball) rather than floating on a branch.

Verify the build before installing:

```bash
npm pack --dry-run          # inspect exactly what ships
sha256sum dsh-model-router-<version>.tgz
```

Compare the checksum with the one published with the release you are installing. A
`github:` install resolves the default branch at install time — pin a tag for
reproducibility.

Useful commands once installed:

```bash
npm test            # 76-test unit suite (node --test)
npm run smoke       # 5 failover drills, in-memory, zero network
dsh plugin --profile <your-profile> list
```

## Quick start

Add a route to your profile's `cordis.patch.yml`:

```jsonc
{
  "routes": [
    {
      "id": "routed-chat",
      "algorithm": "priority",              // "priority" | "round-robin"
      "candidates": [
        { "provider": "deepseek-official", "model": "deepseek-v4-flash", "reasoning": "high" },
        { "provider": "pi-ai", "model": "..." }
      ]
    }
  ]
}
```

Pick `routed-chat` in the model picker (or set it as an agent's model) and route. On
failover, the response provenance shows the real model that answered and any candidates
sleeping in their backoff window.

A candidate's optional `reasoning` is an effort id from that provider's model. When the
candidate serves a request, the shim dispatches with that reasoning effort; if the model
has no reasoning concept (or no such effort), the level is ignored and the provider's own
default applies — the request never fails because of it.

The config-to-picker stack — a declared route becomes a real model-picker
entry backed by the candidate pool:

```mermaid
flowchart TD
    C["cordis.patch.yml<br>route routed-chat, algorithm priority,<br>candidates: deepseek-official/deepseek-v4-flash, pi-ai/…"] --> A["apply(): validate config,<br>group routes by provider"]
    A --> S["RouterShim registers the<br>virtual provider routed-chat"]
    S --> L["llm runtime"]
    L --> M["model picker advertises<br>routed-chat"]
    M --> D["picking routed-chat dispatches through<br>the algorithm with transparent failover"]
```

### Writing your own algorithm

An algorithm is a factory `(ctx, routes) => algorithm`:

```js
{
  select(route, callCtx)      // -> candidate | undefined (pure — no state advance)
  onFailure(route, candidate) // record the failure so select skips it
  onDispatch?(route, candidate) // first dispatch of a request
  onSuccess?(route, candidate)  // optional
}
```

The shim probes `select` for boolean checks, so it must stay pure; state advances happen
in the `on*` callbacks. The test suite in `test/` pins these seam mechanics.

## Docs

Start at the [docs index](docs/index.md):

- [Architecture](docs/architecture.md) — plugin wiring, shim, routing, backoff.
- [Development](docs/development.md) — layout, test gate, how to run the smoke suite.

## Contributing

PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow and the local gate.
Security issues: [SECURITY.md](SECURITY.md) (do not open a public issue).

## Roadmap

- Session stickiness — pin a session to the candidate that first served it *(not yet
  implemented)*.

## Requirements

- Node ≥ 22.
- A DSH profile to install into; candidates point at providers already configured there.

## Test

```bash
npm test        # unit suite
npm run smoke   # in-memory failover drills (LOCAL mode)
```

## License

MIT — see [LICENSE](LICENSE).
