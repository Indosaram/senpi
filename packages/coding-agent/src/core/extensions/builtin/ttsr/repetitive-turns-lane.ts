import {
	createRepetitiveTurnsState,
	isNearDuplicateOfPreviousTurn,
	normalizeTurnText,
	REPETITIVE_TURNS_MIN_NORMALIZED_CHARS,
	REPETITIVE_TURNS_RULE_NAME,
	REPETITIVE_TURNS_STREAK_LENGTH,
	type RepetitiveTurnsState,
	recordTurnText,
} from "./detectors/repetitive-turns.ts";

export function collectAssistantText(message: { readonly content: unknown }): string | null {
	if (!Array.isArray(message.content)) return null;
	let combined = "";
	for (const block of message.content) {
		if (typeof block !== "object" || block === null) continue;
		if (!("type" in block) || block.type !== "text") continue;
		const value: unknown = Reflect.get(block, "text");
		if (typeof value === "string") combined += value;
	}
	return combined.length > 0 ? combined : null;
}

const RESTORED_TURN_LIMIT = 8;

interface SessionEntrySource {
	readonly sessionManager: { getEntries(): readonly unknown[] };
}

export function readPersistedAssistantTexts(ctx: SessionEntrySource): string[] {
	const texts: string[] = [];
	for (const entry of ctx.sessionManager.getEntries()) {
		if (typeof entry !== "object" || entry === null) continue;
		if (!("type" in entry) || entry.type !== "message") continue;
		const message: unknown = Reflect.get(entry, "message");
		if (typeof message !== "object" || message === null) continue;
		if (Reflect.get(message, "role") !== "assistant") continue;
		const text = collectAssistantText({ content: Reflect.get(message, "content") });
		if (text !== null) texts.push(text);
	}
	return texts.slice(-RESTORED_TURN_LIMIT);
}

export class RepetitiveTurnsLane {
	#state: RepetitiveTurnsState = createRepetitiveTurnsState();
	#armed = false;
	#recovering = false;
	#currentTurnText = "";
	#lastCompletedTurnText: string | null = null;
	#enabled = true;

	configure(disabledRules: ReadonlySet<string>): void {
		this.#enabled = !disabledRules.has(REPETITIVE_TURNS_RULE_NAME);
	}

	resetSession(): void {
		this.#state = createRepetitiveTurnsState();
		this.#armed = false;
		this.#recovering = false;
		this.#currentTurnText = "";
		this.#lastCompletedTurnText = null;
	}

	restoreFromHistory(assistantTexts: readonly string[]): void {
		for (const text of assistantTexts) {
			this.recordCompletedTurn(text);
		}
		this.#armed = false;
	}

	resetTurn(): void {
		this.#armed = false;
		this.#currentTurnText = "";
	}

	disarm(): void {
		this.#armed = false;
	}

	get armed(): boolean {
		return this.#armed;
	}

	/**
	 * The streaming abort cuts a turn mid-flight, so it must only fire on the turn that
	 * completes the streak the batch detector requires. `streak` counts the similar pairs
	 * already recorded among completed turns and the turn being streamed is the next one,
	 * so arming is legal only when `streak + 1` reaches the same bound `recordTurnText` uses.
	 * Without this, the second similar turn aborted while the wording promised three.
	 */
	#streamStreakReached(): boolean {
		return !this.#state.latched && this.#state.streak + 1 >= REPETITIVE_TURNS_STREAK_LENGTH - 1;
	}

	observeTextDelta(delta: string, canArm: boolean): boolean {
		if (
			this.#enabled &&
			!this.#armed &&
			!this.#recovering &&
			canArm &&
			this.#streamStreakReached() &&
			this.#lastCompletedTurnText !== null
		) {
			const candidate = normalizeTurnText(this.#currentTurnText + delta);
			if (
				candidate.length >= REPETITIVE_TURNS_MIN_NORMALIZED_CHARS &&
				isNearDuplicateOfPreviousTurn(candidate, this.#lastCompletedTurnText)
			) {
				this.#armed = true;
			}
		}
		this.#currentTurnText += delta;
		return this.#armed;
	}

	commitArmedTurn(turnText: string | null): void {
		this.#armed = false;
		this.#recovering = true;
		if (turnText !== null) {
			this.#lastCompletedTurnText = normalizeTurnText(turnText);
			// The aborted turn still happened: advancing the detector state here is what latches
			// the rule, so one streak cycle aborts at most once instead of re-arming on every
			// following similar turn. The verdict is discarded - the nudge for this turn is
			// already being built by the caller.
			recordTurnText(this.#state, turnText);
		}
	}

	recordCompletedTurn(turnText: string): void {
		const normalized = normalizeTurnText(turnText);
		this.#lastCompletedTurnText = normalized;
		if (!this.#enabled) return;
		const match = recordTurnText(this.#state, turnText);
		if (match === null) {
			if (this.#recovering) this.#recovering = false;
			return;
		}
		this.#armed = true;
	}
}
