/**
 * dsh-model-router — sole owner of Virtual-route identity.
 *
 * Every invariant of a configured route is decided here, in one place:
 *   - `provider` and `model` DEFAULT (to the route's own `id`) exactly once;
 *   - routes are grouped into virtual providers (one shim adapter per group);
 *   - config is validated with the same messages the plugin has always thrown;
 *   - a group's SHAPE is fingerprinted so the plugin can tell "unchanged"
 *     (keep the live shim and its algorithm state) from "edited" (rebuild).
 * Pure data only: no cordis / dsh-llm / schemastery imports. Routing algorithm
 * instances stay in lib/index.js (created at registry resolve) and are ATTACHED
 * to the normalized routes this module returns; it never sees a context.
 */

/**
 * Normalize one RAW config route into its canonical identity. The
 * `provider|id` and `model|id` defaults are applied HERE and only here, so
 * every downstream consumer (grouping, signature, the shim) reads the same
 * identity and never re-derives a default.
 * @returns {{ id: string, provider: string, advertisedModel: string, algorithm: string, candidates: {provider: string, model: string}[] }}
 */
export function normalizeRoute(raw) {
	return {
		id: raw.id,
		provider: raw.provider || raw.id,
		advertisedModel: raw.model || raw.id,
		algorithm: raw.algorithm,
		candidates: raw.candidates
	};
}

/**
 * Group normalized routes by their virtual provider id, preserving insertion
 * order: the first route of a provider keys that group, and routes within a
 * group keep declaration order.
 * @returns {Map<string, ReturnType<typeof normalizeRoute>[]>}
 */
export function groupRoutes(routes) {
	const groups = new Map();
	for (const route of routes) {
		if (!groups.has(route.provider)) groups.set(route.provider, []);
		groups.get(route.provider).push(route);
	}
	return groups;
}

/**
 * Reject configs whose candidate graph delegates back into a
 * router-registered virtual provider — direct (`virtual-a -> virtual-a`),
 * mutual (`a -> b -> a`), or transitive (`a -> b -> c -> a`). Without this,
 * prepareCall re-enters the same shim forever: RangeError, unbounded by any
 * failed-set growth. A candidate provider is considered VIRTUAL when it equals
 * any route's effective provider (default: the route id); an ACYCLIC virtual
 * -> virtual chain (nesting) is legal and required so one virtual provider can
 * delegate to another.
 */
function assertAcyclic(routes) {
	const byProvider = new Map();
	for (const route of routes) {
		const provider = route.provider || route.id;
		if (!byProvider.has(provider)) byProvider.set(provider, []);
		byProvider.get(provider).push(...route.candidates.map((c) => c.provider));
	}
	for (const root of routes) {
		const walked = new Set();
		const visit = (providerId, chain) => {
			if (!byProvider.has(providerId)) return; // real provider — terminates
			if (chain.includes(providerId)) {
				throw new Error(`dsh-model-router: route "${root.id}" has a delegation cycle (${[...chain, providerId].join(" -> ")}); virtual ids must not appear as their own (or each other's) candidates`);
			}
			if (walked.has(providerId)) return;
			walked.add(providerId);
			for (const next of byProvider.get(providerId)) visit(next, [...chain, providerId]);
		};
		visit(root.provider || root.id, []);
	}
}

/**
 * Validate grouping: concrete candidate graph (cycle-free), unique route ids,
 * unique advertised models per provider. Provider/model defaults come from
 * normalizeRoute (single source of truth). Acyclic virtual nesting is legal —
 * only cycles throw. Runs on the RAW config routes.
 */
export function validateRoutes(routes) {
	const normalized = routes.map(normalizeRoute);
	const seenIds = new Set();
	const modelsByProvider = new Map();
	for (const route of normalized) {
		if (seenIds.has(route.id)) throw new Error(`dsh-model-router: duplicate route id "${route.id}"`);
		seenIds.add(route.id);
		// Two routes in one provider group must not advertise the same model
		// id (the shim keys routes by advertised model).
		const seen = modelsByProvider.get(route.provider);
		if (seen?.has(route.advertisedModel)) throw new Error(`dsh-model-router: routes in provider "${route.provider}" advertise duplicate virtual model "${route.advertisedModel}"`);
		if (seen) seen.add(route.advertisedModel);
		else modelsByProvider.set(route.provider, new Set([route.advertisedModel]));
	}
	assertAcyclic(routes);
}

/**
 * Stable fingerprint of ONE provider group's shape: each route's advertised
 * model id, chosen algorithm, and candidate list, sorted by advertised model so
 * an untouched group yields the SAME signature. Any edit to a member's
 * identity, algorithm, or candidates changes the signature; the plugin compares
 * it across settings changes to decide whether a group's shim (and its
 * round-robin cursor state) survives or must be rebuilt.
 * @param {ReturnType<typeof normalizeRoute>[]} group - one group's normalized routes.
 */
export function groupSignature(group) {
	const shape = [...group]
		.sort((a, b) => (a.advertisedModel < b.advertisedModel ? -1 : a.advertisedModel > b.advertisedModel ? 1 : 0))
		.map((route) => ({
			advertisedModel: route.advertisedModel,
			algorithm: route.algorithm,
			candidates: route.candidates
		}));
	return JSON.stringify(shape);
}
