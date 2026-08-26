/**
 * dsh-model-router — pluggable routing algorithms.
 *
 * THE EXTENSION POINT. A routing algorithm is a FACTORY:
 *
 *     factory(ctx, routes) => {
 *       select(route, callCtx): candidate   // pick the candidate to dispatch now
 *       onFailure(route, candidate, callCtx) // record a dispatch failure
 *       onDispatch?(route, candidate, callCtx) // first dispatch of a request
 *     }
 *
 * - `ctx`      — the plugin's Cordis context (for registration lookups etc.).
 * - `routes`   — the full validated `Config.routes` array this plugin instance
 *                owns, so algorithms that need cross-route state have it.
 * - `route`    — one validated route: `{ id, algorithm, candidates }` where
 *                `candidates` are `[{ provider, model }]`.
 * - `callCtx`  — per-request context the shim hands over (currently
 *                `{ failed }`, the live failed-candidate set).
 * - `select`   — MUST return one candidate object from `route.candidates`
 *                (or `undefined` when nothing is usable, which exhausts
 *                failover). MUST NOT mutate algorithm state, so the shim can
 *                call it as a pure predicate (see the shim's `peek`).
 *                The shim resolves the real adapter for
 *                `candidate.provider` via direct registry lookup.
 * - `onFailure`— called after a dispatched candidate's stream failed; the
 *                algorithm records the failure so the next `select` skips it.
 * - `onDispatch`— OPTIONAL: called by the shim in `prepareCall` when a
 *                candidate is picked for a request's FIRST dispatch — i.e.
 *                BEFORE the stream starts, unlike `onSuccess`. This is where
 *                allocation-style algorithms (round-robin) spend their slot.
 * - `onSuccess`— OPTIONAL: called after a dispatched candidate's stream
 *                finished successfully (the shim's forward-flow terminal
 *                finish). The shim guards the call with `?.`, so algorithms
 *                that don't need it simply omit it. Both built-ins implement
 *                it to reset the global backoff store (lib/backoff.js).
 *
 * Future algorithm types register into the SAME registry (`register`) — no
 * restructuring of the shim or the plugin entry point required.
 *
 * Semantics:
 * - 'priority':     ordered failover — the first candidate whose provider has
 *                   a live registered adapter and has not failed this request.
 * - 'round-robin':  rotating cursor over live, not-failed candidates. The
 *                   cursor advances AT DISPATCH TIME: the shim calls the
 *                   algorithm's `onDispatch` the moment a candidate is
 *                   picked for a request's FIRST dispatch, moving the cursor
 *                   past it — so a second request issued before the first
 *                   one answers rotates to the next candidate (concurrent
 *                   requests never share one candidate). A retry WITHIN one
 *                   request re-selects from the moved cursor with the failed
 *                   candidate filtered and does NOT consume another slot
 *                   (guarded by the per-request `callCtx.dispatched` marker,
 *                   which dies with its record: terminal success swaps
 *                   fresh records in instead of mutating live ones). A
 *                   request that fails outright still
 *                   consumed its dispatch slot: rotation follows dispatch
 *                   order, not outcomes. The cursor lives on the algorithm
 *                   instance (one per route). Persistence across restarts is
 *                   out of scope (in-memory only).
 */
import { BACKOFF, noopBackoff } from "./backoff.js";

const key = (provider, model) => `${provider}\u0000${model}`;

/** The live provider routes, as an id set, from the llm service registry. */
function liveProviderIds(ctx) {
	return new Set(ctx.llm?.listProviders().map((info) => info.id));
}

/**
 * Priority (ordered failover). `select()` returns the FIRST candidate in
 * declaration order whose provider has a live registered adapter (`ctx.llm`)
 * and is not in `callCtx.failed`. `onFailure()` records the failed candidate
 * in `callCtx.failed` so a retry's `select()` advances past it. When every
 * candidate is exhausted (live or failed), `select()` returns `undefined` so
 * the shim throws `NO_CANDIDATE` and the failover listener stops retrying,
 * letting the original error surface.
 */
function priorityFactory(ctx, routes) {
	const backoff = ctx?.[BACKOFF] ?? noopBackoff;
	return {
		select(route, callCtx) {
			const live = liveProviderIds(ctx);
			for (const candidate of route.candidates) {
				if (!live.has(candidate.provider)) continue;
				if (!backoff.isUsable(candidate.provider, candidate.model)) continue;
				if (callCtx.failed?.has(key(candidate.provider, candidate.model))) continue;
				return candidate;
			}
			return void 0;
		},
		onFailure(route, candidate, callCtx) {
			callCtx.failed?.add(key(candidate.provider, candidate.model));
			backoff.recordFailure(candidate.provider, candidate.model);
		},
		onSuccess(route, candidate) {
			backoff.reset(candidate.provider, candidate.model);
		}
	};
}

