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
 *                failover). The shim resolves the real adapter for
 *                `candidate.provider` via direct registry lookup.
 * - `onFailure`— called after a dispatched candidate's stream failed; the
 *                algorithm records the failure so the next `select` skips it.
 *
 * Future algorithm types register into the SAME registry (`register`) — no
 * restructuring of the shim or the plugin entry point required.
 *
 * Semantics:
 * - 'priority':     ordered failover — the first candidate whose provider has
 *                   a live registered adapter and has not failed this request.
 * - 'round-robin':  PLACEHOLDER (owned by its own card): naive rotating
 *                   index; a failed candidate is skipped via the shim's
 *                   failed set on the next select.
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

/** Round-robin placeholder: rotating index over not-yet-failed candidates. */
function roundRobinFactory(ctx, routes) {
	let cursor = 0;
	return {
		select(route, callCtx) {
			const live = route.candidates.filter((candidate) => !callCtx.failed?.has(key(candidate.provider, candidate.model)));
			if (live.length === 0) return void 0;
			const pick = live[cursor % live.length];
			cursor = (cursor + 1) % live.length;
			return pick;
		},
		onFailure(route, candidate, callCtx) {
			callCtx.failed?.add(key(candidate.provider, candidate.model));
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

/** Default registry: implemented 'priority' + placeholder 'round-robin'. */
export const defaultRegistry = createRegistry()
	.register("priority", priorityFactory)
	.register("round-robin", roundRobinFactory);
