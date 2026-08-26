/**
 * dsh-model-router — global exponential backoff store for failing candidates.
 *
 * A real `provider + model` that fails dispatch is suppressed from selection
 * for a cooldown that starts at `DEFAULT_INITIAL_MS` (30s), doubles per
 * successive failure, caps at `DEFAULT_MAX_MS` (8h), and fully resets on a
 * successful dispatch. The store is GLOBAL across all routes of one plugin
 * instance: one live instance shares a single store (installed as
 * `ctx[BACKOFF]` in lib/index.js apply), so a candidate failing in route A
 * is suppressed in route B too. Keys use the same `provider + "\u0000" + model`
 * scheme as lib/routing.js `key()`.
 */

/** Initial cooldown for a first failure: 30 seconds. */
export const DEFAULT_INITIAL_MS = 30_000;

/** Ceiling on the cooldown window: 8 hours. */
export const DEFAULT_MAX_MS = 8 * 60 * 60 * 1000;

/**
 * Symbol used as the ctx property key for the per-plugin backoff store.
 * Factories read `ctx[BACKOFF]` (falling back to `noopBackoff`) so unit
 * tests can build instances with fake ctx and reach the live store via the
 * real `ctx[BACKOFF]`.
 */
export const BACKOFF = Symbol("dsh-model-router.backoff");

/**
 * Create an exponential-backoff store of failed-candidate cooldowns.
 * @param {{ now?: () => number }} [opts] - injectable clock for tests.
 */
export function createBackoffStore({ now = () => Date.now() } = {}) {
	/** provider+model key -> current { failures, untilMs }. */
	const entries = new Map();
	return {
		/**
		 * @returns true iff no entry, or the cooldown has elapsed.
		 */
		isUsable(provider, model) {
			const entry = entries.get(key(provider, model));
			return !entry || now() >= entry.untilMs;
		},
		/** Record one failure, escalating (and extending) the cooldown. */
		recordFailure(provider, model) {
			const entry = entries.get(key(provider, model));
			const failures = (entry?.failures ?? 0) + 1;
			entries.set(key(provider, model), {
				failures,
				untilMs: now() + Math.min(DEFAULT_INITIAL_MS * 2 ** (failures - 1), DEFAULT_MAX_MS)
			});
		},
		/** Full reset: a successful dispatch makes the candidate usable immediately. */
		reset(provider, model) {
			entries.delete(key(provider, model));
		},
		/** Swap the clock (kept as a mutable closure variable). */
		setNow(fn) {
			now = fn;
		}
	};
}

/** Backoff that never suppresses anything, for factories without a store. */
export const noopBackoff = {
	isUsable: () => true,
	recordFailure() {},
	reset() {}
};

const key = (provider, model) => `${provider}\u0000${model}`;
