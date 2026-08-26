/**
 * dsh-model-router — global exponential backoff for failing candidates.
 *
 * A real provider+model that fails dispatch is suppressed (globally, across
 * all routes of one plugin instance) for a cooldown starting at 30s and
 * doubling per successive failure, capped at 8h, and fully reset on a
 * SUCCESSFUL DISPATCH OF THAT SAME provider+model (a success on any other
 * candidate does not re-enable a cooled one). Uses the same in-memory Cordis
 * Context + LlmRuntime + mock LlmAdapter harness as test/index.test.js; the
 * clock is driven via `ctx[BACKOFF].setNow(fn)` (and a store-local clock in
 * the pure unit tests).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Context } from "@deepseek-ai/cordis";
import { LlmRuntime, LlmAdapter, LlmError } from "@deepseek-ai/dsh-llm";
import { apply } from "../lib/index.js";
import { defaultRegistry } from "../lib/routing.js";
import {
	BACKOFF, createBackoffStore, DEFAULT_INITIAL_MS, DEFAULT_MAX_MS, formatWindow, noopBackoff
} from "../lib/backoff.js";

/** Minimal in-memory adapter emitting a valid chunk stream, no network. */
class MockAdapter extends LlmAdapter {
	constructor(provider, model, ok = true) {
		super();
		this.provider = provider;
		this.model = model;
		this.ok = ok;
	}
	providerInfo(provider) {
		return { id: provider, name: `${provider}-mock` };
	}
	async *stream() {
		if (!this.ok) throw new LlmError(`${this.provider} down`, "SERVER");
		yield { type: "text-delta", index: 0, text: `${this.provider}/${this.model}` };
		yield { type: "finish", reason: { kind: "stop" } };
	}
}

/**
 * Setup one virtual route through alpha(+beta). Returns helpers mirroring
 * test/index.test.js: the failover listener is driven by
 * `ctx.waterfall({}, "agent/request-error", {...})`.
 */
function setup(routes, { alphaOk = true, betaOk = true } = {}) {
	const ctx = new Context();
	const llm = new LlmRuntime(ctx);
	llm.registerAdapter(["alpha"], new MockAdapter("alpha", "alpha-model", alphaOk));
	if (routes.some((r) => r.candidates.some((c) => c.provider === "beta"))) {
		llm.registerAdapter(["beta"], new MockAdapter("beta", "beta-model", betaOk));
	}
	apply(ctx, { routes });
	const request = { provider: "virtual-a", model: "virtual-a", messages: [] };
	const signal = new AbortController().signal;
	const collect = async (r = request, s = signal) => {
		const prepared = await llm.prepareCall(r, s);
		const chunks = [];
		for await (const chunk of prepared.stream(r)) chunks.push(chunk);
		return chunks;
	};
	const fail = async (chunks, s = signal) => ctx.waterfall({}, "agent/request-error", {
		provider: "virtual-a", failure: chunks.at(-1).reason.failure, signal: s
	}, () => Promise.resolve(void 0));
	return { ctx, llm, collect, fail, signal };
}

// --- lib/backoff.js unit behavior ---

test("backoff: 1st failure cools 30s from the failure, 2nd 60s, 3rd 120s", () => {
	let t = 0;
	const store = createBackoffStore({ now: () => t });
	// 1st failure at t=0 -> usable again exactly at +30s.
	store.recordFailure("a", "m");
	assert.equal(store.isUsable("a", "m"), false, "cooled immediately after failure");
	t = DEFAULT_INITIAL_MS - 1;
	assert.equal(store.isUsable("a", "m"), false, "still cooled 1ms before the window ends");
	t = DEFAULT_INITIAL_MS;
	assert.equal(store.isUsable("a", "m"), true, "usable exactly when the window ends");
	// 2nd failure at t=30s -> window is 60s FROM THAT FAILURE (t=90s).
	store.recordFailure("a", "m");
	assert.equal(store.isUsable("a", "m"), false);
	t = DEFAULT_INITIAL_MS + DEFAULT_INITIAL_MS * 2 - 1; // 89_999
	assert.equal(store.isUsable("a", "m"), false);
	t = DEFAULT_INITIAL_MS + DEFAULT_INITIAL_MS * 2;     // 90_000
	assert.equal(store.isUsable("a", "m"), true);
	// 3rd failure at t=90s -> window is 120s from there (t=210s).
	store.recordFailure("a", "m");
	assert.equal(store.isUsable("a", "m"), false);
	t = DEFAULT_INITIAL_MS + DEFAULT_INITIAL_MS * 2 + DEFAULT_INITIAL_MS * 4 - 1; // 209_999
	assert.equal(store.isUsable("a", "m"), false);
	t = DEFAULT_INITIAL_MS + DEFAULT_INITIAL_MS * 2 + DEFAULT_INITIAL_MS * 4;     // 210_000
	assert.equal(store.isUsable("a", "m"), true);
});

