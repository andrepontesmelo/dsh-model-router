// Throwaway prototype proof: runs three tests, prints PASS/FAIL per test,
// exits non-zero on any failure. Run:  node prototype/Delegation-proof.mjs
import { Context } from "/home/andre/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/cordis/lib/index.js";
import { LlmRuntime, createUserMessage, markAgentLoopRequest, deepFreeze, isAgentLoopRequest } from "/home/andre/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js";
import { SessionStore, canonicalHeader, foldRequestHeader } from "/home/andre/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js";
import { MockAdapter } from "./Mock-adapters.mjs";
import { RouterShim } from "./Shim.mjs";

const VIRTUAL = { provider: "fake", model: "fake-model-routed" };

function setup({ alphaFail = false, betaFail = false } = {}) {
	const ctx = new Context();
	const llm = new LlmRuntime(ctx);
	const sessions = new SessionStore(ctx);
	const alpha = new MockAdapter("alpha", "alpha-model", { failAfterFirstChunk: alphaFail });
	const beta = new MockAdapter("beta", "beta-model", { failAfterFirstChunk: betaFail });
	llm.registerAdapter(["alpha"], alpha);
	llm.registerAdapter(["beta"], beta);
	const shim = new RouterShim(llm, [["alpha", "alpha-model"], ["beta", "beta-model"]]);
	llm.registerAdapter(["fake"], shim);
	return { ctx, llm, sessions, alpha, beta, shim };
}

// Faithful inline copy of dsh-agent-loop's request-reconstruction invariant
// (dsh-agent-loop/lib/invariant.js), so the proof verifies a shim-delegated
// request would survive the real loop's validation.
function installInvariant(ctx) {
	ctx.on("llm/stream", (options, next) => {
		if (!isAgentLoopRequest(options)) return next();
		if (!Object.isFrozen(options)) throw new Error("loop request must be frozen");
		if (options.sessionId === void 0) throw new Error("loop request must carry a session id");
		const session = ctx.get("sessions").get(options.sessionId);
		if (!session) throw new Error(`loop request must carry a live session id, got "${String(options.sessionId)}"`);
		if (!Object.isFrozen(options.messages)) throw new Error("loop request must carry a frozen messages array");
		if (!session.events.some((e) => e.type === "step/start")) throw new Error("no step/start in session log");
		const header = foldRequestHeader(session.events);
		if (header === void 0) throw new Error("no request/header event in session log");
		if (JSON.stringify(options.messages) !== JSON.stringify(session.deriveMessages())) throw new Error("messages diverge from durable derivation");
		if (!(options.model === header.config.model && options.system === header.system && options.temperature === header.config.temperature && options.maxTokens === header.config.maxTokens && JSON.stringify(options.stop) === JSON.stringify(header.config.stop) && JSON.stringify(options.tools ?? []) === JSON.stringify(header.tools ?? []))) throw new Error("request diverges from folded request header");
		return next();
	}, { global: true, prepend: true });
}

function makeRequest(sessions, sessionId) {
	const session = sessions.create(sessionId);
	session.append("step/start", { turn: 0, step: 0 });
	const um = createUserMessage({ content: [{ type: "text", text: "hi" }], source: { kind: "user" } });
	session.append("user/message", um, { surfaceOp: "append" });
	session.append("request/header", { header: canonicalHeader({ config: VIRTUAL }), reason: "initial" });
	return { session, request: markAgentLoopRequest(deepFreeze({ ...VIRTUAL, messages: [um], sessionId: session.id, signal: new AbortController().signal })) };
}

async function collect(stream) {
	const out = [];
	for await (const chunk of stream) out.push(chunk);
	return out;
}

function assert(cond, msg) {
	if (!cond) throw new Error(msg);
}

const tests = [];
function test(name, fn) { tests.push([name, fn]); }

