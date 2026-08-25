/**
 * dsh-model-router — lib/routes.js unit tests: Virtual-route identity.
 *
 * normalizeRoute applies the `provider|id` and `model|id` defaults exactly
 * once; groupRoutes keeps insertion order; validateRoutes throws the exact
 * messages the plugin has always thrown (from RAW config); groupSignature
 * fingerprints a group's shape for live-edit change detection.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeRoute, groupRoutes, validateRoutes, groupSignature } from "../lib/routes.js";

test("normalizeRoute defaults provider and model to the route id", () => {
	const raw = { id: "pool", algorithm: "priority", candidates: [{ provider: "alpha", model: "m" }] };
	assert.deepEqual(normalizeRoute(raw), {
		id: "pool",
		provider: "pool",
		advertisedModel: "pool",
		algorithm: "priority",
		candidates: [{ provider: "alpha", model: "m" }]
	});
});

test("normalizeRoute keeps explicit provider and model", () => {
	const raw = { id: "strong", provider: "routed", model: "chat", algorithm: "round-robin", candidates: [{ provider: "beta", model: "m" }] };
	assert.deepEqual(normalizeRoute(raw), {
		id: "strong",
		provider: "routed",
		advertisedModel: "chat",
		algorithm: "round-robin",
		candidates: [{ provider: "beta", model: "m" }]
	});
});

test("groupRoutes preserves insertion order (providers and within-group)", () => {
	const a = normalizeRoute({ id: "a", provider: "routed", algorithm: "priority", candidates: [{ provider: "alpha", model: "m" }] });
	const b = normalizeRoute({ id: "b", provider: "routed", algorithm: "priority", candidates: [{ provider: "alpha", model: "m" }] });
	const c = normalizeRoute({ id: "c", algorithm: "priority", candidates: [{ provider: "alpha", model: "m" }] });
	const groups = groupRoutes([a, c, b]);
	assert.deepEqual([...groups.keys()], ["routed", "c"]);
	assert.deepEqual(groups.get("routed").map((r) => r.id), ["a", "b"]);
	assert.deepEqual(groups.get("c").map((r) => r.id), ["c"]);
});

test("validateRoutes rejects duplicate route ids with the exact message", () => {
	assert.throws(
		() => validateRoutes([
			{ id: "a", algorithm: "priority", candidates: [{ provider: "alpha", model: "m" }] },
			{ id: "a", algorithm: "priority", candidates: [{ provider: "alpha", model: "m" }] }
		]),
		{ message: 'dsh-model-router: duplicate route id "a"' }
	);
});

test("validateRoutes rejects a direct delegation cycle with the exact message", () => {
	assert.throws(
		() => validateRoutes([
			{ id: "virtual-p", algorithm: "priority", candidates: [{ provider: "virtual-p", model: "virtual-p" }, { provider: "alpha", model: "m" }] }
		]),
		{ message: "dsh-model-router: route \"virtual-p\" has a delegation cycle (virtual-p -> virtual-p); virtual ids must not appear as their own (or each other's) candidates" }
	);
});

test("validateRoutes rejects a mutual delegation cycle", () => {
	assert.throws(
		() => validateRoutes([
			{ id: "virtual-a", algorithm: "priority", candidates: [{ provider: "virtual-b", model: "m" }] },
			{ id: "virtual-b", algorithm: "priority", candidates: [{ provider: "virtual-a", model: "m2" }] }
		]),
		{ message: "dsh-model-router: route \"virtual-a\" has a delegation cycle (virtual-a -> virtual-b -> virtual-a); virtual ids must not appear as their own (or each other's) candidates" }
	);
});

test("validateRoutes rejects a transitive delegation cycle", () => {
	assert.throws(
		() => validateRoutes([
			{ id: "virtual-a", algorithm: "priority", candidates: [{ provider: "virtual-b", model: "m" }] },
			{ id: "virtual-b", algorithm: "priority", candidates: [{ provider: "virtual-c", model: "m2" }] },
			{ id: "virtual-c", algorithm: "priority", candidates: [{ provider: "virtual-a", model: "m3" }] }
		]),
		{ message: "dsh-model-router: route \"virtual-a\" has a delegation cycle (virtual-a -> virtual-b -> virtual-c -> virtual-a); virtual ids must not appear as their own (or each other's) candidates" }
	);
});

test("validateRoutes ACCEPTS acyclic virtual nesting", () => {
	// An outer virtual provider delegating to an inner one is legal — no cycle.
	assert.doesNotThrow(() => validateRoutes([
		{ id: "virtual-a", algorithm: "priority", candidates: [{ provider: "virtual-b", model: "m" }] },
		{ id: "virtual-b", algorithm: "priority", candidates: [{ provider: "alpha", model: "m" }] }
	]));
	// Diamond: outer -> { inner, alpha }; inner -> beta.
	assert.doesNotThrow(() => validateRoutes([
		{ id: "outer", algorithm: "priority", candidates: [{ provider: "inner", model: "inner" }, { provider: "alpha", model: "m" }] },
		{ id: "inner", algorithm: "priority", candidates: [{ provider: "beta", model: "m" }] }
	]));
});

test("validateRoutes rejects duplicate advertised models within one provider", () => {
	assert.throws(
		() => validateRoutes([
			{ id: "a", provider: "routed", algorithm: "priority", candidates: [{ provider: "alpha", model: "m" }] },
			{ id: "b", provider: "routed", model: "a", algorithm: "priority", candidates: [{ provider: "alpha", model: "m" }] }
		]),
		{ message: 'dsh-model-router: routes in provider "routed" advertise duplicate virtual model "a"' }
	);
});

test("groupSignature is stable for an unchanged group", () => {
	const group = () => [
		normalizeRoute({ id: "a", provider: "routed", algorithm: "priority", candidates: [{ provider: "alpha", model: "m1" }] }),
		normalizeRoute({ id: "b", provider: "routed", model: "strong", algorithm: "round-robin", candidates: [{ provider: "beta", model: "m2" }, { provider: "gamma", model: "m3" }] })
	];
	// Same shape, any route order within the group (signature sorts by advertised model).
	assert.equal(groupSignature(group()), groupSignature(group()));
	assert.equal(groupSignature(group()), groupSignature([group()[1], group()[0]]));
});

test("groupSignature changes on any shape edit", () => {
	const group = () => [
		normalizeRoute({ id: "a", provider: "routed", algorithm: "priority", candidates: [{ provider: "alpha", model: "m1" }] }),
		normalizeRoute({ id: "b", provider: "routed", model: "strong", algorithm: "round-robin", candidates: [{ provider: "beta", model: "m2" }, { provider: "gamma", model: "m3" }] })
	];
	const baseline = groupSignature(group());
	// Edited candidate list.
	const candidates = group();
	candidates[1].candidates = [{ provider: "beta", model: "m2" }];
	assert.notEqual(groupSignature(candidates), baseline);
	// Different algorithm.
	const algorithm = group();
	algorithm[0].algorithm = "round-robin";
	assert.notEqual(groupSignature(algorithm), baseline);
	// Different advertised model.
	const model = group();
	model[0].advertisedModel = "chat";
	assert.notEqual(groupSignature(model), baseline);
});
