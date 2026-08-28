import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type AgentSessionRuntime,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import {
	createInteractiveHostRuntime,
	INTERACTIVE_HOST_FALLBACK_WARNING,
} from "../src/modes/interactive/interactive-host-runtime.ts";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";
import { startFakeModelServer } from "./helpers/rpc-fake-model.ts";
import { hermeticProviderEnv, MOCK_MODEL, MOCK_PROVIDER, writeRpcModelsJson } from "./helpers/rpc-hermetic.ts";

const roots: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];
const runtimes: AgentSessionRuntime[] = [];

afterEach(async () => {
	await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
	await Promise.all(children.splice(0).map(stopChild));
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch(label: string) {
	const root = mkdtempSync(join(tmpdir(), `senpi-interactive-host-${label}-`));
	roots.push(root);
	const agentDir = join(root, "agent");
	const sessionDir = join(root, "sessions");
	const cwd = join(root, "work");
	const socket = join(root, "rpc.sock");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(sessionDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	return { root, agentDir, sessionDir, cwd, socket };
}

function spawnHost(qa: ReturnType<typeof scratch>): ChildProcessWithoutNullStreams {
	const child = spawn(
		process.execPath,
		[
			join(import.meta.dirname, "..", "src", "cli.ts"),
			"--mode",
			"rpc",
			"--multi-session",
			"--listen",
			`unix://${qa.socket}`,
			"--provider",
			MOCK_PROVIDER,
			"--model",
			MOCK_MODEL,
		],
		{
			cwd: qa.cwd,
			env: {
				...process.env,
				...hermeticProviderEnv(),
				PI_OFFLINE: "1",
				PI_TELEMETRY: "0",
				SENPI_RUNTIME: "node",
				SENPI_CODING_AGENT_DIR: qa.agentDir,
				SENPI_CODING_AGENT_SESSION_DIR: qa.sessionDir,
			},
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
	children.push(child);
	return child;
}

async function createAgentSessionRuntimeFixture(options: {
	cwd: string;
	agentDir: string;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
}): Promise<AgentSessionRuntime> {
	const createRuntime = async ({ cwd, sessionManager }: { cwd: string; sessionManager: SessionManager }) => {
		const services = await createAgentSessionServices({
			cwd,
			agentDir: options.agentDir,
			settingsManager: options.settingsManager,
			resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true },
		});
		return {
			...(await createAgentSessionFromServices({ services, sessionManager })),
			services,
			diagnostics: services.diagnostics,
		};
	};
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd: options.cwd,
		agentDir: options.agentDir,
		sessionManager: options.sessionManager,
	});
	runtimes.push(runtime);
	return runtime;
}

async function waitForHost(child: ChildProcessWithoutNullStreams, socket: string): Promise<void> {
	let stderr = "";
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`host readiness timed out: ${stderr}`)), 15_000);
		const onData = (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
			if (!stderr.includes(`senpi rpc listening on unix://${socket}`)) return;
			clearTimeout(timer);
			child.stderr.off("data", onData);
			resolve();
		};
		child.stderr.on("data", onData);
		child.once("exit", (code, signal) => {
			clearTimeout(timer);
			reject(new Error(`host exited ${code ?? signal}: ${stderr}`));
		});
	});
}

