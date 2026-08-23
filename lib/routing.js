/**
 * dsh-model-router — pluggable routing algorithms.
 *
 * THE EXTENSION POINT. A routing algorithm is a FACTORY:
 *
 *     factory(ctx, routes) => {
 *       select(route, callCtx): candidate   // pick the candidate to dispatch now
 *       onFailure(route, candidate, callCtx) // record a dispatch failure
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
 * - `onSuccess`— OPTIONAL: called after a dispatched candidate's stream
 *                finished successfully (the shim's forward-flow terminal
 *                finish). The shim guards the call with `?.`, so algorithms
 *                that don't need it (e.g. priority) simply omit it.
 *
 * Future algorithm types register into the SAME registry (`register`) — no
 * restructuring of the shim or the plugin entry point required.
 *
 * Semantics:
 * - 'priority':     ordered failover — the first candidate whose provider has
 *                   a live registered adapter and has not failed this request.
 * - 'round-robin':  rotating cursor over live, not-failed candidates. The
 *                   cursor advances ONLY on a successful dispatch: the
 *                   shim's forward-flow calls the algorithm's optional
 *                   `onSuccess`, which moves the cursor past the served
 *                   candidate. A retry WITHIN one request re-selects from
 *                   the same cursor position with the failed candidate
 *                   filtered, so retries never consume rotation slots. The
 *                   cursor lives on the algorithm instance (one per route),
 *                   so the shim clearing its per-request failed set on
 *                   success does NOT reset the cursor. Persistence across
 *                   restarts is out of scope (in-memory only).
 */
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
	return {
		select(route, callCtx) {
			const live = liveProviderIds(ctx);
			for (const candidate of route.candidates) {
				if (!live.has(candidate.provider)) continue;
				if (callCtx.failed?.has(key(candidate.provider, candidate.model))) continue;
				return candidate;
			}
			return void 0;
		},
		onFailure(route, candidate, callCtx) {
			callCtx.failed?.add(key(candidate.provider, candidate.model));
		}
	};
}

/**
 * Round-robin: rotating cursor over live, not-failed candidates.
 *
 * Cursor semantics (v1):
 * - `select()` is PURE — it never mutates the cursor. Retries within one
 *   request call `select()` again with the failed candidate in
 *   `callCtx.failed`; the candidate is filtered, so the retry lands on the
 *   next live candidate WITHOUT consuming a rotation slot.
 * - Advancement happens ONLY in `onSuccess()` (optional hook, called by the
 *   shim's forward-flow when a dispatch finishes successfully): the cursor
 *   moves to the index just past the served candidate, so the next NEW
 *   request rotates to the following candidate. A request that failed
 *   outright (all candidates exhausted) does not advance the cursor.
 * - The cursor is per-route state on the algorithm instance; the shim
 *   clearing its per-request failed set on success does NOT reset it, so
 *   rotation order survives failed-set resets.
 * - Liveness mirrors priority: candidates whose provider is not in
 *   `ctx.llm.listProviders()` are skipped (public API only).
 */
function roundRobinFactory(ctx, routes) {
	let cursor = 0;
	const live = (route) => route.candidates.filter((candidate) => liveProviderIds(ctx).has(candidate.provider));
	return {
		select(route, callCtx) {
			const liveList = live(route);
			if (liveList.length === 0) return void 0;
			for (let i = 0; i < liveList.length; i++) {
				const candidate = liveList[(cursor + i) % liveList.length];
				if (!callCtx.failed?.has(key(candidate.provider, candidate.model))) return candidate;
			}
			return void 0;
		},
		onFailure(route, candidate, callCtx) {
			callCtx.failed?.add(key(candidate.provider, candidate.model));
		},
		onSuccess(route, candidate, callCtx) {
			const liveList = live(route);
			const idx = liveList.indexOf(candidate);
			if (idx !== -1) cursor = (idx + 1) % liveList.length;
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
