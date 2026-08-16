import type { AssistantMessage, SessionEntry, ToolResultMessage } from "@oh-my-pi/pi-wire";
import { COLLAB_PROMPT_MESSAGE_TYPE } from "@oh-my-pi/pi-wire";
import { isSystemReminder, transcriptToolPresentation } from "./transcript-presentation";

const MAX_WORK_DURATION_MS = 7 * 24 * 60 * 60 * 1_000;

export type AssistantEntry = Extract<SessionEntry, { type: "message" }> & { message: AssistantMessage };
export type ToolResultEntry = Extract<SessionEntry, { type: "message" }> & { message: ToolResultMessage };

export interface TranscriptAssistantTurn {
	kind: "assistant-turn";
	id: string;
	assistantEntries: readonly AssistantEntry[];
	toolResultEntries: readonly ToolResultEntry[];
	toolResults: ReadonlyMap<string, ToolResultEntry>;
	finalEntry?: AssistantEntry;
	durationMs?: number;
	hasProcess: boolean;
}

export interface TranscriptEntryItem {
	kind: "entry";
	entry: SessionEntry;
}

export type TranscriptItem = TranscriptEntryItem | TranscriptAssistantTurn;

export function isTranscriptUserPrompt(entry: SessionEntry): boolean {
	return (
		(entry.type === "message" && entry.message.role === "user") ||
		(entry.type === "custom_message" && entry.customType === COLLAB_PROMPT_MESSAGE_TYPE)
	);
}

function entryContentText(entry: Extract<SessionEntry, { type: "custom_message" }>): string {
	if (typeof entry.content === "string") return entry.content;
	return entry.content
		.filter(block => block.type === "text")
		.map(block => (block.type === "text" ? block.text : ""))
		.join("\n");
}

function assistantText(message: AssistantMessage): string {
	return message.content
		.filter(block => block.type === "text" && block.text.length > 0)
		.map(block => (block.type === "text" ? block.text : ""))
		.join("\n\n");
}

function hasToolCall(message: AssistantMessage): boolean {
	return message.content.some(block => block.type === "toolCall");
}

function canBeFinalResponse(entry: AssistantEntry): boolean {
	const { message } = entry;
	if (message.stopReason === "toolUse" || hasToolCall(message)) return false;
	return (
		assistantText(message).length > 0 ||
		Boolean(message.errorMessage) ||
		message.stopReason === "error" ||
		message.stopReason === "aborted"
	);
}

function visibleAssistantProcess(entry: AssistantEntry, finalEntry: AssistantEntry | undefined): boolean {
	if (entry !== finalEntry && (entry.message.stopReason === "error" || entry.message.stopReason === "aborted")) {
		return true;
	}
	for (const block of entry.message.content) {
		switch (block.type) {
			case "thinking":
				if (block.thinking.length > 0) return true;
				break;
			case "redactedThinking":
				return true;
			case "toolCall":
				if (transcriptToolPresentation(block.name) !== "hidden") return true;
				break;
			case "text":
				if (entry !== finalEntry && block.text.length > 0) return true;
				break;
			default:
				break;
		}
	}
	return false;
}

function durationCandidate(entry: AssistantEntry, completedAt: number): number | undefined {
	const messageTimestamp = entry.message.timestamp;
	if (
		Number.isFinite(messageTimestamp) &&
		messageTimestamp <= completedAt &&
		completedAt - messageTimestamp <= MAX_WORK_DURATION_MS
	) {
		return messageTimestamp;
	}
	const persistedTimestamp = Date.parse(entry.timestamp);
	if (
		!Number.isNaN(persistedTimestamp) &&
		persistedTimestamp <= completedAt &&
		completedAt - persistedTimestamp <= MAX_WORK_DURATION_MS
	) {
		return persistedTimestamp;
	}
	return undefined;
}

function workDuration(
	assistantEntries: readonly AssistantEntry[],
	finalEntry: AssistantEntry | undefined,
): number | undefined {
	if (finalEntry === undefined) return undefined;
	const completedAt = Date.parse(finalEntry.timestamp);
	if (Number.isNaN(completedAt)) return undefined;
	let startedAt = completedAt;
	for (const entry of assistantEntries) {
		const candidate = durationCandidate(entry, completedAt);
		if (candidate !== undefined) startedAt = Math.min(startedAt, candidate);
	}
	return Math.round(completedAt - startedAt);
}

function finalizeTurn(
	id: string,
	assistantEntries: readonly AssistantEntry[],
	toolResultEntries: readonly ToolResultEntry[],
): TranscriptAssistantTurn {
	let finalEntry: AssistantEntry | undefined;
	for (let index = assistantEntries.length - 1; index >= 0; index--) {
		const candidate = assistantEntries[index];
		if (candidate !== undefined && canBeFinalResponse(candidate)) {
			finalEntry = candidate;
			break;
		}
	}
	const toolResults = new Map(toolResultEntries.map(entry => [entry.message.toolCallId, entry]));
	const hasProcess =
		assistantEntries.some(entry => visibleAssistantProcess(entry, finalEntry)) ||
		toolResultEntries.some(entry => transcriptToolPresentation(entry.message.toolName) !== "hidden");
	return {
		kind: "assistant-turn",
		id: `turn:${id}`,
		assistantEntries,
		toolResultEntries,
		toolResults,
		finalEntry,
		durationMs: workDuration(assistantEntries, finalEntry ?? assistantEntries.at(-1)),
		hasProcess,
	};
}

/**
 * Groups the durable journal by user turn. Assistant reasoning, narration,
 * plans, tool calls, and results stay in one process disclosure; only the
 * final assistant response remains outside it.
 */
export function projectTranscriptItems(entries: readonly SessionEntry[]): TranscriptItem[] {
	const items: TranscriptItem[] = [];
	let promptId: string | undefined;
	let turnId: string | undefined;
	let assistantEntries: AssistantEntry[] = [];
	let toolResultEntries: ToolResultEntry[] = [];

	const flushTurn = (): void => {
		if (assistantEntries.length === 0 && toolResultEntries.length === 0) return;
		items.push(
			finalizeTurn(
				turnId ?? promptId ?? assistantEntries[0]?.id ?? toolResultEntries[0]?.id ?? "orphan",
				assistantEntries,
				toolResultEntries,
			),
		);
		turnId = undefined;
		assistantEntries = [];
		toolResultEntries = [];
	};

	for (const entry of entries) {
		if (isTranscriptUserPrompt(entry)) {
			flushTurn();
			items.push({ kind: "entry", entry });
			promptId = entry.id;
			continue;
		}
		if (entry.type === "message") {
			if (entry.message.role === "assistant") {
				turnId ??= promptId ?? entry.id;
				assistantEntries.push(entry as AssistantEntry);
			} else if (entry.message.role === "toolResult") {
				turnId ??= promptId ?? entry.id;
				toolResultEntries.push(entry as ToolResultEntry);
			}
			// Developer messages are model context, not transcript rows.
			continue;
		}
		if (entry.type === "model_change" || entry.type === "thinking_level_change") continue;
		if (
			entry.type === "custom_message" &&
			(!entry.display || isSystemReminder(entry.customType, entryContentText(entry)))
		) {
			continue;
		}
		flushTurn();
		items.push({ kind: "entry", entry });
		promptId = undefined;
	}
	flushTurn();
	return items;
}
