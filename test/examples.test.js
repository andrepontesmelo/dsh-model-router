/**
 * dsh-model-router — end-to-end proof for the author-facing example
 * algorithm 'least-dispatched' (examples/least-dispatched.js).
 *
 * Wiring mirrors apply() verbatim (lib/index.js:108-113): factory resolved
 * via the EXISTING defaultRegistry, instance attached to its route, shim
 * registered over the raw adapters. Driving the shim directly exercises
 * the same prepareCall / stream / requestFailed path config-driven requests
 * take, without depending on which algorithm names the Config schema
 * currently enumerates.
 *
 * REGISTRY ISOLATION: node --test runs every file in its own process, so
 * registering into defaultRegistry below cannot leak into any other test
 * file. Everywhere outside THIS process the shipped registry stays exactly
 * priority + round-robin.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Context } from "@deepseek-ai/cordis";
import { LlmRuntime, LlmAdapter, LlmError } from "@deepseek-ai/dsh-llm";
import { RouterShim } from "../lib/shim.js";
import { defaultRegistry } from "../lib/routing.js";
import { leastDispatchedFactory } from "../examples/least-dispatched.js";

const NAME = "least-dispatched";

// Register ONCE at load, against the EXISTING registry — the whole point:
// no restructuring anywhere.
const BUILT_INS = [...defaultRegistry.names()];
defaultRegistry.register(NAME, leastDispatchedFactory);

const CANDIDATES = [
	{ provider: "alpha", model: "alpha-model" },
	{ provider: "beta", model: "beta-model" },
	{ provider: "gamma", model: "gamma-model" }
];

/** Healthy mock adapter: streams "<provider>/<model>" then finishes. */
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

/** Mock adapter whose stream always throws SERVER mid-flight. */
function failingStream(provider) {
	return new (class extends LlmAdapter {
		providerInfo(p) {
			return { id: p, name: `${p}-mock` };
		}
		async *stream() {
			throw new LlmError(`${provider} down`, "SERVER");
		}
	})();
}

/**
 * Same wiring as lib/index.js syncAdapters(): factory -> algorithmInstance,
 * RouterShim over the virtual provider, real adapters beneath it.
 */
function setup({ gammaFails = false } = {}) {
	const ctx = new Context();
	const llm = new LlmRuntime(ctx);
	llm.registerAdapter(["alpha"], new MockAdapter("alpha", "alpha-model"));
	llm.registerAdapter(["beta"], new MockAdapter("beta", "beta-model"));
	llm.registerAdapter(["gamma"], gammaFails ? failingStream("gamma") : new MockAdapter("gamma", "gamma-model"));
	const raw = [{ id: "virtual-a", algorithm: NAME, candidates: CANDIDATES }];
	const shim = new RouterShim(llm, [{
		...raw[0],
		advertisedModel: "virtual-a",
		algorithmInstance: defaultRegistry.resolve(NAME)(ctx, raw)
	}]);
	llm.registerAdapter(["virtual-a"], shim);
	return { ctx, llm, shim };
}

async function run(llm, request, signal) {
	const prepared = await llm.prepareCall(request, signal ?? new AbortController().signal);
	const chunks = [];
	for await (const chunk of prepared.stream(request)) chunks.push(chunk);
	return chunks;
}

const textOf = (chunks) =>
	chunks.filter((c) => c.type === "text-delta").map((c) => c.text).join("");

test("registry walkthrough: one register() call adds the example algorithm", () => {
	assert.deepEqual(BUILT_INS.sort(), ["priority", "round-robin"]);
	assert.ok(defaultRegistry.has(NAME));
	assert.equal(typeof defaultRegistry.resolve(NAME), "function");
	// Names are unique: a duplicate register throws instead of shadowing.
	assert.throws(() => defaultRegistry.register(NAME, leastDispatchedFactory), /already registered/);
});

test("composes end to end: sequential requests spread fair-share across candidates", async () => {
	const { llm } = setup();
	const request = { provider: "virtual-a", model: "virtual-a", messages: [] };
	// Counts start equal, so declaration order breaks ties; each dispatch
	// bumps exactly one counter, producing alpha -> beta -> gamma -> alpha.
	const served = [];
	for (let i = 0; i < 4; i++) served.push(textOf(await run(llm, request)));
	assert.deepEqual(served, ["alpha/alpha-model", "beta/beta-model", "gamma/gamma-model", "alpha/alpha-model"]);
});

test("allocation timing: the slot is spent at prepareCall (first dispatch), not on success", async () => {
	const { llm } = setup();
	const request = { provider: "virtual-a", model: "virtual-a", messages: [] };
	// Prepare TWO calls BEFORE consuming either stream. onDispatch has run
	// twice already; finishing neither yet cannot roll anything back.
	const p1 = await llm.prepareCall(request, new AbortController().signal);
	const p2 = await llm.prepareCall(request, new AbortController().signal);
	const drain = async (prepared) => {
		const chunks = [];
		for await (const chunk of prepared.stream(request)) chunks.push(chunk);
		return chunks;
	};
	assert.equal(textOf(await drain(p1)), "alpha/alpha-model");
	assert.equal(textOf(await drain(p2)), "beta/beta-model");
});

