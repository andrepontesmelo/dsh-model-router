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
 *
 * The store also FEEDS THE PROVENANCE ANNOTATIONS (lib/shim.js):
 * `peekWindowMs` lets the shim stamp a failed attempt's error text with the
 * window that failure earns ("(sleep 30s)"), and `remainingMs` lets the
 * exhaustion error list who is sleeping and for how long. `formatWindow`
 * renders both human-readable.
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
		/**
		 * Peek WITHOUT recording: the cooldown window the candidate's NEXT
		 * recordFailure would earn right now. The shim stamps this onto a
		 * failure's error text (the "sleep" annotation) while recording itself
		 * stays in `requestFailed`, so the two stay decoupled by design.
		 * @returns window in ms.
		 */
		peekWindowMs(provider, model) {
			const failures = entries.get(key(provider, model))?.failures ?? 0;
			return Math.min(DEFAULT_INITIAL_MS * 2 ** failures, DEFAULT_MAX_MS);
		},
		/**
		 * Live remaining cooldown for one candidate — what the exhaustion
		 * error lists, answering "when can this route serve again?".
		 * @returns ms left (0 once elapsed), or null when never cooled.
		 */
		remainingMs(provider, model) {
			const entry = entries.get(key(provider, model));
			return entry ? Math.max(0, entry.untilMs - now()) : null;
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
	reset() {},
	// No store, nothing to report: null makes the shim omit every annotation.
	peekWindowMs: () => null,
	remainingMs: () => null
};

/**
 * Human-readable cooldown window, mirroring the web GUI duration style
 * ("45.2s" under a minute, "2m42s" above) plus the hours branch the ladder
 * needs past one hour (the 8h cap renders as "8h0m", not "480m0s").
 * @param {number} ms - duration in milliseconds.
 * @returns display string.
 */
export function formatWindow(ms) {
	const s = ms / 1000;
	if (s < 60) return `${Math.round(s * 10) / 10}s`;
	const whole = Math.round(s);
	if (whole < 3600) return `${Math.floor(whole / 60)}m${whole % 60}s`;
	return `${Math.floor(whole / 3600)}h${Math.floor((whole % 3600) / 60)}m`;
}

const key = (provider, model) => `${provider}\u0000${model}`;
