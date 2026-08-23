/**
 * dsh-model-router — virtual-provider shim adapter.
 *
 * Registers under a VIRTUAL provider route (the route id from config) and
 * delegates each prepared call to a real registered adapter picked by the
 * route's routing algorithm.
 *
 * PROVEN MECHANICS (see prototype/Shim.mjs, prototype/Delegation-proof.mjs):
 * - The real adapter is resolved by DIRECT registry lookup
 *   (`ctx.llm.registration(realProvider).adapter.prepareCall(...)`); the
 *   shim never re-enters the llm/stream waterfall, so one request fires
 *   `llm/stream` exactly once.
 * - The prepared `config` STAYS VIRTUAL (the runtime's `callConfigEquals`
 *   gate depends on it); provider/model are rewritten ONLY inside the
 *   stream-forwarding closure, and the real adapter never reads
 *   `options.provider` for identity.
 * - Per-request candidate state (failed set + live selection) is tracked
 *   keyed by `(provider, model)` on the shim, bounded by monotonic growth
 *   of the failed set; exhaustion returns `undefined` so the error surfaces.
 * - The shim declares its own providerRetryPolicy stance so dsh-llm-retry
 *   does not consume retryable codes before this plugin's own
 *   `agent/request-error` failover listener sees them.
 */
import { LlmAdapter, LlmError } from "@deepseek-ai/dsh-llm";

const key = (provider, model) => `${provider}\u0000${model}`;

/**
 * A retry policy that never matches: dsh-llm-retry checks
 * `retryableCodes.includes(failure.code)` and passes through to downstream
 * listeners (this plugin's failover) when nothing matches.
 */
const ROUTER_RETRY_POLICY = Object.freeze({
	mode: "normal",
	maxRetries: 0,
	retryableCodes: Object.freeze([]),
	backoff: Object.freeze({
		initialDelayMs: 0,
		maxDelayMs: 0,
		jitterRatio: 0
	})
});

export class RouterShim extends LlmAdapter {
	/**
	 * @param llm  - the `ctx.llm` LlmRuntime instance.
	 * @param route - validated route: `{ id, model?, algorithm, candidates }`.
	 * @param algorithm - the algorithm instance: `{ select, onFailure }`.
	 */
	constructor(llm, route, algorithm) {
		super();
		this.llm = llm;
		this.route = route;
		this.algorithm = algorithm;
		// The single VIRTUAL model id this route advertises in the picker.
		// Defaults to the route's own id (route 'pool' advertises pool/pool).
		this.virtualModel = route.model || route.id;
		this.virtualName = `${route.id}/${this.virtualModel}`;
		this.failed = new Set(); // keyed by `${provider}\0${model}`
		this.lastPick = null;
	}

	providerInfo(provider) {
		return { id: provider, name: `${provider}-router` };
	}

	/** dsh-llm-retry must not pre-empt the router's own failover listener. */
	providerRetryPolicy() {
		return ROUTER_RETRY_POLICY;
	}

	/**
	 * Advertise exactly one virtual model for this route in the picker
	 * catalog (dsh-host-apiproxy's buildModelCatalog drops provider groups
	 * with zero models — the base LlmAdapter default [] hid router routes).
	 * Conforms to the runtime's listModels validation: `provider` equals the
	 * provider arg (the route id), non-empty string id/name, unique ids.
	 */
	listModels(provider) {
		return Promise.resolve([{ provider, id: this.virtualModel, name: this.virtualName }]);
	}

	resolveModel(provider, model) {
		return Promise.resolve({ provider, id: model, name: model });
	}

	/** Per-request context handed to the algorithm. */
	callCtx() {
		return { failed: this.failed };
	}

	/** Pick the next candidate per the algorithm; `undefined` when exhausted. */
	pick() {
		this.lastPick = this.algorithm.select(this.route, this.callCtx()) ?? null;
		return this.lastPick;
	}

	/**
	 * Predicate form of `pick()`: asks the algorithm what it would select
	 * WITHOUT recording `lastPick`. `select()` is required to be pure, so
	 * boolean checks (e.g. the failover listener's hasCandidate) never
	 * consume or advance algorithm state.
	 */
	peek() {
		return this.algorithm.select(this.route, this.callCtx()) ?? null;
	}

	hasCandidate() {
		return this.peek() !== null;
	}

	markCurrentFailed() {
		if (this.lastPick) this.algorithm.onFailure(this.route, this.lastPick, this.callCtx());
	}

	async prepareCall(provider, model, signal) {
		const pick = this.pick();
		if (!pick) throw new LlmError(`routed model "${model}" (route "${this.route.id}") has no live candidates`, "NO_CANDIDATE");
		const realProvider = pick.provider;
		const realModel = pick.model;
		const realCall = await this.llm.registration(realProvider).adapter.prepareCall(realProvider, realModel, signal);
		return {
			// Virtual identity: the runtime's callConfigEquals gate and the
			// agent loop's request reconstruction keep the virtual
			// provider/model; only the forwarding closure rewrites them.
			model: { provider, id: model, name: model },
			stream: (options) => this.forward(realCall.stream({ ...options, provider: realProvider, model: realModel }))
		};
	}

	/**
	 * Forward the real adapter's stream verbatim. A successful terminal finish
	 * (`stop` / `tool-calls` / `max-tokens`) resets the failed set, so a later
	 * request starts from the top of the candidate list again — failed
	 * candidates are per-request/attempt, not process-lifetime. It also
	 * notifies the algorithm of the success via its OPTIONAL `onSuccess`
	 * hook (round-robin advances its cursor there; priority has no such hook
	 * and is unaffected). `onSuccess` is called only on success, so a failed
	 * or aborted dispatch never advances the rotation.
	 */
	async *forward(stream) {
		for await (const chunk of stream) {
			yield chunk;
			if (chunk?.type === "finish") {
				const kind = chunk.reason?.kind;
				if (kind !== "error" && kind !== "aborted") {
					this.failed.clear();
					if (this.lastPick) this.algorithm.onSuccess?.(this.route, this.lastPick, this.callCtx());
				}
			}
		}
	}
}
