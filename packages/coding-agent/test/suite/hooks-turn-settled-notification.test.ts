import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseHookConfig } from "../../src/core/extensions/builtin/hooks/index.ts";
import { createHookTrustEntry, hookTrustId } from "../../src/core/extensions/builtin/hooks/trust.ts";
import type { HookSourceMetadata, HookTrustEntry } from "../../src/core/extensions/builtin/hooks/types.ts";
import { builtinExtensions } from "../../src/core/extensions/builtin/index.ts";
import { WAKE_SOURCE_STATE_EVENT } from "../../src/core/extensions/builtin/monitor-state-event.ts";
import type { ExtensionRunner } from "../../src/core/extensions/runner.ts";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { createHarness } from "./harness.ts";

type WakeSource = {
	readonly source: string;
	readonly activeCount: number;
};

type TurnSettledFixture = {
	readonly stdinPath: string;
	readonly runner: ExtensionRunner;
	readonly emit: (event: Parameters<ExtensionRunner["emit"]>[0]) => Promise<void>;
	readonly cleanup: () => void;
};

/**
 * Publishes `wake_source_state` the way every real publisher does (senpi-task, terminal monitors,
 * omo-dag, loop-guard): active counts on session start, zero counts when the work leaves the live
 * set. `agent_end` stands in for that leave edge so the delete branch of the tracker is exercised
 * through the same bus rather than by poking the hooks closure.
 */
function wakeSourcePublisher(sources: readonly WakeSource[]) {
	return {
		path: "<test:wake-source-publisher>",
		factory: (pi: ExtensionAPI) => {
			pi.on("session_start", () => {
				for (const entry of sources) pi.events.emit(WAKE_SOURCE_STATE_EVENT, entry);
			});
			pi.on("agent_end", () => {
				for (const entry of sources) pi.events.emit(WAKE_SOURCE_STATE_EVENT, { ...entry, activeCount: 0 });
			});
		},
	};
}

async function prepareTurnSettled(sources: readonly WakeSource[]): Promise<TurnSettledFixture> {
	const hookDir = join(tmpdir(), `senpi-turn-settled-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(hookDir, { recursive: true });
	const stdinPath = join(hookDir, "stdin.json");
	const scriptPath = join(hookDir, "notify.mjs");
	writeFileSync(
		scriptPath,
		`import { writeFileSync } from 'node:fs'; let stdin = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (chunk) => { stdin += chunk; }); process.stdin.on('end', () => { const payload = JSON.parse(stdin); if (payload.kind === 'turn-settled') writeFileSync(${JSON.stringify(stdinPath)}, stdin); process.stdout.write('{}'); });`,
		"utf-8",
	);

	const hooksExtension = builtinExtensions.find((entry) => entry.id === "hooks");
	if (hooksExtension === undefined) throw new Error("builtin hooks extension is not registered");
	const harness = await createHarness({
		extensionFactories: [{ factory: hooksExtension.factory, path: "<builtin:hooks>" }, wakeSourcePublisher(sources)],
	});
	const cleanup = () => {
		harness.cleanup();
		rmSync(hookDir, { recursive: true, force: true });
	};
	try {
		await harness.session.bindExtensions({});
		const senpiDir = join(harness.tempDir, ".senpi");
		mkdirSync(senpiDir, { recursive: true });
		const hookConfig = {
			hooks: { Notification: [{ hooks: [{ type: "command", command: `${process.execPath} ${scriptPath}` }] }] },
		};
		writeFileSync(join(senpiDir, "hooks.json"), `${JSON.stringify(hookConfig, null, 2)}\n`, "utf-8");
		const source = {
			discoveredAt: "pre-session",
			displayOrder: 0,
			scope: "project",
			sourcePath: join(senpiDir, "hooks.json"),
		} satisfies HookSourceMetadata;
		const parsed = parseHookConfig(hookConfig, source);
		const trust: Record<string, HookTrustEntry> = {};
		for (const handler of parsed.executableHandlers) {
			trust[hookTrustId(handler)] = createHookTrustEntry(handler, {
				platform: process.platform,
				updatedAt: "2026-06-29T00:00:00.000Z",
			});
		}
		writeFileSync(
			join(senpiDir, "hooks-state.json"),
			`${JSON.stringify({ version: 1, hooks: trust }, null, 2)}\n`,
			"utf-8",
		);
		const runner = harness.getExtensionRunner();
		await runner.emit({ type: "session_start", reason: "startup" });
		return {
			cleanup,
			runner,
			stdinPath,
			emit: async (event) => {
				await runner.emit(event);
			},
		};
	} catch (error) {
		cleanup();
		throw error;
	}
}

describe("builtin hooks turn-settled Notification", () => {
	it("dispatches Notification with the live wake sources when a run settles with background work active", async () => {
		const fixture = await prepareTurnSettled([
			{ source: "terminal-monitors", activeCount: 2 },
			{ source: "senpi-task", activeCount: 1 },
		]);
		try {
			await fixture.emit({ type: "agent_settled" });
			const stdin: Record<string, unknown> = JSON.parse(readFileSync(fixture.stdinPath, "utf-8"));
			expect(stdin).toMatchObject({
				event: "Notification",
				hook_event_name: "Notification",
				kind: "turn-settled",
				notification_source: "wake-source",
				title: "Background work still active",
			});
			// Sources are emitted in reverse order above; the message must stay deterministic.
			expect(stdin.message).toBe(
				"Turn settled while background work is still active: senpi-task (1), terminal-monitors (2).",
			);
		} finally {
			fixture.cleanup();
		}
	});

	it("stays silent when no wake source has ever been published", async () => {
		const fixture = await prepareTurnSettled([]);
		try {
			await fixture.emit({ type: "agent_settled" });
			expect(existsSync(fixture.stdinPath)).toBe(false);
		} finally {
			fixture.cleanup();
		}
	});

	it("stays silent for the ask-user wake source, which already has its own Notification kinds", async () => {
		const fixture = await prepareTurnSettled([{ source: "ask-user", activeCount: 1 }]);
		try {
			await fixture.emit({ type: "agent_settled" });
			expect(existsSync(fixture.stdinPath)).toBe(false);
		} finally {
			fixture.cleanup();
		}
	});

	it("stays silent once every wake source has cleared back to zero", async () => {
		const fixture = await prepareTurnSettled([{ source: "terminal-monitors", activeCount: 2 }]);
		try {
			await fixture.emit({ type: "agent_end", messages: [] });
			await fixture.emit({ type: "agent_settled" });
			expect(existsSync(fixture.stdinPath)).toBe(false);
		} finally {
			fixture.cleanup();
		}
	});
});
