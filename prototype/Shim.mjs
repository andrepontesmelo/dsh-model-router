// Throwaway prototype: a virtual-provider adapter. It registers under "fake"
// (so `ctx.llm.prepareCall({provider:"fake", ...})` resolves through the real
// LlmRuntime), then delegates `prepareCall`/`stream` to the first live real
// candidate. Failover marks the current candidate failed; the next
// `prepareCall` picks the next one.
import { LlmAdapter, LlmError } from "/home/andre/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js";

const key = (provider, model) => `${provider}\u0000${model}`;

export class RouterShim extends LlmAdapter {
	constructor(llm, candidates) {
		super();
		this.llm = llm;
		this.candidates = candidates; // [["alpha","alpha-model"],["beta","beta-model"]]
		this.failed = new Set();
		this.lastPick = null;
	}
	providerInfo(provider) {
		return { id: provider, name: `${provider}-router` };
	}
	listModels() {
		return Promise.resolve([{ id: "fake-model-routed", name: "fake-model-routed" }]);
	}
	resolveModel(provider, model) {
		return Promise.resolve({ provider, id: model, name: model });
	}
	pick() {
		for (const [provider, model] of this.candidates) if (!this.failed.has(key(provider, model))) return [provider, model];
		return null;
	}
	hasCandidate() {
		return this.pick() !== null;
	}
	markFailed(provider, model) {
		this.failed.add(key(provider, model));
	}
	markCurrentFailed() {
		if (this.lastPick) this.markFailed(...this.lastPick);
	}
	async prepareCall(provider, model, signal) {
		const pick = this.pick();
		if (!pick) throw new LlmError(`routed model "${model}" has no live candidates`, "NO_CANDIDATE");
		this.lastPick = pick;
		const [realProvider, realModel] = pick;
		const realCall = await this.llm.registration(realProvider).adapter.prepareCall(realProvider, realModel, signal);
		return {
			// Virtual identity keeps the runtime's `normalizeModelInfo` and the
			// prepared-call config gate (`callConfigEquals`) happy: the outer
			// request still says "fake"/"fake-model-routed".
			model: { provider, id: model, name: model },
			stream: (options) => realCall.stream({ ...options, provider: realProvider, model: realModel })
		};
	}
}
