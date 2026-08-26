#!/usr/bin/env node
/**
 * dsh-model-router — reusable smoke suite.
 *
 *   npm run smoke                              LOCAL mode (default)
 *   npm run smoke -- deployed <profile>        DEPLOYED mode
 *   npm run smoke -- deployed <profile> --patch ./overlay.yml [...]
 *   npm run smoke -- deployed <profile> --dump-only
 *
 * LOCAL: the failover machinery exercised in-memory — real plugin code
 * (shim, routing algorithms, backoff store) over a bare Cordis Context +
 * LlmRuntime with mock adapters. Zero network, zero API keys — the same
 * guarantee as `npm test`. Runs the drill minimum:
 *   1. priority exhaustion surfaces an error
 *   2. escalating sleep windows annotate failures (30s -> 2x per failure)
 *   3. cooldown resets on own success
 *   4. round-robin alternates dispatches
 *   5. NO_CANDIDATE stops retry cleanly
 *
 * DEPLOYED: against a named dsh profile ($DSH_HOME/profiles/<name>). Parses
 * the composed configuration (`dsh --profile <name> --dump-config`) for the
 * dsh-model-router plugin's configured routes, reports which provider/model
 * the profile's agent-default-model points at, then answers ONE task through
 * the live profile so the routes actually dispatch. Needs network plus
 * whatever credentials the profile's providers require.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const REPO = (p) => join(ROOT, p);
const strip = (s) => s.trim().replace(/^['"]|['"]$/g, "");

// ---------------------------------------------------------------------------
// LOCAL mode
// ---------------------------------------------------------------------------

async function runLocal() {
	const [{ Context }, { LlmRuntime, LlmAdapter, LlmError }] = await Promise.all([
		import("@deepseek-ai/cordis"),
		import("@deepseek-ai/dsh-llm")
	]);
	const { apply } = await import(REPO("lib/index.js"));
	const { RouterShim } = await import(REPO("lib/shim.js"));
	const { BACKOFF, createBackoffStore, DEFAULT_INITIAL_MS, formatWindow } = await import(REPO("lib/backoff.js"));
	const { defaultRegistry } = await import(REPO("lib/routing.js"));

	/** Loop-free mock adapter; fails its first `failTimes` dispatches. */
	class MockAdapter extends LlmAdapter {
		constructor(provider, model, { failTimes = 0 } = {}) {
			super();
			this.provider = provider;
			this.model = model;
			this.failTimes = failTimes;
			this.dispatches = 0;
		}
		providerInfo(p) {
			return { id: p, name: `${p}-mock` };
		}
		async *stream() {
			this.dispatches++;
			if (this.dispatches <= this.failTimes) throw new LlmError(`${this.provider} down`, "SERVER");
			yield { type: "text-delta", index: 0, text: `${this.provider}/${this.model}` };
			yield { type: "finish", reason: { kind: "stop" } };
		}
	}

	function setupRuntime(ctx, adapters, routes) {
		const llm = new LlmRuntime(ctx);
		for (const [providers, adapter] of Object.entries(adapters)) llm.registerAdapter([providers], adapter);
		apply(ctx, { routes });
		return llm;
	}

	async function drive(llm, vProvider, vModel, signal) {
		const req = { provider: vProvider, model: vModel, messages: [] };
		// Adapter-level prepareCall (same idiom as test/index.test.js's
		// picker tests): exposes the shim's provenance, which the runtime's
		// own prepareCall wrapper drops.
		const adapter = llm.registration?.(vProvider)?.adapter;
		const prepared = adapter ? await adapter.prepareCall(vProvider, vModel, signal) : await llm.prepareCall(req, signal);
		const chunks = [];
		try {
			for await (const chunk of prepared.stream(req)) chunks.push(chunk);
		} catch (error) {
			// The shim rethrows thrown adapter errors as LlmError carrying the
			// sleep suffix; production consumers see both surfaces equally.
			// Normalize to the finish-chunk shape every drill asserts on.
			if (error instanceof Error && error.name !== "AbortError") {
				chunks.push({ type: "finish", reason: { kind: "error", failure: { code: error.code ?? "ERROR", message: error.message } } });
			} else {
				throw error;
			}
		}
		return { chunks, provenance: prepared.provenance };
	}

	const isRetry = (action) => Boolean(action && action.kind === "retry");
	const lastFailure = (chunks) => chunks.at(-1).reason.failure;

	// apply() always installs its own Date.now-backed store; drills that must
	// own the clock build the shim manually with an injected store (same
	// idiom as test/index.test.js).
	function manualShim(llm, ctx, rawRoutes, store) {
		ctx[BACKOFF] = store;
		return new RouterShim(
			llm,
			rawRoutes.map((raw) => ({ ...raw, advertisedModel: raw.id, algorithmInstance: defaultRegistry.resolve(raw.algorithm)(ctx, raw) })),
			store
		);
	}

	/** Fire `requestFailed` on the shim exactly as the waterfall listener would. */
	function reportFailure(shim, routeId, prov) {
		shim.requestFailed(new AbortController().signal, {
			route: { provider: routeId, model: routeId },
			resolved: prov.resolved
		});
	}

	const drills = [
		{
			name: "priority exhaustion surfaces error",
			run: async () => {
				const ctx = new Context();
				const llm = setupRuntime(ctx, {}, [
					{ id: "virtual-a", algorithm: "priority", candidates: [
						{ provider: "alpha", model: "alpha-model" },
						{ provider: "beta", model: "beta-model" }
					] }
				]);
				llm.registerAdapter(["alpha"], new MockAdapter("alpha", "alpha-model", { failTimes: 99 }));
				llm.registerAdapter(["beta"], new MockAdapter("beta", "beta-model", { failTimes: 99 }));
				const signal = new AbortController().signal;
				let outcome = await drive(llm, "virtual-a", "virtual-a", signal);
				assert.equal(outcome.chunks.at(-1).reason.kind, "error");
				assert.equal(lastFailure(outcome.chunks).code, "SERVER");
				let action = await ctx.waterfall({}, "agent/request-error",
					{ provider: "virtual-a", failure: lastFailure(outcome.chunks), provenance: outcome.provenance, signal },
					() => Promise.resolve(void 0));
				assert.ok(isRetry(action), `retry while beta is live (got ${JSON.stringify(action)})`);
				outcome = await drive(llm, "virtual-a", "virtual-a", signal); // lands on beta
				assert.match(lastFailure(outcome.chunks).message, /^beta down/, "second attempt reached beta");
				action = await ctx.waterfall({}, "agent/request-error",
					{ provider: "virtual-a", failure: lastFailure(outcome.chunks), provenance: outcome.provenance, signal },
					() => Promise.resolve(void 0));
				assert.ok(!isRetry(action), `listener stops after exhaustion (got ${JSON.stringify(action)})`);
				await assert.rejects(
					drive(llm, "virtual-a", "virtual-a", new AbortController().signal),
					(error) => error.code === "NO_CANDIDATE"
				);
				return "exhausted chain declines retry; fresh dispatch throws NO_CANDIDATE";
			}
		},
		{
			name: "escalating sleep windows annotate failures",
			run: async () => {
				const ctx = new Context();
				const llm = new LlmRuntime(ctx);
				llm.registerAdapter(["alpha"], new MockAdapter("alpha", "alpha-model", { failTimes: 99 }));
				let now = 0;
				const store = createBackoffStore({ now: () => now });
				const raw = [{ id: "virtual-a", algorithm: "priority", candidates: [{ provider: "alpha", model: "alpha-model" }] }];
				const shim = manualShim(llm, ctx, raw, store);
				llm.registerAdapter(["virtual-a"], shim);
				const failureMessage = async () => {
					const outcome = await drive(llm, "virtual-a", "virtual-a", new AbortController().signal);
					assert.equal(outcome.chunks.at(-1).reason.kind, "error");
					reportFailure(shim, "virtual-a", outcome.provenance);
					return outcome.chunks.at(-1).reason.failure.message;
				};
				assert.equal(await failureMessage(), `alpha down (sleep ${formatWindow(DEFAULT_INITIAL_MS)})`, "first failure earns the initial window");
				now += DEFAULT_INITIAL_MS + 1_000;
				assert.equal(await failureMessage(), "alpha down (sleep 1m0s)", "second consecutive failure earns the doubled window");
				now += 60_000 + 1_000;
				assert.equal(await failureMessage(), "alpha down (sleep 2m0s)", "third consecutive failure doubles again");
				return "windows escalate 30s -> 1m0s -> 2m0s via stream annotations";
			}
		},
		{
			name: "cooldown resets on own success",
			run: async () => {
				const ctx = new Context();
				const llm = new LlmRuntime(ctx);
				llm.registerAdapter(["alpha"], new MockAdapter("alpha", "alpha-model", { failTimes: 1 }));
				let now = 0;
				const store = createBackoffStore({ now: () => now });
				const raw = [{ id: "virtual-a", algorithm: "priority", candidates: [{ provider: "alpha", model: "alpha-model" }] }];
				const shim = manualShim(llm, ctx, raw, store);
				llm.registerAdapter(["virtual-a"], shim);
				const signal = new AbortController().signal;
				const failed = await drive(llm, "virtual-a", "virtual-a", signal);
				assert.equal(failed.chunks.at(-1).reason.kind, "error");
				reportFailure(shim, "virtual-a", failed.provenance);
				assert.ok(store.remainingMs("alpha", "alpha-model") > 0, "candidate cooling after failure");
				now += DEFAULT_INITIAL_MS + 1_000;
				const served = await drive(llm, "virtual-a", "virtual-a", new AbortController().signal);
				assert.equal(served.provenance.resolved.provider, "alpha", "served again once its own window elapsed");
				assert.equal(store.remainingMs("alpha", "alpha-model"), null, "own success cleared the record immediately");
				// Adapter's single failure is spent; next request succeeds (covered
				// above) and a THIRD dispatch would re-fail with the initial window
				// — verified by the window assertions in the escalation drill; here
				// we prove selection came back to alpha via provenance alone.
				assert.equal(served.chunks.at(-1).reason.kind, "stop");
				return "record cleared on terminal success; window restarts from the initial step";
			}
		},
		{
			name: "round-robin alternates dispatches",
			run: async () => {
				const ctx = new Context();
				const adapters = {
					alpha: new MockAdapter("alpha", "alpha-model"),
					beta: new MockAdapter("beta", "beta-model")
				};
				const llm = setupRuntime(ctx, adapters, [
					{ id: "pool", algorithm: "round-robin", candidates: [
						{ provider: "alpha", model: "alpha-model" },
						{ provider: "beta", model: "beta-model" }
					] }
				]);
				const served = [];
				for (let i = 0; i < 4; i++) {
					const { chunks, provenance } = await drive(llm, "pool", "pool", new AbortController().signal);
					const text = chunks.filter((c) => c.type === "text-delta").map((c) => c.text).join("");
					assert.equal(text, `${provenance.resolved.provider}/${provenance.resolved.model}`);
					served.push(provenance.resolved.provider);
				}
				assert.deepEqual(served, ["alpha", "beta", "alpha", "beta"], `alternating picks, got ${served.join(",")}`);
				return "four sequential requests rotated alpha,beta,alpha,beta";
			}
		},
		{
			name: "NO_CANDIDATE stops retry cleanly",
			run: async () => {
				const ctx = new Context();
				const alpha = new MockAdapter("alpha", "alpha-model", { failTimes: 99 });
				const llm = setupRuntime(ctx, { alpha }, [
					{ id: "solo", algorithm: "round-robin", candidates: [{ provider: "alpha", model: "alpha-model" }] }
				]);
				const signal = new AbortController().signal;
				const before = alpha.dispatches;
				const outcome = await drive(llm, "solo", "solo", signal);
				assert.equal(outcome.chunks.at(-1).reason.kind, "error");
				assert.match(lastFailure(outcome.chunks).message, /\(sleep 30s\)/, "failure annotated with earned window");
				const action = await ctx.waterfall({}, "agent/request-error",
					{ provider: "solo", failure: lastFailure(outcome.chunks), provenance: outcome.provenance, signal },
					() => Promise.resolve(void 0));
				assert.ok(!isRetry(action), `listener declines retry when nothing is live (got ${JSON.stringify(action)})`);
				assert.equal(alpha.dispatches, before + 1, "exactly one backend dispatch — no spinning");
				await assert.rejects(
					drive(llm, "solo", "solo", new AbortController().signal),
					(error) => {
						assert.equal(error.code, "NO_CANDIDATE");
						assert.match(error.message, /no live candidates/);
						assert.match(error.message, /sleeping: alpha\/alpha-model \d/);
						return true;
					}
				);
				await assert.rejects(
					drive(llm, "solo", "nope", new AbortController().signal),
					(error) => error.code === "NO_CANDIDATE"
				);
				return "one failed dispatch, listener declines, exhaustion lists sleepers";
			}
		}
	];

	console.log("dsh-model-router smoke — LOCAL mode (in-memory runtime, zero network, zero API keys)\n");
	let failures = 0;
	for (const drill of drills) {
		try {
			console.log(`PASS  ${drill.name}\n      ${await drill.run()}`);
		} catch (error) {
			failures++;
			console.log(`FAIL  ${drill.name}\n      ${error?.message ?? error}`);
			if (process.env.SMOKE_VERBOSE && error?.stack) console.log(error.stack);
		}
	}
	console.log(`\nsmoke(local): ${drills.length - failures}/${drills.length} drills passed`);
	if (failures > 0) {
		console.log("re-run failing drills verbosely with SMOKE_VERBOSE=1 npm run smoke");
		process.exitCode = 1;
	}
}

