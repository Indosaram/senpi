import { existsSync, readFileSync } from "node:fs";
import type { BeforeAgentStartEventResult, ExtensionAPI, ExtensionContext, LoadedHookSources } from "../../types.ts";
import { formatResultText } from "../ask-user/format.ts";
import {
	ASK_USER_ASKED_EVENT,
	ASK_USER_SETTLED_EVENT,
	type AskUserAskedEvent,
	type AskUserSettledEvent,
} from "../ask-user/notify.ts";
import { isWakeSourceStateEvent, WAKE_SOURCE_STATE_EVENT } from "../monitor-state-event.ts";
import { registerHooksCommand } from "./command.ts";
import { loadHookConfigSources, loadHookConfigSourcesAsync } from "./config-loader.ts";
import { dispatchHookEvent, runningHookHandlersStatusLabel } from "./dispatcher.ts";
import {
	buildNotificationHookInput,
	buildPostCompactHookInput,
	buildPreCompactHookInput,
	buildSessionStartHookInput,
	dispatchLifecycleHookEvent,
	dispatchNotificationHookEvent,
	notificationResultDetails,
	postCompactResultDetails,
	preCompactResultDetails,
	recordLifecycleHookResult,
	sessionBeforeCompactResult,
	sessionStartResultDetails,
} from "./lifecycle-adapter.ts";
import {
	appendSystemMessages,
	buildUserPromptHookInput,
	formatPromptContextMessage,
	HOOK_CUSTOM_MESSAGE_TYPE,
	type PendingPromptHookContext,
	promptBlockReasonFromResult,
	promptContextFromResult,
	safeDiagnosticDetails,
} from "./prompt-adapter.ts";
import { applyStopHookResult, buildStopHookInput, createStopTurnTracker } from "./stop-adapter.ts";
import {
	applyPostToolUseResult,
	applyPreToolUseResult,
	buildPostToolUseHookInput,
	buildPreToolUseHookInput,
	toolContextsFromResult,
} from "./tool-adapter.ts";
import { emptyHookTrustState } from "./trust.ts";
import { FileHookStateStorage } from "./trust-storage.ts";
import type { HookInputWire, HookTrustState } from "./types.ts";

export { parseHookConfig } from "./schema.ts";
export type {
	CommandHookConfig,
	ExecutableHookHandler,
	HookDiagnostic,
	HookDiagnosticCode,
	HookInputWire,
	HookOutputWire,
	HookRuntimeState,
	HookSourceMetadata,
	HookTrustEntry,
	HookTrustState,
	ParsedHookConfig,
	SupportedHookEvent,
	UnsupportedKnownHookEvent,
} from "./types.ts";

