/**
 * dsh-model-router scaffold smoke test.
 *
 * Proves, with no network and no API keys, that:
 *   1. the plugin Config parses (including the empty-defaults case);
 *   2. apply() registers one shim adapter per configured virtual route;
 *   3. the algorithm registry resolves both built-in names.
 *
 * Uses the same in-memory harness as the prototype proof: a bare Cordis
 * Context, a real LlmRuntime, and loop-free mock adapters.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Context } from "@deepseek-ai/cordis";
import { LlmRuntime, LlmAdapter, LlmError } from "@deepseek-ai/dsh-llm";
import { Config, apply } from "../lib/index.js";
import { createRegistry, defaultRegistry } from "../lib/routing.js";
import { SettingsProvider } from "@deepseek-ai/dsh-settings";
import { RouterShim } from "../lib/shim.js";

test("Config parses with defaults (empty routes)", () => {
	assert.deepEqual(Config({}), { routes: [] });
	assert.deepEqual(Config({ routes: [] }), { routes: [] });
	assert.deepEqual(Config({ routes: [
		{ id: "virtual-a", algorithm: "priority", candidates: [{ provider: "alpha", model: "alpha-model" }] }
	] }), { routes: [
		{ id: "virtual-a", algorithm: "priority", candidates: [{ provider: "alpha", model: "alpha-model" }] }
	] });
});

test("Config rejects an unknown algorithm name", () => {
	assert.throws(() => Config({ routes: [
		{ id: "virtual-a", algorithm: "turbo", candidates: [{ provider: "alpha", model: "alpha-model" }] }
	] }), /algorithm/);
});

test("Config accepts an optional per-route model field and normalizes", () => {
	// With `model`: field passes through unchanged.
	assert.deepEqual(Config({ routes: [
		{ id: "virtual-a", model: "chat", algorithm: "priority", candidates: [{ provider: "alpha", model: "alpha-model" }] }
	] }), { routes: [
		{ id: "virtual-a", model: "chat", algorithm: "priority", candidates: [{ provider: "alpha", model: "alpha-model" }] }
	] });
	// Without `model`: identical shape to the pre-field schema (backward compatible).
	assert.deepEqual(Config({ routes: [
		{ id: "virtual-a", algorithm: "priority", candidates: [{ provider: "alpha", model: "alpha-model" }] }
	] }), { routes: [
		{ id: "virtual-a", algorithm: "priority", candidates: [{ provider: "alpha", model: "alpha-model" }] }
	] });
});

/** Minimal in-memory adapter emitting a valid chunk stream, no network. */
class MockAdapter extends LlmAdapter {
	constructor(provider, model) {
		super();
		this.provider = provider;
		this.model = model;
	}
	providerInfo(provider) {
		return { id: provider, name: `${provider}-mock` };
	}
	async *stream() {
		yield { type: "text-delta", index: 0, text: `${this.provider}/${this.model}` };
		yield { type: "finish", reason: { kind: "stop" } };
	}
}

function setup(ctx, routes) {
	const llm = new LlmRuntime(ctx);
	llm.registerAdapter(["alpha"], new MockAdapter("alpha", "alpha-model"));
	if (routes.some((r) => r.candidates.some((c) => c.provider === "beta"))) {
		llm.registerAdapter(["beta"], new MockAdapter("beta", "beta-model"));
	}
	apply(ctx, { routes });
	return llm;
}

test("apply() registers one shim adapter per configured virtual route", () => {
	const ctx = new Context();
	const routes = [
		{ id: "virtual-a", algorithm: "priority", candidates: [{ provider: "alpha", model: "alpha-model" }] },
		{ id: "virtual-b", algorithm: "round-robin", candidates: [{ provider: "beta", model: "beta-model" }] }
	];
	const llm = setup(ctx, routes);
	// Each virtual route id resolves to an adapter through the registry.
	const regA = llm.registration("virtual-a");
	const regB = llm.registration("virtual-b");
	assert.ok(regA.adapter instanceof RouterShim, "virtual-a registered a RouterShim");
	assert.ok(regB.adapter instanceof RouterShim, "virtual-b registered a RouterShim");
});

test("a virtual route delegates to the real adapter via direct registration lookup", async () => {
	const ctx = new Context();
	const llm = setup(ctx, [
		{ id: "virtual-a", algorithm: "priority", candidates: [{ provider: "alpha", model: "alpha-model" }] }
	]);
	const prepared = await llm.prepareCall({ provider: "virtual-a", model: "virtual-a" }, new AbortController().signal);
	assert.equal(prepared.config.provider, "virtual-a");
	const adapterCall = await llm.registration("virtual-a").adapter.prepareCall("virtual-a", "virtual-a", new AbortController().signal);
	assert.deepEqual(adapterCall.provenance, {
		route: { provider: "virtual-a", model: "virtual-a" },
		resolved: { provider: "alpha", model: "alpha-model" }
	});
	const chunks = [];
	for await (const chunk of prepared.stream({ provider: "virtual-a", model: "virtual-a", messages: [] })) {
		chunks.push(chunk);
	}
	const text = chunks.filter((c) => c.type === "text-delta").map((c) => c.text).join("");
	assert.equal(text, "alpha/alpha-model");
	assert.equal(chunks.at(-1).reason.kind, "stop");
});

