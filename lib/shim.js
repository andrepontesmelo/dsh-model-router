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
	 * @param route - validated route: `{ id, algorithm, candidates }`.
	 * @param algorithm - the algorithm instance: `{ select, onFailure }`.
	 */
	constructor(llm, route, algorithm) {
		super();
		this.llm = llm;
		this.route = route;
		this.algorithm = algorithm;
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

	listModels() {
		return Promise.resolve(this.route.candidates.map((candidate) => ({ id: this.route.id, name: this.route.id })));
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

	hasCandidate() {
		return this.pick() !== null;
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
			stream: (options) => realCall.stream({ ...options, provider: realProvider, model: realModel })
		};
	}
}
