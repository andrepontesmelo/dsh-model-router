// Throwaway prototype: in-memory LLM adapters that emit well-formed chunk
// streams with no network. `alpha` can be told to fail mid-stream so the
// failover path has a real terminal failure to recover from.
import { LlmAdapter, LlmError } from "/home/andre/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js";

export class MockAdapter extends LlmAdapter {
	constructor(provider, model, { failAfterFirstChunk = false } = {}) {
		super();
		this.provider = provider;
		this.model = model;
		this.failAfterFirstChunk = failAfterFirstChunk;
		this.streams = 0;
		this.lastSeenOptions = null;
	}
	providerInfo(provider) {
		return { id: provider, name: `${provider}-mock` };
	}
	listModels(_provider) {
		return Promise.resolve([{ id: this.model, name: this.model }]);
	}
	resolveModel(provider, model, _signal) {
		return Promise.resolve({ provider, id: model, name: model });
	}
	async prepareCall(provider, model, signal) {
		return { model: await this.resolveModel(provider, model, signal), stream: (options) => this.stream(options) };
	}
	async *stream(options) {
		this.streams += 1;
		this.lastSeenOptions = options;
		const text = `${this.provider}/${this.model}`;
		yield { type: "block-start", index: 0, blockType: "text" };
		yield { type: "text-delta", index: 0, text };
		if (this.failAfterFirstChunk) throw new LlmError(`${this.provider} mid-stream failure`, "SERVER");
		yield { type: "block-end", index: 0, block: { type: "text", text } };
		yield { type: "usage", usage: { promptTokens: 1, completionTokens: 1 } };
		yield { type: "finish", reason: { kind: "stop" } };
	}
}