test("shim advertises exactly one picker model for the route (default virtual id)", async () => {
	const ctx = new Context();
	const llm = setup(ctx, [
		{ id: "virtual-a", algorithm: "priority", candidates: [{ provider: "alpha", model: "alpha-model" }] }
	]);
	// Runs through the runtime's listModels validation: provider === arg,
	// non-empty string id/name, unique ids. No adapter-shape errors.
	const models = await llm.listModels("virtual-a");
	assert.equal(models.length, 1);
	assert.deepEqual(models[0], { provider: "virtual-a", id: "virtual-a", name: "virtual-a/virtual-a" });
	// The advertised entry resolves: resolveModelInfo must accept our
	// provider+virtualModel without throwing (as buildModelCatalog does).
	const shim = llm.registration("virtual-a").adapter;
	assert.equal(shim.byModel.get("virtual-a")?.advertisedModel, "virtual-a"); // default = route id
	const resolved = await llm.resolveModelInfo("virtual-a", "virtual-a");
	assert.equal(resolved.id, "virtual-a");
});

test("shim advertises the explicit route.model field when configured", async () => {
	const ctx = new Context();
	const llm = setup(ctx, [
		{ id: "virtual-a", model: "routed-chat", algorithm: "priority", candidates: [{ provider: "alpha", model: "alpha-model" }] }
	]);
	const models = await llm.listModels("virtual-a");
	assert.equal(models.length, 1);
	assert.deepEqual(models[0], { provider: "virtual-a", id: "routed-chat", name: "virtual-a/routed-chat" });
	const shim = llm.registration("virtual-a").adapter;
	assert.equal(shim.byModel.get("routed-chat")?.advertisedModel, "routed-chat");
	const resolved = await llm.resolveModelInfo("virtual-a", "routed-chat");
	assert.equal(resolved.id, "routed-chat");
});

test("failover: alpha failure -> retry -> beta serves; exhaustion -> no retry", async () => {
	const ctx = new Context();
	const llm = new LlmRuntime(ctx);
	// `alpha` fails every dispatch; `beta` is the healthy fallback.
	llm.registerAdapter(["alpha"], new (class extends LlmAdapter {
		providerInfo(p) { return { id: p, name: "alpha-mock" }; }
		async *stream() { throw new LlmError("alpha down", "SERVER"); }
	})());
	llm.registerAdapter(["beta"], new MockAdapter("beta", "beta-model"));
	apply(ctx, { routes: [
		{ id: "virtual-a", algorithm: "priority", candidates: [
			{ provider: "alpha", model: "alpha-model" },
			{ provider: "beta", model: "beta-model" }
		] }
	] });

	const request = { provider: "virtual-a", model: "virtual-a", messages: [] };
	const signal = new AbortController().signal;
	const collect = async () => {
		const prepared = await llm.prepareCall(request, signal);
		const chunks = [];
		for await (const chunk of prepared.stream(request)) chunks.push(chunk);
		return chunks;
	};
	// First dispatch goes to alpha and fails mid-stream.
	const c1 = await collect();
	assert.equal(c1.at(-1).reason.kind, "error");
	assert.equal(c1.at(-1).reason.failure.code, "SERVER");
	// The plug-in's failover listener marks alpha failed and returns retry
	// because beta is still live.
	const action = await ctx.waterfall({}, "agent/request-error", {
		provider: "virtual-a", failure: c1.at(-1).reason.failure, signal
	}, () => Promise.resolve(void 0));
	assert.deepEqual(action, { kind: "retry" });
	// Re-dispatch now lands on beta.
	const c2 = await collect();
	const text = c2.filter((c) => c.type === "text-delta").map((c) => c.text).join("");
	assert.equal(text, "beta/beta-model");
	// Marking the SERVED candidate (beta — the corrected markCurrentFailed
	// always marks the last-picked candidate, not whatever hasCandidate
	// last probed) failed leaves alpha live again, so the listener retries.
	const stillRetry = await ctx.waterfall({}, "agent/request-error", {
		provider: "virtual-a", failure: c1.at(-1).reason.failure, signal
	}, () => Promise.resolve(void 0));
	assert.deepEqual(stillRetry, { kind: "retry" });
	// Genuine exhaustion (all real candidates failing) is covered by the
	// dedicated "priority: exhaustion stops retrying" test below, which walks
	// fresh failing dispatches instead of re-firing a stale failure.
});

test("failover handles a concrete adapter prepareCall failure", async () => {
	const ctx = new Context();
	const llm = new LlmRuntime(ctx);
	llm.registerAdapter(["alpha"], new (class extends MockAdapter {
		prepareCall() { throw new LlmError("alpha prepare down", "SERVER"); }
	})("alpha", "alpha-model"));
	llm.registerAdapter(["beta"], new MockAdapter("beta", "beta-model"));
	apply(ctx, { routes: [{ id: "virtual-a", algorithm: "priority", candidates: [
		{ provider: "alpha", model: "alpha-model" },
		{ provider: "beta", model: "beta-model" }
	] }] });
	const signal = new AbortController().signal;
	const request = { provider: "virtual-a", model: "virtual-a", messages: [], signal };
	const first = await llm.prepareCall(request, signal);
	const firstChunks = [];
	for await (const chunk of first.stream(request)) firstChunks.push(chunk);
	assert.equal(firstChunks.at(-1).reason.kind, "error");
	assert.deepEqual(await ctx.waterfall({}, "agent/request-error", {
		provider: "virtual-a", provenance: first.provenance, failure: firstChunks.at(-1).reason.failure, signal
	}, () => Promise.resolve(void 0)), { kind: "retry" });
	const second = await llm.prepareCall(request, signal);
	const chunks = [];
	for await (const chunk of second.stream(request)) chunks.push(chunk);
	assert.equal(chunks.filter((chunk) => chunk.type === "text-delta").map((chunk) => chunk.text).join(""), "beta/beta-model");
});

