import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { WAKE_SOURCE_STATE_EVENT } from "../../../src/core/extensions/builtin/monitor-state-event.ts";
import { createHarness, type Harness } from "../harness.ts";

describe("agent_settled reports busy to extensions while a wake source is live", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("reads idle false while the source is live and true once it clears", async () => {
		const settledIdleStates: boolean[] = [];
		let wakeSourceOpened = false;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_end", () => {
						if (wakeSourceOpened) {
							pi.events.emit(WAKE_SOURCE_STATE_EVENT, { source: "terminal-monitors", activeCount: 0 });
							return;
						}
						wakeSourceOpened = true;
						pi.events.emit(WAKE_SOURCE_STATE_EVENT, { source: "terminal-monitors", activeCount: 1 });
					});
					pi.on("agent_settled", (_event, ctx) => {
						settledIdleStates.push(ctx.isIdle());
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);

		await harness.session.prompt("turn one");
		expect(harness.session.isIdle).toBe(true);
		await harness.session.prompt("turn two");

		expect(harness.eventsOfType("agent_settled")).toHaveLength(2);
		expect(settledIdleStates).toEqual([false, true]);
	});

	it("stays idle through settlement when no wake source was ever published", async () => {
		const settledIdleStates: boolean[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_settled", (_event, ctx) => {
						settledIdleStates.push(ctx.isIdle());
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);

		await harness.session.prompt("turn");

		expect(settledIdleStates).toEqual([true]);
	});
});