test("backoff: repeated failures cap the window at exactly 8h (never more)", () => {
	let t = 0;
	const store = createBackoffStore({ now: () => t });
	// Enough failures to far exceed twice the cap in arithmetic terms. Each
	// failure lands inside the not-yet-elapsed window and re-escalates from
	// the current time.
	const failures = Math.ceil(Math.log2(DEFAULT_MAX_MS / DEFAULT_INITIAL_MS)) + 5;
	for (let i = 0; i < failures; i++) {
		store.recordFailure("a", "m");
		t += 1; // last failure recorded at t = failures - 1
	}
	// The window is clamped at DEFAULT_MAX_MS: the last failure set
	// untilMs = (failures - 1) + DEFAULT_MAX_MS, so it holds 1ms before.
	t = failures - 1 + DEFAULT_MAX_MS - 1;
	assert.equal(store.isUsable("a", "m"), false, "capped window still holds 1ms before 8h");
	t += 1;
	assert.equal(store.isUsable("a", "m"), true, "capped window ends exactly at 8h");
});

test("backoff: reset-on-success restarts escalation at 30s", () => {
	let t = 0;
	const store = createBackoffStore({ now: () => t });
	store.recordFailure("a", "m");
	store.recordFailure("a", "m"); // escalated to 60s, untilMs = 60_000
	t = DEFAULT_INITIAL_MS * 2;
	assert.equal(store.isUsable("a", "m"), true);
	store.reset("a", "m");          // success reset deletes the entry
	store.recordFailure("a", "m");  // fresh failure at t=60s -> 30s from there
	t = DEFAULT_INITIAL_MS * 2 + DEFAULT_INITIAL_MS - 1; // 89_999
	assert.equal(store.isUsable("a", "m"), false);
	t = DEFAULT_INITIAL_MS * 2 + DEFAULT_INITIAL_MS;     // 90_000
	assert.equal(store.isUsable("a", "m"), true, "escalation restarted at 30s after reset");
});

test("backoff: noop fallback never suppresses and no-ops failure/reset", () => {
	assert.equal(noopBackoff.isUsable("a", "m"), true);
	assert.doesNotThrow(() => noopBackoff.recordFailure("a", "m"));
	assert.doesNotThrow(() => noopBackoff.reset("a", "m"));
});

// --- end-to-end via the plugin ---

test("gate: alpha fails once -> retry lands beta; a FRESH request also skips cooled alpha", async () => {
	const { collect, fail } = setup(
		[{ id: "virtual-a", algorithm: "priority", candidates: [
			{ provider: "alpha", model: "alpha-model" },
			{ provider: "beta", model: "beta-model" }
		] }],
		{ alphaOk: false, betaOk: true }
	);
	// First dispatch hits alpha and fails; failover marks it, beta serves.
	const c1 = await collect();
	assert.equal(c1.at(-1).reason.kind, "error");
	assert.deepEqual(await fail(c1), { kind: "retry" });
	const c2 = await collect();
	assert.equal(c2.filter((c) => c.type === "text-delta").map((c) => c.text).join(""), "beta/beta-model");
	// A FRESH request (new signal) still skips the cooled alpha -> beta serves.
	const s2 = new AbortController().signal;
	const c3 = await collect({ provider: "virtual-a", model: "virtual-a", messages: [] }, s2);
	assert.equal(c3.filter((c) => c.type === "text-delta").map((c) => c.text).join(""), "beta/beta-model");
});