test("algorithm registry resolves both built-in names", () => {
	assert.ok(defaultRegistry.has("priority"));
	assert.ok(defaultRegistry.has("round-robin"));
	assert.deepEqual([...defaultRegistry.names()].sort(), ["priority", "round-robin"]);
	const priority = defaultRegistry.resolve("priority");
	assert.equal(typeof priority, "function");
	const rr = defaultRegistry.resolve("round-robin");
	assert.equal(typeof rr, "function");
});

test("unknown algorithm name throws from the registry", () => {
	assert.throws(() => defaultRegistry.resolve("turbo"), /unknown routing algorithm/);
});

test("registry supports plugging a new algorithm without restructuring", () => {
	const registry = createRegistry().register("priority", defaultRegistry.resolve("priority"))
		.register("round-robin", defaultRegistry.resolve("round-robin"));
	const custom = () => ({ select: () => void 0, onFailure: () => {} });
	registry.register("custom", custom);
	assert.equal(registry.resolve("custom"), custom);
	assert.ok(registry.has("custom"));
});

// --- priority algorithm (ordered failover) ---

/** Mock adapter whose stream fails unless `ok` is true. */
function failingMock(provider, model, ok = false) {
	return new (class extends LlmAdapter {
		providerInfo(p) { return { id: p, name: `${p}-mock` }; }
		async *stream() {
			if (!ok) throw new LlmError(`${provider} down`, "SERVER");
			yield { type: "text-delta", index: 0, text: `${provider}/${model}` };
			yield { type: "finish", reason: { kind: "stop" } };
		}
	})();
}

/** Register n failing mocks as alpha, beta, gamma and dispatch once. */
function prioritySetup({ alphaOk = false, betaOk = false, gammaOk = false, unregisteredLead = false } = {}) {
	const ctx = new Context();
	const llm = new LlmRuntime(ctx);
	llm.registerAdapter(["alpha"], failingMock("alpha", "alpha-model", alphaOk));
	llm.registerAdapter(["beta"], failingMock("beta", "beta-model", betaOk));
	llm.registerAdapter(["gamma"], failingMock("gamma", "gamma-model", gammaOk));
	const candidates = [
		...(unregisteredLead ? [{ provider: "ghost", model: "ghost-model" }] : []),
		{ provider: "alpha", model: "alpha-model" },
		{ provider: "beta", model: "beta-model" },
		{ provider: "gamma", model: "gamma-model" }
	];
	apply(ctx, { routes: [{ id: "virtual-p", algorithm: "priority", candidates }] });
	const request = { provider: "virtual-p", model: "virtual-p", messages: [] };
	const signal = new AbortController().signal;
	const collect = async () => {
		const prepared = await llm.prepareCall(request, signal);
		const chunks = [];
		for await (const chunk of prepared.stream(request)) chunks.push(chunk);
		return chunks;
	};
	return { ctx, llm, collect, request, signal };
}

test("priority: first live candidate wins", async () => {
	const { collect } = prioritySetup({ alphaOk: true });
	const chunks = await collect();
	const text = chunks.filter((c) => c.type === "text-delta").map((c) => c.text).join("");
	assert.equal(text, "alpha/alpha-model");
	assert.equal(chunks.at(-1).reason.kind, "stop");
});

test("priority: candidate with no registered adapter is skipped at selection time", async () => {
	const { collect } = prioritySetup({ unregisteredLead: true, alphaOk: true });
	// `ghost` has no adapter; alpha must be picked anyway.
	const chunks = await collect();
	const text = chunks.filter((c) => c.type === "text-delta").map((c) => c.text).join("");
	assert.equal(text, "alpha/alpha-model");
});

test("priority: failover walks candidates in order on repeated failures", async () => {
	const { ctx, collect, request, signal } = prioritySetup({ alphaOk: false, betaOk: true });
	// alpha fails -> error finish; failover listener marks alpha, retries; beta serves.
	const c1 = await collect();
	assert.equal(c1.at(-1).reason.kind, "error");
	assert.equal(c1.at(-1).reason.failure.code, "SERVER");
	const a1 = await ctx.waterfall({}, "agent/request-error", {
		provider: request.provider, failure: c1.at(-1).reason.failure, signal
	}, () => Promise.resolve(void 0));
	assert.deepEqual(a1, { kind: "retry" }); // beta still live
	const c2 = await collect();
	const text = c2.filter((c) => c.type === "text-delta").map((c) => c.text).join("");
	assert.equal(text, "beta/beta-model");
});

