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