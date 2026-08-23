# dsh-model-router — throwaway prototype

Proves two mechanisms for a future DSH plugin that routes a virtual model id
(`fake/fake-model-routed`) to a real provider+model, with failover.

Run: `node prototype/Delegation-proof.mjs` (exit 0 = all PASS, no network/keys).

## Files
- `Mock-adapters.mjs` — `alpha`/`beta` in-memory adapters emitting valid chunk
  grammar; `alpha` can be told to throw mid-stream.
- `Shim.mjs` — virtual-provider `LlmAdapter` (registers under `fake`) that picks
  the first live candidate and delegates `prepareCall`/`stream` to the real
  adapter. `markCurrentFailed()` advances to the next candidate.
- `Delegation-proof.mjs` — 4 tests + a faithful inline agent-loop invariant.

## What it proves
1. **Shim**: prepared `config` stays virtual, so the runtime's `callConfigEquals`
   gate passes while `stream()` rewrites provider/model to the real adapter.
2. **Failover**: an `agent/request-error` listener marks the candidate failed and
   returns `{kind:"retry"}`; re-issue picks the next. Exhaustion → no retry.
3. **Single dispatch**: a shim request fires `llm/stream` once (shim calls the
   real adapter directly, never re-entering the waterfall).
4. **Invariant**: a shim-delegated request passes the loop's request
   reconstruction invariant.

## Design implications
- Keep prepared `config` virtual; rewrite only inside the shim's `dispatch`.
- Track failed `(provider,model)` in the shim; retry only while candidates live.
- Zero deps: real `LlmRuntime`/`SessionStore` run on a bare `Context`.
