/**
 * dsh-model-router — EXAMPLE routing algorithm: 'least-dispatched'.
 *
 * A complete, self-contained author-facing example (README section
 * "Writing your own algorithm" walks through this file). It spreads load
 * fair-share style: every first dispatch goes to the usable candidate that
 * has been dispatched LEAST often so far, proving every contract point
 * without touching the built-ins or the shipped defaultRegistry contents.
 *
 * Contract points demonstrated:
 * - SELECT PURITY: select() is a read-only scan. The shim probes it as a
 *   boolean predicate after each failure (`requestFailed` calls select()
 *   again just to ask "is anyone left?"), so it must never advance state —
 *   counters move ONLY in onDispatch().
 * - FAILURE RECORDING: onFailure() adds the provider\\0model key to
 *   callCtx.failed (the shim-owned set), so the NEXT select skips the
 *   candidate for the rest of THIS request.
 * - ALLOCATION TIMING: bookkeeping happens in onDispatch(), which the shim
 *   calls at FIRST-dispatch time inside prepareCall — BEFORE the stream
 *   starts. Two requests issued back-to-back therefore do not share one
 *   candidate even while the first is still answering. onSuccess() would be
 *   too late (it fires at stream end) and is intentionally omitted here;
 *   see round-robin for an algorithm shaped the same way.
 * - callCtx EXTENSION ETIQUETTE: custom per-request state is added under a
 *   namespaced key (`leastDispatched.counted`) — never reassign or delete
 *   the shim-owned fields. On terminal success the shim swaps in FRESH
 *   records that carry only { failed, current }: per-request extensions DIE
 *   with the record they live on, so never rely on a custom key surviving
 *   into a later phase of the same request. Cross-request state (the
 *   counters here) lives on the factory closure instead.
 */

const key = ({ provider, model }) => `${provider}\u0000${model}`;

export function leastDispatchedFactory(ctx, routes) {
	// Cross-request state lives HERE (one instance per route), not on
	// callCtx — callCtx dies when the request's terminal success swaps it.
	const dispatchCounts = new Map();

	const countOf = (candidate) => dispatchCounts.get(key(candidate)) ?? 0;

	return {
		/**
		 * PURE: reads live providers + callCtx.failed + the counters,
		 * advances nothing. Returns the usable candidate with the lowest
		 * dispatch count (declaration order breaks ties), or undefined when
		 * everything is dead/failed/cooled — which ends failover and lets
		 * the original error surface.
		 */
		select(route, callCtx) {
			const live = new Set(ctx.llm?.listProviders().map((info) => info.id));
			let best;
			let bestCount = Infinity;
			for (const candidate of route.candidates) {
				if (!live.has(candidate.provider)) continue;
				if (callCtx.failed?.has(key(candidate))) continue;
				if (countOf(candidate) < bestCount) {
					best = candidate;
					bestCount = countOf(candidate);
				}
			}
			return best;
		},

		/** Record the failed candidate so retries of THIS request skip it. */
		onFailure(route, candidate, callCtx) {
			callCtx.failed?.add(key(candidate));
		},

		/**
		 * Consume the request's allocation slot NOW (first dispatch, pre-
		 * stream). The `counted` marker on callCtx guards double counting:
		 * prepareCall also invokes onDispatch paths once per prepared call,
		 * but a within-request RETRY re-selects WITHOUT a fresh dispatch
		 * slot, and must not bump any counter either.
		 */
		onDispatch(route, candidate, callCtx) {
			if (callCtx.leastDispatched?.counted) return;
			callCtx.leastDispatched = { counted: true };
			dispatchCounts.set(key(candidate), countOf(candidate) + 1);
		}
	};
}

/**
 * Registration is ONE line against the EXISTING registry — no shim or
 * entry-point restructuring:
 *
 *     import { defaultRegistry } from "dsh-model-router/routing";
 *     defaultRegistry.register("least-dispatched", leastDispatchedFactory);
 *
 * Import that module (or call register yourself) BEFORE the plugin applies;
 * apply() resolves route.algorithm by name at registry-resolve time. The
 * name must be unique — register() throws on duplicates.
 */
