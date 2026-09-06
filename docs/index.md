# dsh-model-router docs

A DSH plugin that turns model selection into routing: virtual model ids bound to a
pluggable algorithm over real provider/model candidates, with transparent failover.

## Start here

1. [README](../README.md) — what it does, install, quick start.
2. [Architecture](architecture.md) — how the plugin wires into DSH: shim, routing
   algorithms, backoff store, settings.
3. [Development](development.md) — repo layout, the local gate (`npm test` +
   `npm run smoke`), how to add an algorithm or a test.

## Reference in this repo

- [CONTEXT.md](../CONTEXT.md) — glossary: virtual route, model attempt, model
  provenance, global cooldown, sleep window, dispatch slot.
- [cordis.patch.yml](../cordis.patch.yml) — the bundle-patch entry that inserts the
  plugin into a profile.
- [examples/least-dispatched.js](../examples/least-dispatched.js) — a custom routing
  algorithm implementing the factory contract.

## FAQ

**Why does the picker show a virtual id instead of a real model?**
Because the route is a facade: the virtual id is stable config surface; the real
provider/model is chosen per call and recorded in the provenance.

**What happens when every candidate is in backoff?**
The request fails fast with `NO_CANDIDATE` instead of hanging; sleep windows are listed
in the error.