describe("interactive host runtime", () => {
	it("is live to parallel clients, prompts remotely, and remains durably resumable", async () => {
		const qa = scratch("remote");
		const fake = await startFakeModelServer();
		writeRpcModelsJson(qa.agentDir, fake.origin);
		const host = spawnHost(qa);
		await waitForHost(host, qa.socket);
		const localSessionManager = SessionManager.create(qa.cwd, qa.sessionDir);
		const sessionPath = localSessionManager.getSessionFile();
		if (!sessionPath) throw new Error("Expected persisted session path");
		const local = await createAgentSessionRuntimeFixture({
			cwd: qa.cwd,
			agentDir: qa.agentDir,
			sessionManager: localSessionManager,
			settingsManager: SettingsManager.create(qa.cwd, qa.agentDir),
		});
		const onWarning = vi.fn();
		const runtime = await createInteractiveHostRuntime(local, {
			socket: qa.socket,
			ensureHost: async () => undefined,
			onWarning,
		});
		expect(onWarning).not.toHaveBeenCalled();
		const observer = new RpcClient({ socketPath: qa.socket });
		await observer.start();
		try {
			const listed = await observer.listSessions();
			const live = listed.find((entry) => entry.status === "open");
			expect(live).toBeDefined();
			const durableId = live?.durableSessionId;
			expect(durableId).toBeTruthy();

			const settled = new Promise<void>((resolve) => {
				const unsubscribe = runtime.session.subscribe((event) => {
					if (event.type !== "agent_settled") return;
					unsubscribe();
					resolve();
				});
			});
			await runtime.session.prompt("interactive-host-unique");
			await settled;
			expect(await runtime.session.getLastAssistantText()).toBeTruthy();

			await runtime.dispose();
			const afterClose = await observer.listSessions();
			expect(afterClose.find((entry) => entry.sessionPath === sessionPath)).toBeUndefined();
			const resumed = await observer.openSession({ sessionPath, cwd: qa.cwd });
			expect(resumed.state.sessionId).toBe(durableId);
			await observer.closeSession(resumed.sessionId);
		} finally {
			await observer.stop();
			await fake.close();
		}
	});

	it("delivers prompt disposition and preflight callbacks before the canonical user message_start", async () => {
		const qa = scratch("disposition");
		const fake = await startFakeModelServer();
		writeRpcModelsJson(qa.agentDir, fake.origin);
		const host = spawnHost(qa);
		await waitForHost(host, qa.socket);
		const local = await createAgentSessionRuntimeFixture({
			cwd: qa.cwd,
			agentDir: qa.agentDir,
			sessionManager: SessionManager.create(qa.cwd, qa.sessionDir),
			settingsManager: SettingsManager.create(qa.cwd, qa.agentDir),
		});
		const runtime = await createInteractiveHostRuntime(local, {
			socket: qa.socket,
			ensureHost: async () => undefined,
			onWarning: vi.fn(),
		});
		try {
			const order: string[] = [];
			const promptDisposition = vi.fn((disposition: string) => {
				order.push(`disposition:${disposition}`);
			});
			const preflightResult = vi.fn((success: boolean) => {
				order.push(`preflight:${success}`);
			});
			const settled = new Promise<void>((resolve) => {
				const unsubscribe = runtime.session.subscribe((event) => {
					if (event.type === "message_start" && event.message.role === "user") order.push("event:message_start");
					if (event.type !== "agent_settled") return;
					unsubscribe();
					resolve();
				});
			});
			await runtime.session.prompt("disposition-probe", { promptDisposition, preflightResult });
			await settled;
			expect(promptDisposition).toHaveBeenCalledWith("started");
			expect(preflightResult).toHaveBeenCalledWith(true);
			expect(order).toEqual(["disposition:started", "preflight:true", "event:message_start"]);
		} finally {
			await runtime.dispose();
			await fake.close();
		}
	});

	it("forwards streamingBehavior so a mid-stream prompt queues instead of failing", async () => {
		const qa = scratch("queued");
		const fake = await startFakeModelServer();
		writeRpcModelsJson(qa.agentDir, fake.origin);
		const host = spawnHost(qa);
		await waitForHost(host, qa.socket);
		const local = await createAgentSessionRuntimeFixture({
			cwd: qa.cwd,
			agentDir: qa.agentDir,
			sessionManager: SessionManager.create(qa.cwd, qa.sessionDir),
			settingsManager: SettingsManager.create(qa.cwd, qa.agentDir),
		});
		const runtime = await createInteractiveHostRuntime(local, {
			socket: qa.socket,
			ensureHost: async () => undefined,
			onWarning: vi.fn(),
		});
		try {
			const firstSettled = new Promise<void>((resolve) => {
				const unsubscribe = runtime.session.subscribe((event) => {
					if (event.type !== "agent_settled") return;
					unsubscribe();
					resolve();
				});
			});
			void runtime.session.prompt("hold-open-1500 first-turn");
			const streamingDeadline = Date.now() + 10_000;
			while (!runtime.session.isStreaming) {
				if (Date.now() > streamingDeadline) throw new Error("session never entered streaming state");
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
			const queuedDisposition = vi.fn();
			const queuedPreflight = vi.fn();
			await runtime.session.prompt("queued second turn", {
				streamingBehavior: "followUp",
				promptDisposition: queuedDisposition,
				preflightResult: queuedPreflight,
			});
			await firstSettled;
			expect(queuedDisposition).toHaveBeenCalledWith("queued");
			expect(queuedPreflight).toHaveBeenCalledWith(true);
		} finally {
			await runtime.dispose();
			await fake.close();
		}
	});

	it("reflects remote thinking-level cycles in session.state for footer rendering", async () => {
		const qa = scratch("state-sync");
		const fake = await startFakeModelServer();
		writeRpcModelsJson(qa.agentDir, fake.origin);
		const host = spawnHost(qa);
		await waitForHost(host, qa.socket);
		const local = await createAgentSessionRuntimeFixture({
			cwd: qa.cwd,
			agentDir: qa.agentDir,
			sessionManager: SessionManager.create(qa.cwd, qa.sessionDir),
			settingsManager: SettingsManager.create(qa.cwd, qa.agentDir),
		});
		const runtime = await createInteractiveHostRuntime(local, {
			socket: qa.socket,
			ensureHost: async () => undefined,
			onWarning: vi.fn(),
		});
		try {
			const newLevel = await runtime.session.cycleThinkingLevel();
			expect(newLevel).toBeTruthy();
			// The footer reads session.state.thinkingLevel; the proxy must surface the
			// host's level there too, not only through the direct thinkingLevel getter.
			expect(runtime.session.thinkingLevel).toBe(newLevel);
			expect(runtime.session.state.thinkingLevel).toBe(newLevel);
		} finally {
			await runtime.dispose();
			await fake.close();
		}
	});

	it("synchronizes sessionManager and messages when compaction completes on the host", async () => {
		const qa = scratch("compaction-sync");
		mkdirSync(join(qa.agentDir), { recursive: true });
		writeFileSync(join(qa.agentDir, "settings.json"), JSON.stringify({ compaction: { keepRecentTokens: 10 } }));
		const fake = await startFakeModelServer();
		writeRpcModelsJson(qa.agentDir, fake.origin);
		const host = spawnHost(qa);
		await waitForHost(host, qa.socket);
		const localSessionManager = SessionManager.create(qa.cwd, qa.sessionDir);
		const local = await createAgentSessionRuntimeFixture({
			cwd: qa.cwd,
			agentDir: qa.agentDir,
			sessionManager: localSessionManager,
			settingsManager: SettingsManager.create(qa.cwd, qa.agentDir),
		});
		const runtime = await createInteractiveHostRuntime(local, {
			socket: qa.socket,
			ensureHost: async () => undefined,
			onWarning: vi.fn(),
		});
		try {
			for (const text of ["hello turn one", "hello turn two", "hello turn three", "hello turn four"]) {
				const turnSettled = new Promise<void>((resolve) => {
					const unsubscribe = runtime.session.subscribe((event) => {
						if (event.type === "agent_settled") {
							unsubscribe();
							resolve();
						}
					});
				});
				await runtime.session.prompt(text);
				await turnSettled;
				await new Promise((r) => setTimeout(r, 50));
			}

			const compactionEnded = new Promise<void>((resolve) => {
				const unsubscribe = runtime.session.subscribe((event) => {
					if (event.type !== "compaction_end") return;
					unsubscribe();
					resolve();
				});
			});
			await runtime.session.compact();
			await compactionEnded;

			const entries = localSessionManager.buildContextEntries();
			expect(entries[0]?.type).toBe("compaction");
		} finally {
			await runtime.dispose();
			await fake.close();
		}
	});

	it("falls back locally with a typed warning when the host remains unreachable", async () => {
		const qa = scratch("fallback");
		const fake = await startFakeModelServer();
		writeRpcModelsJson(qa.agentDir, fake.origin);
		const local = await createAgentSessionRuntimeFixture({
			cwd: qa.cwd,
			agentDir: qa.agentDir,
			sessionManager: SessionManager.create(qa.cwd, qa.sessionDir),
			settingsManager: SettingsManager.create(qa.cwd, qa.agentDir),
		});
		const warnings: string[] = [];
		const runtime = await createInteractiveHostRuntime(local, {
			socket: qa.socket,
			ensureHost: async () => {
				throw new Error("host intentionally unavailable");
			},
			onWarning: (warning) => warnings.push(warning.message),
		});
		try {
			expect(runtime).toBe(local);
			expect(warnings).toEqual([`${INTERACTIVE_HOST_FALLBACK_WARNING}: host intentionally unavailable`]);
			await runtime.session.prompt("local-fallback-unique");
			await runtime.session.waitForIdle();
			expect(runtime.session.getLastAssistantText()).toBeTruthy();
		} finally {
			await runtime.dispose();
			await fake.close();
		}
	});
});

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	child.kill("SIGTERM");
	await new Promise<void>((resolve) => {
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			resolve();
		}, 2_000);
		child.once("exit", () => {
			clearTimeout(timer);
			resolve();
		});
	});
}
