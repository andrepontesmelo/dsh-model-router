/**
 * dsh-model-router — declare VIRTUAL model ids bound to a routing algorithm
 * over real provider/model candidates. Using a virtual id anywhere
 * (agent options, model picker) transparently dispatches to a real provider
 * chosen by the algorithm, with failover.
 *
 * Seam: a shim LlmAdapter registered per virtual PROVIDER, grouping routes
 * that share one provider id (see lib/shim.js).
 * Failover: an `agent/request-error` waterfall listener that marks the
 * failed candidate and returns `{ kind: "retry" }` while live candidates
 * remain (same seam as the shipped dsh-llm-retry plugin).
 *
 * Settings: mirrors the dsh-llm-deepseek / dsh-agent-default-model pattern —
 * `installSettingsSection(ctx, NS, Config, entry, ...)` so a mounted settings
 * provider can override routes live; without one, the composition entry is
 * used as-is. Live edits are detected via lib/routes.js group signatures: a
 * provider whose shape changed gets a fresh shim (and fresh algorithm state),
 * an unchanged provider keeps its live shim untouched.
 *
 * Config schema is schemastery (the DSH fork of zod): callable (`schema(x)`
 * resolves) and carrying `toJSON()`/`~standard.validate` — both required by
 * the settings provider and the cordis loader. Real `zod` schemas are not
 * callable and cannot be passed to `installSettingsSection`.
 */
import z from "@deepseek-ai/schemastery";
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import { defaultRegistry } from "./routing.js";
import { normalizeRoute, groupRoutes, validateRoutes, groupSignature } from "./routes.js";
import { RouterShim } from "./shim.js";
import { BACKOFF, createBackoffStore } from "./backoff.js";

export const name = "dsh-model-router";
export const inject = ["llm"];

const NS = settingsNamespace("dsh-model-router");

const candidate = z.object({
	provider: z.string().required(),
	model: z.string().required()
});

const route = z.object({
	id: z.string().required(),
	// Virtual provider id this route registers under. Defaults to the
	// route's own id (backward compatible: one route = one provider).
	// Routes sharing a provider id form ONE picker group advertising one
	// virtual model each (e.g. provider 'routed' with models 'routed' and
	// 'strong').
	provider: z.string(),
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
 * Install the plugin.
 * @param ctx - Cordis context with the `llm` service injected.
 * @param config - validated plugin config (composition entry).
 */
export function apply(ctx, config) {
	const entry = Config(config); // normalize defaults (e.g. routes: [])
	validateRoutes(entry.routes);
	// ONE global backoff store per plugin instance, shared by every algorithm
	// instance: a candidate failing in any route cools for ALL routes
	// (lib/backoff.js). Installed on ctx before syncAdapters so the factories
	// created below read it; nothing to dispose (in-memory, GC with ctx).
	ctx[BACKOFF] = createBackoffStore();
	// `source` yields the current config: the composition entry, or the live
	// resolved settings scope once a settings provider is mounted.
	let source = () => entry;
	const currentRoutes = () => source().routes;

	/** provider id -> { shim, handle, signature } for the registered virtual adapters. */
	const providerStates = new Map();

	/**
	 * (Re)register one shim adapter per virtual PROVIDER from the current
	 * config. Routes sharing `provider` (default: the route id) are grouped
	 * under that one adapter; the virtual model id picks the route.
	 *
	 * A provider that disappeared, or whose group SHAPE changed (settings
	 * edit), disposes its shim and registers a fresh one; an unchanged group
	 * keeps its live shim, algorithm instances, and round-robin cursor state.
	 */
	const syncAdapters = () => {
		const raw = currentRoutes();
		validateRoutes(raw);
		const nextGroups = groupRoutes(raw.map(normalizeRoute));
		// Dispose shims for providers that disappeared or changed shape.
		for (const [provider, state] of providerStates) {
			const group = nextGroups.get(provider);
			if (!group || state.signature !== groupSignature(group)) {
				state.handle();
				providerStates.delete(provider);
			}
		}
		// Register shims for new (or just-disposed) providers.
		for (const [provider, group] of nextGroups) {
			if (providerStates.has(provider)) continue;
			const routes = group.map((route) => ({
				...route,
				algorithmInstance: defaultRegistry.resolve(route.algorithm)(ctx, raw)
			}));
			// Third arg = shared backoff store: the shim stamps failed attempts
			// with their earned sleep window and lists sleepers on exhaustion.
			const shim = new RouterShim(ctx.llm, routes, ctx[BACKOFF]);
			const handle = ctx.llm.registerAdapter([provider], shim);
			providerStates.set(provider, { shim, handle, signature: groupSignature(group) });
		}
	};

	installSettingsSection(ctx, NS, Config, entry, {
		setSource: (current) => {
			source = current;
		},
		onChange: syncAdapters,
		// Reject plugin-invalid edits AT WRITE TIME: dsh-settings runs this
		// validate hook on the resolved candidate BEFORE persisting, so a
		// schema-valid but router-invalid section (e.g. duplicate advertised
		// model within a group) throws, nothing is stored, and the live shims
		// keep serving the previous config.
		validate: (value) => validateRoutes(value.routes)
	});

	syncAdapters();

	// Failover: when a virtual route's dispatch errored, the shim records the
	// failed candidate and reports whether a live candidate remains to retry.
	// Mirrors the dsh-llm-retry listener shape.
	const listener = ctx.on("agent/request-error", (payload, next) => {
		const state = providerStates.get(payload.provider);
		if (!state || !payload.signal) return next();
		return state.shim.requestFailed(payload.signal, payload.provenance) ? Promise.resolve({ kind: "retry" }) : next();
	});

	// Own teardown: dispose the failover listener and every registration
	// handle this apply created (registerAdapter rides the app context, not
	// this plugin's fiber, so the handles must be released explicitly).
	ctx.effect(() => () => {
		listener();
		for (const { handle } of providerStates.values()) handle();
		providerStates.clear();
	});
}