test("fails over: mid-stream SERVER error marks the candidate and retries onto the least-dispatched survivor", async () => {
	const { llm, shim } = setup({ gammaFails: true });
	const request = { provider: "virtual-a", model: "virtual-a", messages: [] };
	// ONE signal drives the whole chain: the shim keys per-request state
	// (failed set, current pick) by it, exactly like the runtime does.
	const signal = new AbortController().signal;
	// Requests 1 and 2 spend alpha and beta cleanly; counters are 1/1/0.
	textOf(await run(llm, request));
	textOf(await run(llm, request));
	// Request 3 lands on gamma, whose stream throws mid-flight.
	const failed = await run(llm, request, signal);
	assert.equal(failed.at(-1).reason.kind, "error");
	assert.equal(failed.at(-1).reason.failure.code, "SERVER");
	// The failover seam: onFailure recorded gamma for THIS request; the
	// shim reports that survivors remain (apply()'s listener turns this
	// into `{ kind: \"retry\" }`).
	assert.equal(
		shim.requestFailed(signal, {
			route: { provider: "virtual-a", model: "virtual-a" },
			resolved: { provider: "gamma", model: "gamma-model" }
		}),
		true,
		"a live candidate remains after gamma failed"
	);
	// Retry over the SAME signal re-selects among alpha/beta (count 1/1):
	// declaration order wins.
	assert.equal(textOf(await run(llm, request, signal)), "alpha/alpha-model");
});

test("exhaustion: every candidate failed -> requestFailed reports no retry", async () => {
	const ctx = new Context();
	const llm = new LlmRuntime(ctx);
	for (const c of CANDIDATES) llm.registerAdapter([c.provider], failingStream(c.provider));
	const raw = [{ id: "virtual-a", algorithm: NAME, candidates: CANDIDATES }];
	const shim = new RouterShim(llm, [{
		...raw[0],
		advertisedModel: "virtual-a",
		algorithmInstance: defaultRegistry.resolve(NAME)(ctx, raw)
	}]);
	llm.registerAdapter(["virtual-a"], shim);
	const request = { provider: "virtual-a", model: "virtual-a", messages: [] };
	const signal = new AbortController().signal;
	for (let i = 0; i < CANDIDATES.length; i++) {
		const chunks = await run(llm, request, signal); // each attempt dies mid-stream
		assert.equal(chunks.at(-1).reason.kind, "error");
		assert.equal(
			shim.requestFailed(signal, {
				route: { provider: "virtual-a", model: "virtual-a" },
				resolved: CANDIDATES[i]
			}),
			i < CANDIDATES.length - 1,
			i < CANDIDATES.length - 1 ? "survivors remain" : "exhausted route must decline the retry"
		);
	}
});

test("contract unit checks: select is pure; the per-request marker counts a slot once", () => {
	const fakeCtx = { llm: { listProviders: () => [{ id: "alpha" }, { id: "beta" }] } };
	const inst = leastDispatchedFactory(fakeCtx, []);
	const route = {
		id: "r", algorithm: NAME,
		candidates: [{ provider: "alpha", model: "m1" }, { provider: "beta", model: "m2" }]
	};
	const callCtx = { failed: new Set(), current: null };

	// Pure: repeated selects answer identically — nothing advanced.
	assert.deepEqual(inst.select(route, callCtx), route.candidates[0]);
	assert.deepEqual(inst.select(route, callCtx), route.candidates[0]);

	// One dispatch moves the counter exactly once...
	inst.onDispatch(route, route.candidates[0], callCtx);
	assert.deepEqual(inst.select(route, callCtx), route.candidates[1]);
	// ...and the callCtx marker (extension etiquette: OUR key) blocks the
	// double count on any stray repeat call.
	inst.onDispatch(route, route.candidates[0], callCtx);
	assert.deepEqual(inst.select(route, callCtx), route.candidates[1]);

	// Fresh record (what replace-on-success swaps in) carries none of our
	// keys: onDispatch must still work off a virgin callCtx.
	inst.onDispatch(route, route.candidates[1], { failed: new Set(), current: null });
	assert.deepEqual(
		inst.select(route, { failed: new Set(), current: null }),
		route.candidates[0] // counts now 1/1 -> declaration order
	);

	// onFailure keys the failed candidate so the retry's pure scan skips it.
	callCtx.failed.add("beta\u0000m2");
	assert.deepEqual(inst.select(route, callCtx), route.candidates[0]);
});