test("delegation: fake -> alpha, request stays virtual, loop invariant passes", async () => {
	const { ctx, llm, sessions, alpha } = setup();
	installInvariant(ctx);
	const { request } = makeRequest(sessions, "s1");
	const prepared = await llm.prepareCall(VIRTUAL, request.signal);
	assert(prepared.config.provider === "fake" && prepared.config.model === "fake-model-routed", "prepared config stays virtual");
	const chunks = await collect(prepared.stream(request));
	const text = chunks.filter((c) => c.type === "text-delta").map((c) => c.text).join("");
	assert(text === "alpha/alpha-model", `delegated to alpha, got "${text}"`);
	assert(chunks.at(-1)?.reason?.kind === "stop", "terminal stop chunk");
	assert(request.provider === "fake" && request.model === "fake-model-routed", "original request object untouched");
	assert(alpha.streams === 1, "alpha streamed exactly once");
});

test("failover: alpha mid-stream failure -> retry -> beta serves", async () => {
	const { ctx, llm, sessions, shim, beta } = setup({ alphaFail: true });
	const { request } = makeRequest(sessions, "s2");
	ctx.on("agent/request-error", (payload, next) => {
		shim.markCurrentFailed();
		return shim.hasCandidate() ? Promise.resolve({ kind: "retry" }) : next();
	});
	const c1 = await collect((await llm.prepareCall(VIRTUAL, request.signal)).stream(request));
	assert(c1.at(-1)?.reason?.kind === "error", "alpha terminates with error finish");
	assert(c1.at(-1)?.reason?.failure?.code === "SERVER", "failure code is SERVER");
	const action = await ctx.waterfall({}, "agent/request-error", { provider: VIRTUAL.provider, model: VIRTUAL.model, failure: c1.at(-1).reason.failure, signal: request.signal }, () => Promise.resolve(void 0));
	assert(action?.kind === "retry", "recovery listener returns retry");
	const c2 = await collect((await llm.prepareCall(VIRTUAL, request.signal)).stream(request));
	const text2 = c2.filter((c) => c.type === "text-delta").map((c) => c.text).join("");
	assert(text2 === "beta/beta-model", `failover served beta, got "${text2}"`);
	assert(beta.streams === 1, "beta streamed exactly once");
});

test("failover exhaustion: no candidates left -> no retry", async () => {
	const { ctx, llm, sessions, shim } = setup({ alphaFail: true, betaFail: true });
	const { request } = makeRequest(sessions, "s3");
	ctx.on("agent/request-error", (payload, next) => {
		shim.markCurrentFailed();
		return shim.hasCandidate() ? Promise.resolve({ kind: "retry" }) : next();
	});
	const c1 = await collect((await llm.prepareCall(VIRTUAL, request.signal)).stream(request));
	const a1 = await ctx.waterfall({}, "agent/request-error", { provider: VIRTUAL.provider, model: VIRTUAL.model, failure: c1.at(-1).reason.failure, signal: request.signal }, () => Promise.resolve(void 0));
	assert(a1?.kind === "retry", "first retry (beta still live)");
	const c2 = await collect((await llm.prepareCall(VIRTUAL, request.signal)).stream(request));
	const a2 = await ctx.waterfall({}, "agent/request-error", { provider: VIRTUAL.provider, model: VIRTUAL.model, failure: c2.at(-1).reason.failure, signal: request.signal }, () => Promise.resolve(void 0));
	assert(a2 === void 0, "no retry once candidates exhausted");
});

test("single dispatch: one llm/stream per shim request and per direct request", async () => {
	const { ctx, llm, sessions } = setup();
	let count = 0;
	ctx.on("llm/stream", (options, next) => { count += 1; return next(); });
	const { request } = makeRequest(sessions, "s4");
	await collect((await llm.prepareCall(VIRTUAL, request.signal)).stream(request));
	assert(count === 1, `shim request fired llm/stream ${count} times (expected 1)`);
	await collect(ctx.get("llm").stream({ provider: "alpha", model: "alpha-model", messages: [], signal: new AbortController().signal }));
	assert(count === 2, `+ direct alpha request => ${count} total (expected 2)`);
});

let pass = 0;
let fail = 0;
for (const [name, fn] of tests) {
	try {
		await fn();
		console.log(`PASS: ${name}`);
		pass += 1;
	} catch (error) {
		console.log(`FAIL: ${name}`);
		console.log(`      ${error?.stack ?? error}`);
		fail += 1;
	}
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
