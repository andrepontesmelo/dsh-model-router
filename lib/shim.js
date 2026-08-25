/**
 * dsh-model-router — virtual-provider shim adapter.
 *
 * Registers under a VIRTUAL provider (a group of routes sharing one
 * provider id) and delegates each prepared call to a real registered
 * adapter picked by the matching route's routing algorithm. The virtual
 * MODEL id (request model) selects the route within the group.
 *
 * PROVEN MECHANICS (proved in-tree by test/index.test.js):
 * - The real adapter is resolved by DIRECT registry lookup
 *   (\`ctx.llm.registration(realProvider).adapter.prepareCall(...)\`); the
 *   shim never re-enters the llm/stream waterfall, so one request fires
 *   `llm/stream` exactly once.
 * - The prepared `config` STAYS VIRTUAL (the runtime's `callConfigEquals`
 *   gate depends on it); provider/model are rewritten ONLY inside the
 *   stream-forwarding closure, and the real adapter never reads
 *   `options.provider` for identity.
 * - Per-request candidate state (failed set + live selection + rotation-
 *   consumed marker) is tracked per (signal, route) on the shim;
 *   exhaustion returns `undefined` so the error surfaces.
 * - The shim declares its own providerRetryPolicy stance so dsh-llm-retry
 *   does not consume retryable codes before this plugin's own
 *   `agent/request-error` failover listener sees them.
 */
import { LlmAdapter, LlmError } from "@deepseek-ai/dsh-llm";

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
	 * @param llm - the `ctx.llm` LlmRuntime instance.
	 * @param routes - routes sharing one provider id; each carries an
	 *   `algorithmInstance` (`{ select, onFailure, onSuccess? }`) and an
	 *   `advertisedModel` (its picker model id).
	 */
	constructor(llm, routes) {
		super();
		this.llm = llm;
		this.routes = routes;
		// Virtual model id -> route entry. The advertised model id defaults
		// to the route's own id (route 'pool' in group 'pool' -> pool/pool).
		this.byModel = new Map(routes.map((route) => [route.advertisedModel, route]));
		// signal -> { byRoute: Map<routeId, {failed, current, dispatched}>, current }
		this.requests = new WeakMap();
	}

	providerInfo(provider) {
		return { id: provider, name: `${provider}-router` };
	}

	/** dsh-llm-retry must not pre-empt the router's own failover listener. */
	providerRetryPolicy() {
		return ROUTER_RETRY_POLICY;
	}

	/**
	 * Advertise one virtual model per route in the picker catalog
	 * (dsh-host-apiproxy's buildModelCatalog drops provider groups with zero
	 * models — the base LlmAdapter default [] hid router routes). Conforms
	 * to the runtime's listModels validation: `provider` equals the provider
	 * arg (the group's provider id), non-empty string id/name, unique ids.
	 */
	listModels(provider) {
		return Promise.resolve(this.routes.map((route) => ({
			provider,
			id: route.advertisedModel,
			name: `${provider}/${route.advertisedModel}`
		})));
	}

	resolveModel(provider, model) {
		return Promise.resolve({ provider, id: model, name: model });
	}

	/** Per-request state for one route, handed to the algorithm. */
	call(signal, route) {
		let request = this.requests.get(signal);
		if (!request) {
			request = { byRoute: new Map(), current: null };
			this.requests.set(signal, request);
		}
		let call = request.byRoute.get(route.id);
		if (!call) {
			call = { failed: new Set(), current: null };
			request.byRoute.set(route.id, call);
		}
		return call;
	}

	/**
	 * One call for the failover protocol: record the failed candidate, then
	 * answer whether a retry should be attempted. Collapses the former
	 * `markFailed` + `hasCandidate` pair so the ordering invariant (mark
	 * BEFORE probe) lives inside the shim instead of the caller.
	 * @returns true if the route still has a live candidate to retry.
	 */
	requestFailed(signal, provenance) {
		const route = this.routeFor(signal, provenance);
		if (!route) return false;
		const call = this.call(signal, route);
		const resolved = provenance?.resolved;
		const candidate = route.candidates.find(({ provider, model }) => provider === resolved?.provider && model === resolved?.model) || call.current;
		if (candidate) route.algorithmInstance.onFailure(route, candidate, call);
		return route.algorithmInstance.select(route, call) !== void 0;
	}

	/**
	 * Internal: resolve the route a failover event belongs to — the route named
	 * by `provenance.route.model` when present, else the last-prepared route.
	 */
	routeFor(signal, provenance) {
		const model = provenance?.route?.model;
		return (model !== undefined && this.byModel.get(model)) || this.requests.get(signal)?.current?.route;
	}

	async prepareCall(provider, model, signal) {
		const requestSignal = signal ?? new AbortController().signal;
		const route = this.byModel.get(model);
		if (!route) throw new LlmError(`unknown virtual model "${model}" for routed provider "${provider}" (known: ${[...this.byModel.keys()].join(", ") || "none"})`, "NO_CANDIDATE");
		const call = this.call(requestSignal, route);
		const pick = route.algorithmInstance.select(route, call) ?? null;
		call.current = pick;
		// First dispatch of this request consumes the algorithm's dispatch
		// slot NOW (round-robin rotates here), not after the stream ends —
		// otherwise concurrent requests all read the same cursor position.
		route.algorithmInstance.onDispatch?.(route, pick, call);
		// The request's current ROUTE (pick state lives per-route in the call
		// object above; this entry only backs the failover route lookup).
		this.requests.get(requestSignal).current = { route };
		if (!pick) throw new LlmError(`routed model "${model}" (route "${route.id}") has no live candidates`, "NO_CANDIDATE");
		const realProvider = pick.provider;
		const realModel = pick.model;
		return {
			// Virtual identity: the runtime's callConfigEquals gate and the
			// agent loop's request reconstruction keep the virtual
			// provider/model; only the forwarding closure rewrites them.
			model: { provider, id: model, name: model },
			provenance: {
				route: { provider, model },
				resolved: { provider: realProvider, model: realModel }
			},
			stream: (options) => this.dispatch(realProvider, realModel, options, requestSignal, route, pick)
		};
	}

	/**
	 * Forward the real adapter's stream verbatim. A successful terminal finish
	 * (`stop` / `tool-calls` / `max-tokens`) resets the route's failed set AND
	 * the per-request `dispatched` marker, so a later request (even one
	 * reusing this signal) starts from the top of the candidate list and
	 * consumes a fresh rotation slot — both are per-request/attempt state,
	 * not process-lifetime. It also notifies the algorithm via its OPTIONAL
	 * `onSuccess` hook. Note the rotation itself no longer waits for this
	 * point: round-robin advances in `onDispatch` at pick time
	 * (lib/routing.js); `onSuccess` remains for custom algorithms.
	 */
	async *dispatch(provider, model, options, signal, route, pick) {
		const realCall = await this.llm.registration(provider).adapter.prepareCall(provider, model, signal);
		yield* this.forward(realCall.stream({ ...options, provider, model }), signal, route, pick);
	}

	async *forward(stream, signal, route, pick) {
		for await (const chunk of stream) {
			yield chunk;
			if (chunk?.type === "finish") {
				const kind = chunk.reason?.kind;
				if (kind !== "error" && kind !== "aborted") {
					const request = this.requests.get(signal);
					if (request) for (const call of request.byRoute.values()) {
						call.failed.clear();
						call.dispatched = false; // next request on this signal consumes afresh
					}
					route.algorithmInstance.onSuccess?.(route, pick, this.call(signal, route));
				}
			}
		}
	}
}