test("priority: exhaustion stops retrying and surfaces the error", async () => {
	const { ctx, llm, collect, request, signal } = prioritySetup({ alphaOk: false, betaOk: false, gammaOk: false });
	// First dispatch fails (alpha), second fails (beta), third fails (gamma).
	const c1 = await collect();
	assert.equal(c1.at(-1).reason.kind, "error");
	const a1 = await ctx.waterfall({}, "agent/request-error", {
		provider: request.provider, failure: c1.at(-1).reason.failure, signal
	}, () => Promise.resolve(void 0));
	assert.deepEqual(a1, { kind: "retry" }); // beta still live
	const c2 = await collect();
	assert.equal(c2.at(-1).reason.kind, "error");
	const a2 = await ctx.waterfall({}, "agent/request-error", {
		provider: request.provider, failure: c2.at(-1).reason.failure, signal
	}, () => Promise.resolve(void 0));
	assert.deepEqual(a2, { kind: "retry" }); // gamma still live
	const c3 = await collect();
	assert.equal(c3.at(-1).reason.kind, "error");
	// Mark gamma failed too; all three are now exhausted -> the failover
	// listener stops returning retry, so the original error surfaces.
	const a3 = await ctx.waterfall({}, "agent/request-error", {
		provider: request.provider, failure: c3.at(-1).reason.failure, signal
	}, () => Promise.resolve(void 0));
	assert.equal(a3, void 0);
	// A fresh dispatch now throws NO_CANDIDATE from the shim.
	await assert.rejects(llm.prepareCall(request, signal), /no live candidates/);
});

test("priority: failed set resets after a successful dispatch", async () => {
	const { ctx, llm, request, signal } = prioritySetup({ alphaOk: false, betaOk: true });
	// alpha fails once, beta serves -> success resets the failed set.
	const c1 = await llm.prepareCall(request, signal);
	const chunks1 = [];
	for await (const chunk of c1.stream(request)) chunks1.push(chunk);
	assert.equal(chunks1.at(-1).reason.kind, "error");
	await ctx.waterfall({}, "agent/request-error", {
		provider: request.provider, failure: chunks1.at(-1).reason.failure, signal
	}, () => Promise.resolve(void 0));
	const c2 = await llm.prepareCall(request, signal);
	const chunks2 = [];
	for await (const chunk of c2.stream(request)) chunks2.push(chunk);
	const text2 = chunks2.filter((c) => c.type === "text-delta").map((c) => c.text).join("");
	assert.equal(text2, "beta/beta-model");
	// After the successful beta dispatch, alpha is usable again on the next request.
	const c3 = await llm.prepareCall(request, signal);
	const chunks3 = [];
	for await (const chunk of c3.stream(request)) chunks3.push(chunk);
	assert.equal(chunks3.at(-1).reason.kind, "error"); // alpha picked again (failed set reset)
});

// --- round-robin (rotating cursor) ---

/** Register alpha (+beta, +opt gamma) mocks and dispatch through a round-robin route. */
function rrSetup({ alphaOk = true, betaOk = true, unregisteredLead = false, withGamma = false } = {}) {
	const ctx = new Context();
	const llm = new LlmRuntime(ctx);
	llm.registerAdapter(["alpha"], failingMock("alpha", "alpha-model", alphaOk));
	llm.registerAdapter(["beta"], failingMock("beta", "beta-model", betaOk));
	if (withGamma) llm.registerAdapter(["gamma"], failingMock("gamma", "gamma-model", true));
	const candidates = [
		...(unregisteredLead ? [{ provider: "ghost", model: "ghost-model" }] : []),
		{ provider: "alpha", model: "alpha-model" },
		{ provider: "beta", model: "beta-model" },
		...(withGamma ? [{ provider: "gamma", model: "gamma-model" }] : [])
	];
	apply(ctx, { routes: [{ id: "virtual-r", algorithm: "round-robin", candidates }] });
	const request = { provider: "virtual-r", model: "virtual-r", messages: [] };
	const signal = new AbortController().signal;
	const collect = async () => {
		const prepared = await llm.prepareCall(request, signal);
		const chunks = [];
		for await (const chunk of prepared.stream(request)) chunks.push(chunk);
		return chunks;
	};
	return { ctx, llm, collect, request, signal };
}

test("round-robin: consecutive requests rotate alpha -> beta -> alpha", async () => {
	const { collect, llm } = rrSetup();
	const text = async () => (await collect()).filter((c) => c.type === "text-delta").map((c) => c.text).join("");
	assert.equal(await text(), "alpha/alpha-model");
	assert.equal(await text(), "beta/beta-model");
	assert.equal(await text(), "alpha/alpha-model");
	// Position persists in the algorithm instance, independent of per-request failures.
});

test("round-robin: failed candidate skipped on retry within the same request", async () => {
	const { ctx, collect, request, signal } = rrSetup({ alphaOk: false, withGamma: true });
	// First dispatch lands on alpha (cursor 0) and fails.
	const c1 = await collect();
	assert.equal(c1.at(-1).reason.kind, "error");
	const a1 = await ctx.waterfall({}, "agent/request-error", {
		provider: request.provider, failure: c1.at(-1).reason.failure, signal
	}, () => Promise.resolve(void 0));
	assert.deepEqual(a1, { kind: "retry" });
	// The retry within the SAME request skips failed alpha and serves beta.
	const c2 = await collect();
	assert.equal(c2.filter((c) => c.type === "text-delta").map((c) => c.text).join(""), "beta/beta-model");
	// alpha consumed its slot AT DISPATCH TIME (cursor moved to beta), so
	// the retry to beta did NOT advance the cursor further. The next NEW
	// request therefore starts at beta and serves it.
	const c3 = await collect();
	assert.equal(c3.filter((c) => c.type === "text-delta").map((c) => c.text).join(""), "beta/beta-model");
});