test("reset on success: only the SUCCEEDED candidate's own cooldown clears", async () => {
	const ctx = new Context();
	const llm = new LlmRuntime(ctx);
	// alpha starts failing; flipped healthy mid-test to prove its OWN success
	// (not beta's) is what clears alpha's backoff.
	const alpha = new MockAdapter("alpha", "alpha-model", false);
	llm.registerAdapter(["alpha"], alpha);
	llm.registerAdapter(["beta"], new MockAdapter("beta", "beta-model", true));
	apply(ctx, { routes: [{ id: "virtual-a", algorithm: "priority", candidates: [
		{ provider: "alpha", model: "alpha-model" },
		{ provider: "beta", model: "beta-model" }
	] }] });
	const request = { provider: "virtual-a", model: "virtual-a", messages: [] };
	const signal = new AbortController().signal;
	const collect = async () => {
		const prepared = await llm.prepareCall(request, signal);
		const chunks = [];
		for await (const chunk of prepared.stream(request)) chunks.push(chunk);
		return chunks;
	};
	// alpha fails -> failover marks it (cooldown starts) -> beta serves.
	const c1 = await collect();
	assert.equal(c1.at(-1).reason.kind, "error");
	await ctx.waterfall({}, "agent/request-error", {
		provider: "virtual-a", failure: c1.at(-1).reason.failure, signal
	}, () => Promise.resolve(void 0));
	const c2 = await collect();
	assert.equal(c2.filter((c) => c.type === "text-delta").map((c) => c.text).join(""), "beta/beta-model");
	// Beta's SUCCESS (shim forward() -> onSuccess) resets beta's own backoff
	// only — alpha stays cooled, so the next request serves beta again.
	assert.equal(ctx[BACKOFF].isUsable("beta", "beta-model"), true, "beta's own cooldown cleared by its success");
	const c3 = await collect();
	assert.equal(c3.filter((c) => c.type === "text-delta").map((c) => c.text).join(""), "beta/beta-model", "alpha still suppressed — other candidate's success doesn't clear it");
	// Let alpha's 30s window elapse (injected clock), then alpha serves and
	// ITS OWN success resets its cooldown.
	ctx[BACKOFF].setNow(() => Date.now() + DEFAULT_INITIAL_MS + 1000);
	assert.equal(ctx[BACKOFF].isUsable("alpha", "alpha-model"), true, "alpha usable after its window elapses");
	alpha.ok = true;
	const c4 = await collect();
	assert.equal(c4.filter((c) => c.type === "text-delta").map((c) => c.text).join(""), "alpha/alpha-model");
	// alpha's own success reset it: a fresh failure right after restarts the
	// escalation at 30s, not at an escalated window.
	let clock = Date.now() + DEFAULT_INITIAL_MS + 1000;
	ctx[BACKOFF].setNow(() => clock);
	alpha.ok = false;
	const c5 = await collect();
	assert.equal(c5.at(-1).reason.kind, "error", "alpha fails again");
	await ctx.waterfall({}, "agent/request-error", {
		provider: "virtual-a", failure: c5.at(-1).reason.failure, signal
	}, () => Promise.resolve(void 0));
	clock += DEFAULT_INITIAL_MS - 10; // 10ms before the fresh 30s window
	assert.equal(ctx[BACKOFF].isUsable("alpha", "alpha-model"), false, "fresh failure cools 30s again");
	clock += 10;
	assert.equal(ctx[BACKOFF].isUsable("alpha", "alpha-model"), true, "escalation restarted at 30s after own-success reset");
});