// ---------------------------------------------------------------------------
// DEPLOYED mode
// ---------------------------------------------------------------------------

/**
 * Minimal indentation-aware scan of `--dump-config` output (plain YAML that
 * may contain !!js expressions — parsed structurally here, never evaluated).
 * Collects:
 *   - the dsh-model-router entry's configured routes;
 *   - the agent-default-model pair, to say where one task will be served.
 */
export function summarizeComposition(dumpText) {
	const summary = { routerFound: false, routes: [], defaultModel: null };
	let entryName = null;
	let inRouterConfig = false;
	let inDefaultModelConfig = false;
	let currentRoute = null;
	let lastCandidateKey = null;
	for (const line of dumpText.split("\n")) {
		if (/^- /.test(line)) {
			entryName = null;
			inRouterConfig = false;
			inDefaultModelConfig = false;
			currentRoute = null;
		}
		if (/^- id: /.test(line)) continue; // entryName comes from the name: line
		const nameMatch = line.match(/^\s+name: (.+)$/);
		if (nameMatch) {
			entryName = strip(nameMatch[1]);
			// Entries reference plugins by bare or scoped (@scope/base) name.
			const scoped = (base) => entryName === base || entryName.endsWith(`/${base}`);
			inRouterConfig = scoped("dsh-model-router");
			inDefaultModelConfig = scoped("dsh-agent-default-model");
			continue;
		}
		const defaultProvider = line.match(/^\s{4}provider: (.+)$/);
		const defaultModel = line.match(/^\s{4}model: (.+)$/);
		if (!inRouterConfig) {
			if (inDefaultModelConfig && defaultProvider) summary.defaultModel = { provider: strip(defaultProvider[1]), model: null };
			else if (inDefaultModelConfig && defaultModel && summary.defaultModel) summary.defaultModel.model = strip(defaultModel[1]);
			continue;
		}
		const routeStart = line.match(/^\s+- id: (.+)$/);
		const algo = line.match(/^\s+algorithm: (.+)$/);
		const candProvider = line.match(/^\s+- provider: (.+)$/);
		const candModel = line.match(/^\s+model: (.+)$/);
		if (routeStart) {
			currentRoute = { id: strip(routeStart[1]), algorithm: null, candidates: [] };
			summary.routes.push(currentRoute);
			lastCandidateKey = null;
		} else if (algo && currentRoute) currentRoute.algorithm = strip(algo[1]);
		else if (candProvider && currentRoute) {
			currentRoute.candidates.push({ provider: strip(candProvider[1]), model: null });
			lastCandidateKey = currentRoute.candidates.at(-1);
		} else if (candModel && currentRoute && lastCandidateKey) lastCandidateKey.model = strip(candModel[1]);
	}
	summary.routerFound = summary.routes.length > 0 || /name: ['"]?dsh-model-router/.test(dumpText);
	return summary;
}

/** Run the dsh launcher, capturing stdio. Inherits the caller's environment. */
function runDsh(args, timeoutMs) {
	const res = spawnSync(process.env.DSH_BIN || "dsh", args, {
		env: process.env,
		cwd: ROOT,
		encoding: "utf8",
		timeout: timeoutMs
	});
	return {
		status: res.status,
		stdout: res.stdout ?? "",
		stderr: res.stderr ?? "",
		timedOut: res.error?.code === "ETIMEDOUT"
	};
}

function runDeployed(argv) {
	const extraArgs = [];
	const positional = [];
	let dumpOnly = false;
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--dump-only") dumpOnly = true;
		else if (argv[i] === "--patch") extraArgs.push(argv[i], argv[++i] ?? "");
		else positional.push(argv[i]);
	}
	const profile = positional[0];
	const task = positional.slice(1).join(" ") || "Reply with exactly: SMOKE OK";
	const timeoutS = Number(process.env.SMOKE_TIMEOUT_S ?? 180);

	const fail = (why) => {
		console.error(`smoke(deployed): FAIL — ${why}`);
		process.exitCode = 1;
	};

	if (!profile) return fail("DEPLOYED mode needs a profile name: npm run smoke -- deployed <profile>");
	const home = process.env.DSH_HOME || join(homedir(), ".dsh");
	const profileDir = join(home, "profiles", profile);
	if (!existsSync(join(profileDir, "package.json"))) {
		return fail(`profile "${profile}" not found under ${join(home, "profiles")} (set DSH_HOME if your harness home differs)`);
	}

	console.log(`dsh-model-router smoke — DEPLOYED mode against profile "${profile}" (${profileDir})`);

	const dump = runDsh(["--profile", profile, ...extraArgs, "--dump-config"], 60_000);
	if (dump.status !== 0) return fail(`dsh --dump-config exited ${dump.status}\n${dump.stderr.trim().split("\n").at(-1) ?? ""}`);
	const composition = summarizeComposition(dump.stdout);
	console.log("\nconfigured routes:");
	if (composition.routes.length === 0) {
		console.log(composition.routerFound
			? "  (dsh-model-router present but exposes no parseable routes)"
			: "  (none)");
		return fail(`profile "${profile}" does not compose dsh-model-router; add it (cordis.patch.yml insert or 'dsh plugin') so there are routes to exercise`);
	}
	for (const r of composition.routes) {
		console.log(`  - ${r.id}  algorithm=${r.algorithm ?? "?"}  candidates=${r.candidates.map((c) => `${c.provider}/${c.model ?? "?"}`).join(", ")}`);
	}
	const dm = composition.defaultModel;
	console.log(`agent-default-model: ${dm?.provider ?? "?"}/${dm?.model ?? "?"}${dm && composition.routes.some((r) => dm.provider === r.id) ? "" : "\n  note: default model does not target a virtual route; the one-shot below serves directly unless you pass e.g. --patch <overlay.yml> pointing agent-default-model at a routed provider"}`);

	if (dumpOnly) {
		console.log("\nsmoke(deployed): PASS (--dump-only; skipped live dispatch)");
		return;
	}

	console.log(`\ndispatching one task (timeout ${timeoutS}s): "${task}"`);
	const started = Date.now();
	const boot = runDsh(["--profile", profile, ...extraArgs, task], timeoutS * 1000);
	const elapsed = ((Date.now() - started) / 1000).toFixed(1);
	if (boot.timedOut) return fail(`timed out after ${timeoutS}s`);
	if (boot.status !== 0) return fail(`one-shot exited ${boot.status} after ${elapsed}s\n${(boot.stderr.trim().split("\n").slice(-8).join("\n")) || "(no stderr)"}`);
	const answer = boot.stdout.trim();
	if (!answer) return fail("one-shot exited 0 but printed nothing");
	console.log(answer.split("\n").slice(0, 6).map((l) => `  | ${l}`).join("\n"));
	console.log(`\nsmoke(deployed): PASS — answered via profile "${profile}" in ${elapsed}s`);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const HELP = `usage:
  npm run smoke                       # LOCAL: in-memory drills, no network/keys
  npm run smoke -- deployed <profile> # DEPLOYED: named dsh profile
                                      #   [--patch <file> ...]  overlay layers for dsh
                                      #   [--dump-only]         report composition, skip dispatch
env:
  DSH_HOME     harness home (default ~/.dsh)
  DSH_BIN      dsh executable (default "dsh" on PATH)
  SMOKE_TIMEOUT_S  deployed one-shot timeout (default 180)
  SMOKE_VERBOSE=1  print stack traces for local drill failures`;

const [, , mode = "local", ...rest] = process.argv;
if (mode === "-h" || mode === "--help" || mode === "help") {
	console.log(HELP);
} else if (mode === "local") {
	await runLocal();
} else if (mode === "deployed") {
	runDeployed(rest);
} else {
	console.error(`unknown mode "${mode}"\n${HELP}`);
	process.exitCode = 1;
}