test("round-robin: concurrent requests rotate before either answers (2026-08-25)", async () => {
	const ctx = new Context();
	const llm = new LlmRuntime(ctx);
	llm.registerAdapter(["alpha"], new MockAdapter("alpha", "alpha-model"));
	llm.registerAdapter(["beta"], new MockAdapter("beta", "beta-model"));
	apply(ctx, { routes: [{ id: "virtual-r", algorithm: "round-robin", candidates: [
		{ provider: "alpha", model: "alpha-model" },
		{ provider: "beta", model: "beta-model" }
	] }] });
	const shim = llm.registration("virtual-r").adapter;
	// Two SESSION-shaped requests: distinct signals (distinct conversations),
	// both prepared BEFORE either stream starts — the reported bug had both
	// landing on the same model because the cursor advanced only on success.
	const prepA = await shim.prepareCall("virtual-r", "virtual-r", new AbortController().signal);
	const prepB = await shim.prepareCall("virtual-r", "virtual-r", new AbortController().signal);
	assert.deepEqual(prepA.provenance.resolved, { provider: "alpha", model: "alpha-model" });
	assert.deepEqual(prepB.provenance.resolved, { provider: "beta", model: "beta-model" });
	// Both streams still complete independently and correctly.
	const drain = async (prepared) => {
		const chunks = [];
		for await (const chunk of prepared.stream({ provider: "virtual-r", model: "virtual-r", messages: [] })) chunks.push(chunk);
		return chunks.filter((c) => c.type === "text-delta").map((c) => c.text).join("");
	};
	assert.equal(await drain(prepA), "alpha/alpha-model");
	assert.equal(await drain(prepB), "beta/beta-model");
	// A third fresh request wraps back to alpha.
	const prepC = await shim.prepareCall("virtual-r", "virtual-r", new AbortController().signal);
	assert.deepEqual(prepC.provenance.resolved, { provider: "alpha", model: "alpha-model" });
});

test("round-robin onDispatch: one slot per request chain; retries re-entrant", () => {
	const ctx = { llm: { listProviders: () => [{ id: "alpha" }, { id: "beta" }, { id: "gamma" }] } };
	const instance = defaultRegistry.resolve("round-robin")(ctx, []);
	const route = { id: "r", algorithm: "round-robin", candidates: [
		{ provider: "alpha", model: "m" },
		{ provider: "beta", model: "m" },
		{ provider: "gamma", model: "m" }
	] };
	const call = { failed: new Set() };
	assert.equal(instance.select(route, call)?.provider, "alpha"); // pure peek
	instance.onDispatch(route, route.candidates[0], call);         // consumes slot, marks dispatched
	assert.equal(instance.select(route, call)?.provider, "beta");  // moved pre-stream
	instance.onDispatch(route, route.candidates[0], call);         // retry within request: guarded
	assert.equal(instance.select(route, call)?.provider, "beta");  // no extra slot consumed
});

test("round-robin: unregistered candidate skipped; exhaustion surfaces the error", async () => {
	const { ctx, collect, request, signal } = rrSetup({ alphaOk: false, betaOk: false, unregisteredLead: true });
	// ghost has no adapter -> skipped by liveness; alpha is picked and fails.
	const c1 = await collect();
	assert.equal(c1.at(-1).reason.kind, "error");
	const a1 = await ctx.waterfall({}, "agent/request-error", {
		provider: request.provider, failure: c1.at(-1).reason.failure, signal
	}, () => Promise.resolve(void 0));
	assert.deepEqual(a1, { kind: "retry" });
	// Retry skips failed alpha, lands on beta; beta fails too.
	const c2 = await collect();
	assert.equal(c2.at(-1).reason.kind, "error");
	// Mark beta failed -> no live candidates remain -> the failover listener
	// stops retrying, so the original error surfaces.
	const a2 = await ctx.waterfall({}, "agent/request-error", {
		provider: request.provider, failure: c2.at(-1).reason.failure, signal
	}, () => Promise.resolve(void 0));
	assert.equal(a2, void 0);
});