export default function hooksExtension(pi: ExtensionAPI): void {
	const pendingPromptContexts: PendingPromptHookContext[] = [];
	const pendingPreToolContexts = new Map<string, readonly string[]>();
	const stopTurnTracker = createStopTurnTracker();

	const refreshState = (ctx: ExtensionContext) => {
		const sources = ctx.getLoadedHookSources?.() ?? fallbackHookSources(ctx.cwd);
		const parsed = loadHookConfigSources({
			agentDir: sources.agentDir,
			cwd: sources.cwd,
			fileSystem: {
				readTextFile(path) {
					return existsSync(path) ? readFileSync(path, "utf-8") : undefined;
				},
			},
			globalHookSourcePaths: sources.globalHookSourcePaths,
			globalHooksPath: sources.globalHooksPath,
			globalSettingsHooks: sources.globalSettingsHooks,
			preSessionHookSourcePaths: sources.preSessionHookSourcePaths,
			projectHookSourcePaths: sources.projectHookSourcePaths,
			projectHooksPath: sources.projectHooksPath,
			projectSettingsHooks: sources.projectSettingsHooks,
			runtimeHookSourcePaths: sources.runtimeHookSourcePaths,
		});
		const storage = new FileHookStateStorage({ agentDir: sources.agentDir, cwd: sources.cwd });
		const trust = mergeTrustStates(
			storage.read("global"),
			ctx.isProjectTrusted() ? storage.read("project") : emptyHookTrustState(),
		);
		return { parsed, trust, storage };
	};

	for (const channel of [ASK_USER_ASKED_EVENT, ASK_USER_SETTLED_EVENT]) {
		pi.events.on(channel, async (data) => {
			const event = data as AskUserAskedEvent | AskUserSettledEvent;
			const { ctx, request, variant } = event;
			const response = "response" in event ? event.response : undefined;
			const headers = request.questions.map((question) => question.header).join(", ");
			// Capture session identity before asynchronous I/O or a session switch.
			const input = buildNotificationHookInput(
				{
					kind:
						response === undefined
							? "ask-user-asked"
							: response.status === "timed_out"
								? "ask-user-timeout"
								: "ask-user-settled",
					message:
						response === undefined
							? `Question asked (${headers})`
							: response.status === "timed_out"
								? `Question timed out (${headers}): ${formatResultText(variant, response, request.questions)}`
								: `Question ${response.status} (${headers})`,
					requestId: request.requestId,
					source: "ask-user",
					status: response?.status ?? "pending",
					title: headers,
				},
				ctx,
			);
			await runConfiguredNotification(pi, ctx, input);
		});
	}

	// Wake sources outlive the turn that started them: background bash sessions, terminal monitors,
	// subagent tasks, DAG runs, loop holds. A run that settles with any of them live hands the session
	// off to work the user cannot see in the transcript, which is a different outcome than a turn that
	// settles with none - so it earns its own Notification kind and a turn with none stays silent.
	const activeWakeSources = new Map<string, number>();
	pi.events.on(WAKE_SOURCE_STATE_EVENT, (data) => {
		if (!isWakeSourceStateEvent(data)) return;
		// ask-user already reports through its own Notification kinds and keeps the question on screen,
		// so counting it here would double-notify a pending question instead of reporting hidden work.
		if (data.source === "ask-user") return;
		if (data.activeCount > 0) activeWakeSources.set(data.source, data.activeCount);
		else activeWakeSources.delete(data.source);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (activeWakeSources.size === 0) return;
		// Built synchronously: session identity must be captured before the async config load below.
		const input = buildNotificationHookInput(
			{
				kind: "turn-settled",
				message: `Turn settled while background work is still active: ${summarizeWakeSources(activeWakeSources)}.`,
				source: "wake-source",
				title: "Background work still active",
			},
			ctx,
		);
		await runConfiguredNotification(pi, ctx, input);
	});

	pi.on("session_start", async (event, ctx) => {
		const state = refreshState(ctx);
		const input = buildSessionStartHookInput(event, ctx);
		const result = await dispatchLifecycleHookEvent({
			cwd: ctx.cwd,
			handlers: state.parsed.executableHandlers,
			input,
			matcherInputs: ["SessionStart", event.reason],
			...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
			trustState: state.trust,
		});
		recordLifecycleHookResult(pi, "SessionStart", sessionStartResultDetails(result));
	});

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return undefined;
		stopTurnTracker.reset();
		pendingPromptContexts.splice(0);
		const state = refreshState(ctx);
		const input = buildUserPromptHookInput({
			cwd: ctx.cwd,
			permissionMode: "default",
			prompt: event.text,
			sessionId: ctx.sessionManager.getSessionId(),
			transcriptPath: ctx.sessionManager.getSessionFile(),
		});
		const result = await dispatchHookEvent({
			cwd: ctx.cwd,
			handlers: state.parsed.executableHandlers,
			input,
			signal: ctx.signal,
			trustOptions: { platform: process.platform },
			trustState: state.trust,
		});
		if (result.decision.kind === "block") {
			const reason = promptBlockReasonFromResult(result);
			ctx.ui.notify(reason, "warning");
			pi.sendMessage(
				{
					customType: HOOK_CUSTOM_MESSAGE_TYPE,
					content: reason,
					display: false,
					details: {
						decision: "block",
						event: "UserPromptSubmit",
						sourcePath: result.decision.source.sourcePath,
					},
				},
				{ triggerTurn: false },
			);
			return { action: "handled" };
		}
		if (ctx.isIdle()) {
			const pending = promptContextFromResult(result);
			if (pending !== undefined) {
				pendingPromptContexts.push(pending);
			}
		}
		return { action: "continue" };
	});

	pi.on("before_agent_start", async (event) => {
		const pending = pendingPromptContexts.shift();
		if (pending === undefined) return undefined;

		const messageContent = formatPromptContextMessage(pending);
		const systemPrompt = appendSystemMessages(event.systemPrompt, pending.systemMessages);
		if (messageContent === undefined && systemPrompt === event.systemPrompt) return undefined;

		const result: BeforeAgentStartEventResult = {};
		if (messageContent !== undefined) {
			result.message = {
				customType: HOOK_CUSTOM_MESSAGE_TYPE,
				content: messageContent,
				display: false,
				details: {
					event: "UserPromptSubmit",
					diagnostics: pending.diagnostics.map(safeDiagnosticDetails),
				},
			};
		}
		if (systemPrompt !== event.systemPrompt) {
			result.systemPrompt = systemPrompt;
		}
		return result;
	});

	pi.on("tool_call", async (event, ctx) => {
		pendingPreToolContexts.delete(event.toolCallId);
		const state = refreshState(ctx);
		const result = await dispatchHookEvent({
			cwd: ctx.cwd,
			handlers: state.parsed.executableHandlers,
			input: buildPreToolUseHookInput(event, ctx),
			onRunningHandlersChange: (running) => {
				if (running.length === 0) return;
				ctx.updateToolHookStatus?.(runningHookHandlersStatusLabel(running));
			},
			signal: ctx.signal,
			trustOptions: { platform: process.platform },
			trustState: state.trust,
		});
		const toolResult = applyPreToolUseResult(event, result);
		if (toolResult?.block) {
			pendingPreToolContexts.delete(event.toolCallId);
			return toolResult;
		}
		const contexts = toolContextsFromResult(result);
		if (contexts.length > 0) {
			pendingPreToolContexts.set(event.toolCallId, contexts);
		}
		return toolResult;
	});

	pi.on("tool_result", async (event, ctx) => {
		const preToolContexts = pendingPreToolContexts.get(event.toolCallId) ?? [];
		pendingPreToolContexts.delete(event.toolCallId);
		const state = refreshState(ctx);
		const result = await dispatchHookEvent({
			cwd: ctx.cwd,
			handlers: state.parsed.executableHandlers,
			input: buildPostToolUseHookInput(event, ctx),
			onRunningHandlersChange: (running) => {
				if (running.length === 0) return;
				ctx.updateToolHookStatus?.(runningHookHandlersStatusLabel(running));
			},
			signal: ctx.signal,
			trustOptions: { platform: process.platform },
			trustState: state.trust,
		});
		return applyPostToolUseResult(event, result, preToolContexts);
	});

	pi.on("session_before_compact", async (event, ctx) => {
		const state = refreshState(ctx);
		const result = await dispatchLifecycleHookEvent({
			cwd: ctx.cwd,
			handlers: state.parsed.executableHandlers,
			input: buildPreCompactHookInput(event, ctx),
			matcherInputs: ["PreCompact", event.reason],
			signal: event.signal,
			trustState: state.trust,
		});
		const details = preCompactResultDetails(result);
		recordLifecycleHookResult(pi, "PreCompact", details, { compactionRequestId: event.requestId });
		return sessionBeforeCompactResult(details);
	});

	pi.on("session_compact", async (event, ctx) => {
		if (!event.accepted) return undefined;
		const state = refreshState(ctx);
		const result = await dispatchLifecycleHookEvent({
			cwd: ctx.cwd,
			handlers: state.parsed.executableHandlers,
			input: buildPostCompactHookInput(event, ctx),
			matcherInputs: ["PostCompact", event.reason],
			...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
			trustState: state.trust,
		});
		recordLifecycleHookResult(pi, "PostCompact", postCompactResultDetails(result));
		return undefined;
	});

	pi.on("agent_end", async (event, ctx) => {
		const state = refreshState(ctx);
		const result = await dispatchHookEvent({
			cwd: ctx.cwd,
			handlers: state.parsed.executableHandlers,
			input: buildStopHookInput(event, ctx),
			signal: ctx.signal,
			trustOptions: { platform: process.platform },
			trustState: state.trust,
		});
		await applyStopHookResult(pi, ctx, result, stopTurnTracker.turnKey(ctx));
	});

	registerHooksCommand(pi, refreshState);
}