/**
 * Round-robin: rotating cursor over live, not-failed candidates.
 *
 * Cursor semantics (v2):
 * - `select()` remains PURE — it never mutates the cursor, so the shim can
 *   probe it (the select-as-predicate inside `requestFailed`) without
 *   side effects. Retries within one request call `select()` again with the failed candidate in
 *   `callCtx.failed`; the candidate is filtered, so the retry lands on the
 *   next live candidate.
 * - Advancement happens in `onDispatch()`, fired by the shim in
 *   `prepareCall` the moment a candidate is picked for the request's FIRST
 *   dispatch — BEFORE the stream starts. Two requests prepared back-to-back
 *   therefore always land on different candidates, no matter how long
 *   either takes to answer. A `dispatched` flag on the per-request
 *   `callCtx` (which dies with its record — terminal success swaps fresh
 *   records in, never mutating live ones) makes failover RETRIES within the
 *   same request re-entrant
 *   without consuming extra slots.
 * - A request that fails outright still consumed its dispatch slot:
 *   rotation follows dispatch order, not outcomes.
 * - The cursor is per-route state on the algorithm instance; replacing the
 *   shim's per-request records on success does not rewind it.
 * - Liveness mirrors priority: candidates whose provider is not in
 *   `ctx.llm.listProviders()` are skipped (public API only).
 */
function roundRobinFactory(ctx, routes) {
	let cursor = 0;
	const backoff = ctx?.[BACKOFF] ?? noopBackoff;
	// Registered-provider liveness ONLY — NOT backoff. The cursor and
	// onDispatch index into this list, so it must stay stable across
	// mid-request cooling: a candidate may cool between its dispatch and the
	// failure marking, and a shrunk list would shift indices and land the
	// retry on the wrong candidate. Backoff is applied as a SKIP condition in
	// the select scan below (a cooled candidate is never picked), keeping the
	// cursor math over the unfiltered list.
	const live = (route) => route.candidates.filter((candidate) => liveProviderIds(ctx).has(candidate.provider));
	return {
		select(route, callCtx) {
			const liveList = live(route);
			if (liveList.length === 0) return void 0;
			for (let i = 0; i < liveList.length; i++) {
				const candidate = liveList[(cursor + i) % liveList.length];
				if (!backoff.isUsable(candidate.provider, candidate.model)) continue;
				if (!callCtx.failed?.has(key(candidate.provider, candidate.model))) return candidate;
			}
			return void 0;
		},
		onFailure(route, candidate, callCtx) {
			callCtx.failed?.add(key(candidate.provider, candidate.model));
			backoff.recordFailure(candidate.provider, candidate.model);
		},
		onDispatch(route, candidate, callCtx) {
			if (callCtx?.dispatched) return; // retry within the same request
			callCtx.dispatched = true;
			const liveList = live(route);
			const idx = liveList.indexOf(candidate);
			if (idx !== -1) cursor = (idx + 1) % liveList.length;
		},
		onSuccess(route, candidate) {
			backoff.reset(candidate.provider, candidate.model);
		}
	};
}

/**
 * Name -> factory registry. Algorithms register ONCE at module load (or via
 * the plugin's apply); the registry is per-plugin-instance so different
 * instances could carry different algorithm sets without cross-talk.
 */
export function createRegistry() {
	const factories = new Map();
	return {
		register(name, factory) {
			if (typeof name !== "string" || name.length === 0) throw new Error(`dsh-model-router: algorithm name must be a non-empty string, got ${String(name)}`);
			if (typeof factory !== "function") throw new Error(`dsh-model-router: algorithm "${name}" must be a factory function`);
			if (factories.has(name)) throw new Error(`dsh-model-router: algorithm "${name}" is already registered`);
			factories.set(name, factory);
			return this;
		},
		resolve(name) {
			const factory = factories.get(name);
			if (!factory) throw new Error(`dsh-model-router: unknown routing algorithm "${name}" (registered: ${[...factories.keys()].join(", ") || "none"})`);
			return factory;
		},
		has(name) {
			return factories.has(name);
		},
		names() {
			return [...factories.keys()];
		}
	};
}

/** Default registry: implemented 'priority' + 'round-robin'. */
export const defaultRegistry = createRegistry()
	.register("priority", priorityFactory)
	.register("round-robin", roundRobinFactory);
