<!-- changes-log: packages/coding-agent/src/core/extensions/builtin/ttsr/changes.md -->
## 2026-11-17 - The streaming abort waits for the streak the rule advertises

### What changed

- `packages/coding-agent/src/core/extensions/builtin/ttsr/repetitive-turns-lane.ts`: `observeTextDelta` gains a streak gate. Arming is legal only when `#streamStreakReached()` holds - `!this.#state.latched && this.#state.streak + 1 >= REPETITIVE_TURNS_STREAK_LENGTH - 1` - so the stream cuts a turn on the same turn the batch detector fires on, not on the second similar turn.
- `commitArmedTurn` now advances the detector state with `recordTurnText(this.#state, turnText)` after setting `#lastCompletedTurnText`, discarding the verdict. The aborted turn counts toward the streak, which latches the rule and ends the cycle.

### Why

- The rule text promises an abort after three consecutive near-identical turns, and `recordTurnText` enforces exactly that. The streaming path had no gate at all: with one completed turn on record it armed on the very next similar delta, so the observed aborts fired at streak 2 after ~113-143 normalized characters. The two paths disagreed, and the abort contradicted the wording the user was shown.

### Why an extension could not handle it

- The lane is internal state of the builtin ttsr extension. No extension API exposes the lane's private `#state` or its arming decision, so the gate has to live in the lane itself.

### Expected merge conflict zones

- LOW: the `observeTextDelta` guard chain and `commitArmedTurn` in `repetitive-turns-lane.ts`; the import list gains `REPETITIVE_TURNS_STREAK_LENGTH`.

<!-- changes-log: packages/coding-agent/CHANGELOG.md -->
### Fixed
- The ttsr repetitive-turns rule no longer aborts a streamed turn on the second near-identical reply. The streaming abort now waits for the same three-turn streak the rule documents and the completed-turn detector enforces, and the aborted turn counts toward the streak so one cycle aborts at most once.