test("delegation cycles are rejected at apply time; acyclic nesting is legal", async () => {
	const ctx = new Context();
	const llm = new LlmRuntime(ctx);
	llm.registerAdapter(["alpha"], new MockAdapter("alpha", "alpha-model"));
	// Direct self-reference: virtual-p lists itself as a candidate. Without
	// the guard this recurses in RouterShim.prepareCall until RangeError.
	assert.throws(
		() => apply(ctx, { routes: [
			{ id: "virtual-p", algorithm: "priority", candidates: [{ provider: "virtual-p", model: "virtual-p" }, { provider: "alpha", model: "alpha-model" }] }
		] }),
		{ message: 'dsh-model-router: route "virtual-p" has a delegation cycle (virtual-p -> virtual-p); virtual ids must not appear as their own (or each other\'s) candidates' }
	);
	// Mutual cycle: a -> b -> a.
	assert.throws(
		() => apply(ctx, { routes: [
			{ id: "virtual-a", algorithm: "round-robin", candidates: [{ provider: "virtual-b", model: "m" }] },
			{ id: "virtual-b", algorithm: "priority", candidates: [{ provider: "virtual-a", model: "m2" }] }
		] }),
		{ message: 'dsh-model-router: route "virtual-a" has a delegation cycle (virtual-a -> virtual-b -> virtual-a); virtual ids must not appear as their own (or each other\'s) candidates' }
	);
	// Transitive cycle: a -> b -> c -> a.
	assert.throws(
		() => apply(ctx, { routes: [
			{ id: "virtual-a", algorithm: "priority", candidates: [{ provider: "virtual-b", model: "m" }] },
			{ id: "virtual-b", algorithm: "priority", candidates: [{ provider: "virtual-c", model: "m2" }] },
			{ id: "virtual-c", algorithm: "priority", candidates: [{ provider: "virtual-a", model: "m3" }] }
		] }),
		{ message: 'dsh-model-router: route "virtual-a" has a delegation cycle (virtual-a -> virtual-b -> virtual-c -> virtual-a); virtual ids must not appear as their own (or each other\'s) candidates' }
	);
	// Acyclic nesting is LEGAL: an outer virtual provider delegating to an
	// inner one is a supported feature (see the diamond delegation test).
	assert.doesNotThrow(() => apply(ctx, { routes: [
		{ id: "virtual-a", algorithm: "priority", candidates: [{ provider: "virtual-b", model: "m" }] },
		{ id: "virtual-b", algorithm: "priority", candidates: [{ provider: "alpha", model: "alpha-model" }] }
	] }));
});