test("global scope: alpha fails in route 1; route 2 (different virtual provider) skips alpha too", async () => {
	const ctx = new Context();
	const llm = new LlmRuntime(ctx);
	llm.registerAdapter(["alpha"], new MockAdapter("alpha", "alpha-model", false));
	llm.registerAdapter(["beta"], new MockAdapter("beta", "beta-model", true));
	// Two routes over different virtual providers sharing candidates alpha+beta.
	apply(ctx, { routes: [
		{ id: "route-a", provider: "vp-a", model: "a", algorithm: "priority", candidates: [
			{ provider: "alpha", model: "alpha-model" },
			{ provider: "beta", model: "beta-model" }
		] },
		{ id: "route-b", provider: "vp-b", model: "b", algorithm: "priority", candidates: [
			{ provider: "alpha", model: "alpha-model" },
			{ provider: "beta", model: "beta-model" }
		] }
	] });
	const drain = async (provider, model, signal) => {
		const prepared = await llm.prepareCall({ provider, model, messages: [] }, signal);
		const chunks = [];
		for await (const chunk of prepared.stream({ provider, model, messages: [] })) chunks.push(chunk);
		return chunks;
	};
	// Route 1: alpha fails -> failover marks it -> beta serves (and the alpha
	// recordFailure lands in the SHARED store).
	const s1 = new AbortController().signal;
	const c1 = await drain("vp-a", "a", s1);
	assert.equal(c1.at(-1).reason.kind, "error");
	await ctx.waterfall({}, "agent/request-error", {
		provider: "vp-a", failure: c1.at(-1).reason.failure, signal: s1
	}, () => Promise.resolve(void 0));
	// Route 2 (fresh request, other virtual provider) skips the same cooled
	// alpha+model key and serves beta directly.
	const s2 = new AbortController().signal;
	const c2 = await drain("vp-b", "b", s2);
	assert.equal(c2.filter((c) => c.type === "text-delta").map((c) => c.text).join(""), "beta/beta-model");
});

test("exhaustion: all candidates cooled => prepareCall rejects with no live candidates", async () => {
	const { ctx, llm, collect, fail, signal } = setup(
		[{ id: "virtual-a", algorithm: "priority", candidates: [
			{ provider: "alpha", model: "alpha-model" },
			{ provider: "beta", model: "beta-model" }
		] }],
		{ alphaOk: false, betaOk: false }
	);
	// alpha fails; failover marks it (cooldown), retries to beta.
	const c1 = await collect();
	assert.deepEqual(await fail(c1), { kind: "retry" });
	// beta also fails; failover marks it too -> both candidates now cooled,
	// no live candidate remains.
	const c2 = await collect();
	assert.equal(c2.at(-1).reason.kind, "error");
	await ctx.waterfall({}, "agent/request-error", {
		provider: "virtual-a", failure: c2.at(-1).reason.failure, signal
	}, () => Promise.resolve(void 0));
	// A fresh dispatch on a NEW signal: the backoff cooldown has nothing to do
	// with per-request failed sets, so it must reject NO_CANDIDATE.
	await assert.rejects(llm.prepareCall({ provider: "virtual-a", model: "virtual-a", messages: [] }, new AbortController().signal), /no live candidates/);
});

test("backward compat: factory instances built with fake ctx (no BACKOFF) keep working", () => {
	const ctx = { llm: { listProviders: () => [{ id: "alpha" }, { id: "beta" }, { id: "gamma" }] } };
	const instance = defaultRegistry.resolve("round-robin")(ctx, []);
	const route = { id: "r", algorithm: "round-robin", candidates: [
		{ provider: "alpha", model: "m" },
		{ provider: "beta", model: "m" },
		{ provider: "gamma", model: "m" }
	] };
	const call = { failed: new Set() };
	// noop fallback: no backoff key on ctx, so selection & onDispatch behave as before.
	assert.equal(instance.select(route, call)?.provider, "alpha"); // pure peek
	instance.onDispatch(route, route.candidates[0], call);         // consumes slot
	assert.equal(instance.select(route, call)?.provider, "beta");  // moved pre-stream
	assert.equal(instance.onSuccess !== void 0, true, "onSuccess added without a store");
	assert.doesNotThrow(() => instance.onSuccess(route, route.candidates[0])); // noop reset
	instance.onDispatch(route, route.candidates[0], call);         // retry within request: guarded
	assert.equal(instance.select(route, call)?.provider, "beta");  // no extra slot consumed
});

