/**
 * dsh-model-router — declare VIRTUAL model ids bound to a routing algorithm
 * over real provider/model candidates. Using a virtual id anywhere
 * (agent options, model picker) transparently dispatches to a real provider
 * chosen by the algorithm, with failover.
 *
 * Seam: a shim LlmAdapter registered per virtual route (see lib/shim.js).
 * Failover: an `agent/request-error` waterfall listener that marks the
 * failed candidate and returns `{ kind: "retry" }` while live candidates
 * remain (same seam as the shipped dsh-llm-retry plugin).
 *
 * Settings: mirrors the dsh-llm-deepseek / dsh-agent-default-model pattern —
 * `installSettingsSection(ctx, NS, Config, entry, ...)` so a mounted settings
 * provider can override routes live; without one, the composition entry is
 * used as-is.
 *
 * Config schema is schemastery (the DSH fork of zod): callable (`schema(x)`
 * resolves) and carrying `toJSON()`/`~standard.validate` — both required by
 * the settings provider and the cordis loader. Real `zod` schemas are not
 * callable and cannot be passed to `installSettingsSection`.
 */
import z from "@deepseek-ai/schemastery";
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import { defaultRegistry } from "./routing.js";
import { RouterShim } from "./shim.js";

export const name = "dsh-model-router";
export const inject = ["llm"];

const NS = settingsNamespace("dsh-model-router");

const candidate = z.object({
	provider: z.string().required(),
	model: z.string().required()
});

const route = z.object({
	id: z.string().required(),
	// Optional advertised virtual model id (shown in the model picker). When
	// absent, the route's own id is advertised (route 'pool' advertises
	// pool/pool). Plain z.string() is OPTIONAL in schemastery (only
	// .required() makes a field mandatory), so routes without `model` parse
	// identically — backward compatible.
	model: z.string(),
	algorithm: z.union(["priority", "round-robin"]).required(),
	candidates: z.array(candidate).required()
});

export const Config = z.object({
	routes: z.array(route).default([])
});

/**
 * Reject configs whose candidate graph delegates back into a
 * router-registered virtual provider — direct (`virtual-a -> virtual-a`) or
 * mutual (`a -> b -> a`). Without this, prepareCall re-enters the same shim
 * forever: RangeError, unbounded by any failed-set growth.
 */
function assertAcyclic(routes) {
	const byProvider = new Map(routes.map((r) => [r.id, r.candidates.map((c) => c.provider)]));
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
		visit(root.id, []);
	}
}

/**
 * Install the plugin.
 * @param ctx - Cordis context with the `llm` service injected.
 * @param config - validated plugin config (composition entry).
 */
export function apply(ctx, config) {
	const entry = Config(config); // normalize defaults (e.g. routes: [])
	assertAcyclic(entry.routes);
	// `source` yields the current config: the composition entry, or the live
	// resolved settings scope once a settings provider is mounted.
	let source = () => entry;
	const currentRoutes = () => source().routes;

	/** route id -> { shim, handle } for the registered virtual adapters. */
	const routeStates = new Map();

	/** (Re)register a shim adapter per virtual route from the current config. */
	const syncAdapters = () => {
		const ids = new Set(currentRoutes().map((r) => r.id));
		// Dispose shims for routes that disappeared.
		for (const [id, state] of routeStates) {
			if (!ids.has(id)) {
				state.handle();
				routeStates.delete(id);
			}
		}
		// Register shims for new routes.
		for (const r of currentRoutes()) {
			if (routeStates.has(r.id)) continue;
			const algorithm = defaultRegistry.resolve(r.algorithm)(ctx, currentRoutes());
			const shim = new RouterShim(ctx.llm, r, algorithm);
			const handle = ctx.llm.registerAdapter([r.id], shim);
			routeStates.set(r.id, { shim, handle });
		}
	};

	installSettingsSection(ctx, NS, Config, entry, {
		setSource: (current) => {
			source = current;
		},
		onChange: syncAdapters
	});

	syncAdapters();

	// Failover: when a virtual route's dispatch errored, mark the candidate
	// failed and retry while live candidates remain. Mirrors the prototype
	// proof and the dsh-llm-retry listener shape.
	const listener = ctx.on("agent/request-error", (payload, next) => {
		const state = routeStates.get(payload.provider);
		if (!state) return next();
		state.shim.markCurrentFailed();
		return state.shim.hasCandidate() ? Promise.resolve({ kind: "retry" }) : next();
	});

	// Own teardown: dispose the failover listener and every registration
	// handle this apply created (registerAdapter rides the app context, not
	// this plugin's fiber, so the handles must be released explicitly).
	ctx.effect(() => () => {
		listener();
		for (const { handle } of routeStates.values()) handle();
		routeStates.clear();
	});
}