test("diamond delegation: outer virtual provider dispatches through inner virtual provider to the concrete adapter", async () => {
	const ctx = new Context();
	const llm = new LlmRuntime(ctx);
	// `alpha` is a decoy real adapter; `beta` is the real one the inner route
	// targets. Both count their stream invocations.
	let alphaCalls = 0;
	let betaCalls = 0;
	llm.registerAdapter(["alpha"], new (class extends LlmAdapter {
		providerInfo(p) { return { id: p, name: "alpha-mock" }; }
		async *stream() {
			alphaCalls++;
			yield { type: "text-delta", index: 0, text: "ALPHA" };
			yield { type: "finish", reason: { kind: "stop" } };
		}
	})());
	llm.registerAdapter(["beta"], new (class extends LlmAdapter {
		providerInfo(p) { return { id: p, name: "beta-mock" }; }
		async *stream() {
			betaCalls++;
			yield { type: "text-delta", index: 0, text: "BETA" };
			yield { type: "finish", reason: { kind: "stop" } };
		}
	})());
	// Diamond: outer -> inner -> beta. The nested candidate names the inner
	// provider and its ADVERTISED model id (inner advertises its own id).
	apply(ctx, { routes: [
		{ id: "outer", algorithm: "priority", candidates: [
			{ provider: "inner", model: "inner" },
			{ provider: "alpha", model: "alpha-model" }
		] },
		{ id: "inner", algorithm: "priority", candidates: [
			{ provider: "beta", model: "beta-model" }
		] }
	] });

	// Request the OUTER virtual model; the stream echoes the virtual request
	// (the runtime's callConfigEquals gate depends on it).
	const request = { provider: "outer", model: "outer", messages: [] };
	const signal = new AbortController().signal;
	const prepared = await llm.prepareCall(request, signal);
	// Provenance of the outer prepareCall: first pick is the inner virtual
	// provider (resolution happens at dispatch time).
	if (prepared.provenance !== void 0) {
		assert.deepEqual(prepared.provenance.resolved, { provider: "inner", model: "inner" });
	}
	const chunks = [];
	for await (const chunk of prepared.stream(request)) chunks.push(chunk);
	assert.equal(chunks.filter((c) => c.type === "text-delta").map((c) => c.text).join(""), "BETA", "outer -> inner -> beta dispatched to the concrete adapter");
	assert.equal(chunks.at(-1).reason.kind, "stop");
	// The inner RouterShim got the call; the decoy alpha never did.
	assert.equal(betaCalls, 1, "inner route dispatched to beta exactly once");
	assert.equal(alphaCalls, 0, "decoy alpha never dispatched");
});
test("routes sharing one provider id form a single virtual provider with multiple models (user config)", async () => {
	const ctx = new Context();
	const llm = new LlmRuntime(ctx);
	llm.registerAdapter(["alpha"], new MockAdapter("alpha", "alpha-model"));
	llm.registerAdapter(["beta"], new MockAdapter("beta", "beta-model"));
	// The reported config shape: two routes, one virtual provider "routed",
	// virtual models "routed" and "strong".
	apply(ctx, { routes: [
		{ id: "routed", provider: "routed", algorithm: "priority", candidates: [
			{ provider: "alpha", model: "alpha-model" }
		] },
		{ id: "strong", provider: "routed", model: "strong", algorithm: "round-robin", candidates: [
			{ provider: "beta", model: "beta-model" }
		] }
	] });
	// ONE provider registration serves both virtual models...
	assert.ok(llm.registration("routed").adapter instanceof RouterShim);
	let threw = false;
	try { llm.registration("strong"); } catch { threw = true; }
	assert.ok(threw, "no separate provider 'strong' is registered");
	// ...and the picker advertises both models under provider "routed".
	const models = await llm.listModels("routed");
	assert.deepEqual(models.sort((a, b) => a.id.localeCompare(b.id)), [
		{ provider: "routed", id: "routed", name: "routed/routed" },
		{ provider: "routed", id: "strong", name: "routed/strong" }
	]);
	// Each virtual model dispatches through its own route's candidates.
	const collect = async (model) => {
		const prepared = await llm.prepareCall({ provider: "routed", model, messages: [] }, new AbortController().signal);
		const chunks = [];
		for await (const chunk of prepared.stream({ provider: "routed", model, messages: [] })) chunks.push(chunk);
		return chunks.filter((c) => c.type === "text-delta").map((c) => c.text).join("");
	};
	assert.equal(await collect("routed"), "alpha/alpha-model");
	assert.equal(await collect("strong"), "beta/beta-model");
	// An unknown virtual model under the routed provider errors cleanly.
	await assert.rejects(llm.prepareCall({ provider: "routed", model: "nope", messages: [] }, new AbortController().signal), /unknown virtual model/);
});
// Regression for the reported live bug (2026-08-25): route "strong/strong"
// resolved to free/ai-hub-mix/gpt-5.6-sol-disc, which failed mid-stream with
// AUTH [403] "account balance is insufficient" — and the turn ended without
// failover. Reproduces the exact user config shape (one virtual provider
// "routed", second candidate on another provider) and the FULL dispatch path:
// the real adapter's throw becomes a terminal finish:error chunk, the
// agent/request-error waterfall must return { kind: "retry" }, and the retry
// must land on the healthy candidate.
test("regression: 403 AUTH insufficient balance on first candidate fails over to second (reported strong/strong bug)", async () => {
	const ctx = new Context();
	const llm = new LlmRuntime(ctx);
	// `free` adapter: 403 AUTH mid-stream, exactly like the live
	// openai-compatible chat adapter on gpt-5.6-sol-disc.
	llm.registerAdapter(["free"], new (class extends LlmAdapter {
		providerInfo(p) { return { id: p, name: "free-mock" }; }
		async *stream() {
			yield { type: "text-delta", index: 0, text: "partial " };
			const err = new LlmError("[openai-compatible-chat/gpt-5.6-sol-disc] [403]: Your account balance is insufficient. Please recharge your account to continue using the API.", "AUTH");
			err.status = 403;
			throw err;
		}
	})());
	// `zai` adapter: healthy fallback.
	llm.registerAdapter(["zai"], new MockAdapter("zai", "zai/glm-5.3"));
	// The reported route shape: virtual provider "routed" (default route)
	// plus route "strong" advertising virtual model "strong".
	apply(ctx, { routes: [
		{ id: "routed", provider: "routed", algorithm: "priority", candidates: [
			{ provider: "free", model: "openrouter/stealth/ox-alpha" }
		] },
		{ id: "strong", provider: "routed", model: "strong", algorithm: "priority", candidates: [
			{ provider: "free", model: "ai-hub-mix/gpt-5.6-sol-disc" },
			{ provider: "zai", model: "zai/glm-5.3" }
		] }
	] });

	// AgentLoop.step-shaped dispatch of the strong/strong virtual model.
	const request = { provider: "routed", model: "strong", messages: [] };
	const signal = new AbortController().signal;
	const prepared = await llm.prepareCall(request, signal);
	// The live runtime copies adapterCall.provenance; the plugin's nested
	// dsh-llm copy does not. Failover must work through BOTH paths.
	const chunks = [];
	for await (const chunk of prepared.stream(request)) chunks.push(chunk);
	// The thrown AUTH error is wrapped as a terminal finish:error chunk.
	assert.equal(chunks.at(-1).type, "finish");
	assert.equal(chunks.at(-1).reason.kind, "error");
	assert.equal(chunks.at(-1).reason.failure.code, "AUTH");
	// The failover listener must own recovery: mark sol-disc failed, retry.
	// (payload.provenance mirrors the agent loop: present when the runtime
	// propagates it; the shim falls back to its recorded current route.)
	const action = await ctx.waterfall({}, "agent/request-error", {
		provider: request.provider,
		...prepared.provenance === void 0 ? {} : { provenance: prepared.provenance },
		failure: chunks.at(-1).reason.failure,
		signal
	}, () => Promise.resolve(void 0));
	assert.deepEqual(action, { kind: "retry" }, "403 AUTH on the first candidate must trigger router failover");
	// The retried dispatch lands on the healthy zai candidate and completes.
	const retry = await llm.prepareCall(request, signal);
	if (retry.provenance !== void 0) {
		assert.deepEqual(retry.provenance.resolved, { provider: "zai", model: "zai/glm-5.3" });
	}
	const retryChunks = [];
	for await (const chunk of retry.stream(request)) retryChunks.push(chunk);
	assert.equal(retryChunks.filter((c) => c.type === "text-delta").map((c) => c.text).join(""), "zai/zai/glm-5.3");
	assert.equal(retryChunks.at(-1).reason.kind, "stop");
});


test("duplicate advertised model within one provider is rejected at apply time", () => {
	const ctx = new Context();
	const llm = new LlmRuntime(ctx);
	llm.registerAdapter(["alpha"], new MockAdapter("alpha", "alpha-model"));
	assert.throws(() => apply(ctx, { routes: [
		{ id: "a", provider: "routed", algorithm: "priority", candidates: [{ provider: "alpha", model: "alpha-model" }] },
		{ id: "b", provider: "routed", model: "a", algorithm: "priority", candidates: [{ provider: "alpha", model: "alpha-model" }] }
	] }), /duplicate virtual model/);
});