test("backoff store is reachable through ctx[BACKOFF] and shared across routes", async () => {
	const ctx = new Context();
	const llm = new LlmRuntime(ctx);
	llm.registerAdapter(["alpha"], new MockAdapter("alpha", "alpha-model", false));
	llm.registerAdapter(["beta"], new MockAdapter("beta", "beta-model", true));
	apply(ctx, { routes: [
		{ id: "a", algorithm: "priority", candidates: [{ provider: "alpha", model: "alpha-model" }, { provider: "beta", model: "beta-model" }] }
	] });
	const store = ctx[BACKOFF];
	assert.ok(store, "apply() installs the backoff store on ctx[BACKOFF]");
	assert.ok(store.isUsable("alpha", "alpha-model"), "no failures yet -> usable");
	// failover through route a records into the shared store.
	const s1 = new AbortController().signal;
	const prepared = await llm.prepareCall({ provider: "a", model: "a", messages: [] }, s1);
	const c1 = [];
	for await (const chunk of prepared.stream({ provider: "a", model: "a", messages: [] })) c1.push(chunk);
	await ctx.waterfall({}, "agent/request-error", {
		provider: "a", failure: c1.at(-1).reason.failure, signal: s1
	}, () => Promise.resolve(void 0));
	assert.equal(store.isUsable("alpha", "alpha-model"), false, "failure recorded into the shared store");
});
// --- provenance annotations: peekWindowMs / remainingMs / formatWindow ---

test("backoff: peekWindowMs reports the window the NEXT failure earns", () => {
	let now = 1000;
	const store = createBackoffStore({ now: () => now });
	assert.equal(store.peekWindowMs("a", "m"), DEFAULT_INITIAL_MS, "fresh candidate -> next failure earns 30s");
	store.recordFailure("a", "m"); // earned 30s; failures = 1
	assert.equal(store.peekWindowMs("a", "m"), DEFAULT_INITIAL_MS * 2, "next failure earns 60s");
	store.recordFailure("a", "m"); // failures = 2
	assert.equal(store.peekWindowMs("a", "m"), DEFAULT_INITIAL_MS * 4, "next failure earns 120s");
	store.reset("a", "m");
	assert.equal(store.peekWindowMs("a", "m"), DEFAULT_INITIAL_MS, "reset restarts the peek ladder");
	// Peek never records: usable state untouched.
	assert.equal(store.isUsable("a", "m"), true);
});

test("backoff: repeated peeks cap at exactly 8h like recordings do", () => {
	let now = 0;
	const store = createBackoffStore({ now: () => now });
	for (let i = 0; i < 12; i++) store.recordFailure("a", "m");
	assert.equal(store.peekWindowMs("a", "m"), DEFAULT_MAX_MS);
	assert.equal(formatWindow(DEFAULT_MAX_MS), "8h0m");
});

test("backoff: remainingMs counts down live, null when absent, 0 once elapsed", () => {
	let now = 1000;
	const store = createBackoffStore({ now: () => now });
	assert.equal(store.remainingMs("a", "m"), null, "never failed -> null (not sleeping)");
	store.recordFailure("a", "m"); // until = 31000
	assert.equal(store.remainingMs("a", "m"), 30000);
	now = 16000;
	assert.equal(store.remainingMs("a", "m"), 15000);
	now = 31000;
	assert.equal(store.remainingMs("a", "m"), 0, "elapsed -> 0, not negative");
	store.reset("a", "m");
	assert.equal(store.remainingMs("a", "m"), null);
});

test("formatWindow renders GUI-style durations with an hours branch", () => {
	assert.equal(formatWindow(45_200), "45.2s");
	assert.equal(formatWindow(30_000), "30s");
	assert.equal(formatWindow(60_000), "1m0s");
	assert.equal(formatWindow(162_000), "2m42s");
	assert.equal(formatWindow(3_600_000), "1h0m");
	assert.equal(formatWindow(3_900_000), "1h5m");
	assert.equal(formatWindow(DEFAULT_MAX_MS), "8h0m");
});

test("noop fallback: peek and remaining report nothing to annotate", () => {
	assert.equal(noopBackoff.peekWindowMs("a", "m"), null);
	assert.equal(noopBackoff.remainingMs("a", "m"), null);
});