/** Loads Notification handlers for this session, runs one built input through them, and records the outcome. */
async function runConfiguredNotification(pi: ExtensionAPI, ctx: ExtensionContext, input: HookInputWire): Promise<void> {
	const sources = ctx.getLoadedHookSources?.() ?? fallbackHookSources(ctx.cwd);
	const parsed = await loadHookConfigSourcesAsync(sources);
	const handlers = parsed.executableHandlers.filter((handler) => handler.event === "Notification");
	if (handlers.length === 0) return;
	const storage = new FileHookStateStorage({ agentDir: sources.agentDir, cwd: sources.cwd });
	const [globalTrust, projectTrust] = await Promise.all([
		storage.readAsync("global"),
		ctx.isProjectTrusted() ? storage.readAsync("project") : emptyHookTrustState(),
	]);
	const result = await dispatchNotificationHookEvent({
		cwd: ctx.cwd,
		handlers,
		input,
		...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
		trustState: mergeTrustStates(globalTrust, projectTrust),
	});
	const details = notificationResultDetails(result);
	recordLifecycleHookResult(pi, "Notification", {
		...details,
		diagnostics: [...parsed.diagnostics, ...details.diagnostics],
	});
}

/** Deterministic `source (count)` list so the message is stable across otherwise identical turns. */
function summarizeWakeSources(active: ReadonlyMap<string, number>): string {
	return [...active.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([source, count]) => `${source} (${count})`)
		.join(", ");
}

function mergeTrustStates(globalState: HookTrustState, projectState: HookTrustState): HookTrustState {
	return { version: 1, hooks: { ...globalState.hooks, ...projectState.hooks } };
}

function fallbackHookSources(cwd: string): LoadedHookSources {
	return {
		agentDir: cwd,
		cwd,
		globalHookSourcePaths: [],
		globalHooksPath: `${cwd}/hooks.json`,
		preSessionHookSourcePaths: [],
		projectHookSourcePaths: [],
		projectHooksPath: `${cwd}/.senpi/hooks.json`,
		runtimeHookSourcePaths: [],
	};
}

export {
	SUPPORTED_HOOK_EVENTS,
	UNSUPPORTED_HANDLER_TYPES,
	UNSUPPORTED_KNOWN_HOOK_EVENTS,
} from "./types.ts";