// --- live settings edits (lib/index.js syncAdapters) ---

/** In-memory SettingsProvider: no file storage, writable in-process. */
class MemSettings extends SettingsProvider {
	constructor(ctx) {
		super(ctx);
		this.docs = {};
	}
	get writable() {
		return true;
	}
	async load() {
		return this.docs;
	}
	async persist(ns, section) {
		this.docs[ns] = section;
	}
}

/** Drain one virtual request to its joined text deltas. */
async function drain(llm, provider, model) {
	const prepared = await llm.prepareCall({ provider, model, messages: [] }, new AbortController().signal);
	const chunks = [];
	for await (const chunk of prepared.stream({ provider, model, messages: [] })) chunks.push(chunk);
	return chunks.filter((c) => c.type === "text-delta").map((c) => c.text).join("");
}

test("settings edit rebinds an edited group to a new shim; an unrelated group keeps shim + round-robin cursor", async () => {
	const ctx = new Context();
	const llm = new LlmRuntime(ctx);
	const settings = new MemSettings(ctx);
	llm.registerAdapter(["alpha"], new MockAdapter("alpha", "alpha-model"));
	llm.registerAdapter(["beta"], new MockAdapter("beta", "beta-model"));
	apply(ctx, { routes: [
		// Group 'routed': edited below (candidate list changes alpha -> beta).
		{ id: "ed", provider: "routed", algorithm: "priority", candidates: [{ provider: "alpha", model: "alpha-model" }] },
		// Group 'solo': untouched; its shim and round-robin cursor must survive.
		{ id: "solo", algorithm: "round-robin", candidates: [
			{ provider: "alpha", model: "alpha-model" },
			{ provider: "beta", model: "beta-model" }
		] }
	] });

	// Establish baseline: 'ed' serves alpha; 'solo' rotates alpha -> beta.
	assert.equal(await drain(llm, "routed", "ed"), "alpha/alpha-model");
	assert.equal(await drain(llm, "solo", "solo"), "alpha/alpha-model");
	assert.equal(await drain(llm, "solo", "solo"), "beta/beta-model");
	const oldEdited = llm.registration("routed").adapter;
	const oldSolo = llm.registration("solo").adapter;

	// Simulate the settings provider: replace the user section with an EDITED
	// candidate list for the existing 'routed' group; 'solo' stays identical.
	await settings.replace("dsh-model-router", { routes: [
		{ id: "ed", provider: "routed", algorithm: "priority", candidates: [{ provider: "beta", model: "beta-model" }] },
		{ id: "solo", algorithm: "round-robin", candidates: [
			{ provider: "alpha", model: "alpha-model" },
			{ provider: "beta", model: "beta-model" }
		] }
	] });
	// The provider's watched onChange runs async on a microtask tail.
	await new Promise((r) => setImmediate(r));

	// Edited group: a NEW shim instance now serves, dispatching to the new candidate.
	assert.notEqual(llm.registration("routed").adapter, oldEdited, "edited group swapped to a fresh shim");
	assert.equal(await drain(llm, "routed", "ed"), "beta/beta-model", "dispatch uses the edited candidate");

	// Unrelated group: SAME shim instance, and the round-robin cursor continues
	// from where it was (alpha -> beta consumed, so the next request wraps to alpha).
	assert.equal(llm.registration("solo").adapter, oldSolo, "untouched group keeps its shim instance");
	assert.equal(await drain(llm, "solo", "solo"), "alpha/alpha-model", "round-robin cursor position survives");
});


test("a schema-valid but plugin-invalid settings edit is rejected at write time; live serving is unchanged", async () => {
	const ctx = new Context();
	const llm = new LlmRuntime(ctx);
	const settings = new MemSettings(ctx);
	llm.registerAdapter(["alpha"], new MockAdapter("alpha", "alpha-model"));
	apply(ctx, { routes: [
		{ id: "a", provider: "routed", algorithm: "priority", candidates: [{ provider: "alpha", model: "alpha-model" }] }
	] });
	assert.equal(await drain(llm, "routed", "a"), "alpha/alpha-model");
	const serving = llm.registration("routed").adapter;

	// Schema-valid (two routes, valid fields) but router-invalid: both routes
	// in one provider group advertise the same virtual model. The provider's
	// validate hook must reject this BEFORE persisting.
	await assert.rejects(
		settings.replace("dsh-model-router", { routes: [
			{ id: "a", provider: "routed", algorithm: "priority", candidates: [{ provider: "alpha", model: "alpha-model" }] },
			{ id: "b", provider: "routed", model: "a", algorithm: "priority", candidates: [{ provider: "alpha", model: "alpha-model" }] }
		] }),
		/duplicate virtual model/,
		"invalid edit must be rejected at write time"
	);
	// Nothing persisted: validate ran before persist, so the raw document
	// (what the provider stores) never saw the invalid section.
	assert.equal(settings.docs["dsh-model-router"], void 0, "rejected edit persists nothing");
	assert.equal(llm.registration("routed").adapter, serving, "live shim unchanged after rejected edit");
	assert.equal(await drain(llm, "routed", "a"), "alpha/alpha-model", "still serves the previous routes");
});
