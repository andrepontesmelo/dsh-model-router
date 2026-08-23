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
	const chunks = [];
	for await (const chunk of prepared.stream({ provider: "virtual-a", model: "virtual-a", messages: [] })) {
		chunks.push(chunk);
	}
	const text = chunks.filter((c) => c.type === "text-delta").map((c) => c.text).join("");
	assert.equal(text, "alpha/alpha-model");
	assert.equal(chunks.at(-1).reason.kind, "stop");
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
	// Exhaustion: mark beta failed too -> no retry left.
	await ctx.waterfall({}, "agent/request-error", {
		provider: "virtual-a", failure: c1.at(-1).reason.failure, signal
	}, () => Promise.resolve(void 0));
	const exhausted = await ctx.waterfall({}, "agent/request-error", {
		provider: "virtual-a", failure: c1.at(-1).reason.failure, signal
	}, () => Promise.resolve(void 0));
	assert.equal(exhausted, void 0);
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
	const shim = llm.registration(request.provider).adapter;
	assert.equal(shim.failed.size, 0, "failed set cleared by the successful finish");
	const c3 = await llm.prepareCall(request, signal);
	const chunks3 = [];
	for await (const chunk of c3.stream(request)) chunks3.push(chunk);
	assert.equal(chunks3.at(-1).reason.kind, "error"); // alpha picked again (failed set reset)
});

test("config with a delegation cycle is rejected at apply time", async () => {
	const ctx = new Context();
	const llm = new LlmRuntime(ctx);
	llm.registerAdapter(["alpha"], new MockAdapter("alpha", "alpha-model"));
	// Direct self-reference: virtual-p lists itself as a candidate. Without
	// the guard this recurses in RouterShim.prepareCall until RangeError.
	assert.throws(
		() => apply(ctx, { routes: [
			{ id: "virtual-p", algorithm: "priority", candidates: [{ provider: "virtual-p", model: "virtual-p" }, { provider: "alpha", model: "alpha-model" }] }
		] }),
		/cycle/
	);
	// Mutual cycle: a -> b -> a.
	assert.throws(
		() => apply(ctx, { routes: [
			{ id: "virtual-a", algorithm: "round-robin", candidates: [{ provider: "virtual-b", model: "m" }] },
			{ id: "virtual-b", algorithm: "priority", candidates: [{ provider: "virtual-a", model: "m2" }] }
		] }),
		/cycle/
	);
	// Diamond that is NOT a cycle (a -> b|c -> alpha) stays legal AND works
	// end-to-end: dispatch through virtual-a lands on the real adapter.
	apply(ctx, { routes: [
		{ id: "virtual-a", algorithm: "priority", candidates: [
			{ provider: "virtual-b", model: "m" }, { provider: "virtual-c", model: "m" }
		] },
		{ id: "virtual-b", algorithm: "priority", candidates: [{ provider: "alpha", model: "alpha-model" }] },
		{ id: "virtual-c", algorithm: "priority", candidates: [{ provider: "alpha", model: "alpha-model" }] }
	] });
	const prepared = await llm.prepareCall({ provider: "virtual-a", model: "virtual-a" }, new AbortController().signal);
	const chunks = [];
	for await (const chunk of prepared.stream({ provider: "virtual-a", model: "virtual-a", messages: [] })) chunks.push(chunk);
	const text = chunks.filter((c) => c.type === "text-delta").map((c) => c.text).join("");
	assert.equal(text, "alpha/alpha-model");
});