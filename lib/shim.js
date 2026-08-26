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
import { noopBackoff, formatWindow } from "./backoff.js";

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
	 * @param [backoff] - the shared backoff store (`ctx[BACKOFF]`); stamps
	 *   failed attempts with their earned sleep window and names sleepers in
	 *   the exhaustion error. Defaults to `noopBackoff` (no annotations).
	 */
	constructor(llm, routes, backoff = noopBackoff) {
		super();
		this.llm = llm;
		this.routes = routes;
		this.backoff = backoff;
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
	 * Sleep annotation for the candidate that just failed: the cooldown
	 * window its NEXT recorded failure earns (peeked, NOT recorded — the
	 * recording stays right above in `requestFailed`, so under a concurrent
	 * failure of the same candidate the annotated window can read one step
	 * lower than what was actually recorded; cosmetic, self-heals).
	 * @returns "" with no store (`noopBackoff`) — no annotation at all.
	 */
	sleepSuffix(provider, model) {
		const ms = this.backoff.peekWindowMs(provider, model);
		return ms == null ? "" : ` (sleep ${formatWindow(ms)})`;
	}

	/**
	 * Exhaustion error text. When candidates are cooling, list each with its
	 * REMAINING cooldown read live — unlike the per-attempt annotations
	 * (earned window, a historical fact) this number answers "when can I
	 * retry?". With nothing cooling the text is byte-identical to the
	 * historical message.
	 */
	exhaustedMessage(model, route) {
		const sleeping = route.candidates.flatMap(({ provider, model: m }) => {
			const remaining = this.backoff.remainingMs(provider, m);
			return remaining != null && remaining > 0 ? [`${provider}/${m} ${formatWindow(remaining)}`] : [];
		}).join(", ");
		return `routed model "${model}" (route "${route.id}") has no live candidates${sleeping === "" ? "" : ` — sleeping: ${sleeping}`}`;
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
		if (!pick) throw new LlmError(this.exhaustedMessage(model, route), "NO_CANDIDATE");
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
	 * (`stop` / `tool-calls` / `max-tokens`) swaps FRESH per-route call
	 * records into this signal's request map — replace-on-success records:
	 * the old objects are never mutated, so a running failover chain keeps
	 * its private snapshot (marks + rotation marker) even when a sibling
	 * request succeeds concurrently, while every LATER call through the map
	 * starts clean: next request consumes afresh from the top of the
	 * candidate list and consumes a new rotation slot. It also notifies the
	 * algorithm via its OPTIONAL `onSuccess` hook. Note the rotation itself
	 * no longer waits for this point: round-robin advances in `onDispatch`
	 * at pick time (lib/routing.js); `onSuccess` remains for custom algorithms.
	 */
	async *dispatch(provider, model, options, signal, route, pick) {
		const realCall = await this.llm.registration(provider).adapter.prepareCall(provider, model, signal);
		yield* this.forward(realCall.stream({ ...options, provider, model }), signal, route, pick);
	}

	/**
	 * Forward the real adapter's stream verbatim — except that a failing
	 * attempt is annotated with its earned sleep window (see `sleepSuffix`),
	 * on BOTH failure surfaces: a terminal `error` finish chunk has its
	 * `reason.failure.message` rewritten before yielding, and a thrown stream
	 * error is rethrown as an `LlmError` carrying the suffix (cause chained
	 * to the original). Aborted streams are never annotated. The durable
	 * `llm/attempt` event records exactly this text, so the web provenance
	 * row reads e.g.
	 * `alpha/alpha-model — failed (SERVER: alpha down (sleep 30s))`.
	 *
	 * A successful terminal finish (`stop` / `tool-calls` / `max-tokens`)
	 * additionally swaps FRESH per-route call records into this signal's
	 * request map — replace-on-success records: any still-running failover
	 * chain keeps its private snapshot while every later call starts clean
	 * (see the swap below for details).
	 */
	async *forward(stream, signal, route, pick) {
		try {
			for await (const chunk of stream) {
				const reason = chunk?.type === "finish" ? chunk.reason : undefined;
				let out = chunk;
				if (reason?.kind === "error" && reason.failure)
					out = { ...chunk, reason: { ...reason, failure: { ...reason.failure, message: `${reason.failure.message}${this.sleepSuffix(pick.provider, pick.model)}` } } };
				yield out;
				if (out.type === "finish") {
					const kind = out.reason?.kind;
					if (kind !== "error" && kind !== "aborted") {
						const request = this.requests.get(signal);
						if (request) {
							// Replace-on-success records: entries are REPLACED with
							// virgin records instead of being cleared in place
							// (no `failed.clear()`, no `dispatched = false` on live
							// objects). Route ids stay stable, and the previous
							// `current` pick rides along so an ambiguous failover
							// event (a failure payload without resolvable
							// provenance) still blames the last-dispatched
							// candidate, exactly like v1. Everything else starts
							// clean on the next request.
							const fresh = new Map();
							for (const [id, prev] of request.byRoute) {
								fresh.set(id, { failed: new Set(), current: prev.current ?? null });
							}
							request.byRoute = fresh;
						}
						route.algorithmInstance.onSuccess?.(route, pick, this.call(signal, route));
					}
				}
			}
		} catch (error) {
			const suffix = signal.aborted ? "" : this.sleepSuffix(pick.provider, pick.model);
			if (!suffix) throw error;
			const options = { cause: error };
			if (Number.isInteger(error?.status)) options.status = error.status;
			throw new LlmError(`${error instanceof Error ? error.message : String(error)}${suffix}`, error?.code ?? "UNKNOWN", options);
		}
	}
}
