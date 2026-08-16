import {
	type AssistantMessage,
	COLLAB_PROMPT_MESSAGE_TYPE,
	type ImageContent,
	type SessionEntry,
	type TextContent,
} from "@oh-my-pi/pi-wire";
import type {
	DesktopNativeTranscriptKind,
	DesktopNativeTranscriptProcessItem,
	DesktopNativeTranscriptRow,
} from "./desktop-bridge";
import {
	isSystemReminder,
	operationPresentation,
	planPresentationText,
	transcriptToolPresentation,
} from "./transcript-presentation";
import { projectTranscriptItems, type TranscriptAssistantTurn } from "./transcript-turns";

const MAX_ROW_TEXT = 256 * 1024;
const MAX_PROCESS_DETAIL = 64 * 1024;
const STREAM_PREFIX = "__omp_native_stream__:";

const NativeRowFlag = {
	Streaming: 1,
	Expandable: 2,
	Failed: 8,
} as const;

export interface NativeTranscriptProjectionOptions {
	readonly editableUserEntryId?: string;
}

function timeLabel(timestamp: string): string | undefined {
	const parsed = Date.parse(timestamp);
	if (Number.isNaN(parsed)) return undefined;
	return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hour12: false }).format(parsed);
}

function boundedText(value: string): string {
	if (value.length <= MAX_ROW_TEXT) return value;
	return `${value.slice(0, MAX_ROW_TEXT)}\n\n[内容过长，原生视图已截断；可切换 Web 兼容视图查看完整内容]`;
}

function boundedProcessDetail(value: string): string {
	if (value.length <= MAX_PROCESS_DETAIL) return value;
	return `${value.slice(0, MAX_PROCESS_DETAIL)}\n\n[详细内容过长，已截断]`;
}

function operationDetail(args: unknown, output: string): string {
	const parts: string[] = [];
	if (args !== undefined) {
		try {
			const encoded = JSON.stringify(args, null, 2);
			if (encoded !== undefined && encoded !== "{}") parts.push(`输入\n${encoded}`);
		} catch {
			parts.push("输入\n[参数无法显示]");
		}
	}
	if (output.length > 0) parts.push(`输出\n${output}`);
	return boundedProcessDetail(parts.join("\n\n") || "暂无详细输出");
}

function contentText(content: string | readonly (TextContent | ImageContent)[]): string {
	if (typeof content === "string") return content;
	return content
		.map(block => (block.type === "text" ? block.text : block.imageId ? "" : "[图片]"))
		.filter(text => text.length > 0)
		.join("\n");
}

function contentMediaIds(content: string | readonly (TextContent | ImageContent)[]): string[] {
	if (typeof content === "string") return [];
	const ids = new Set<string>();
	for (const block of content) {
		if (block.type === "image" && block.imageId && block.imageId.length <= 256) ids.add(block.imageId);
		if (ids.size === 8) break;
	}
	return [...ids];
}

function assistantResponseText(message: AssistantMessage): string {
	const parts: string[] = [];
	for (const block of message.content) {
		switch (block.type) {
			case "text":
				if (block.text.length > 0) parts.push(block.text);
				break;
			default:
				break;
		}
	}
	if (message.errorMessage) parts.push(message.errorMessage);
	return parts.join("\n\n");
}

function assistantStreamIsFinal(message: AssistantMessage): boolean {
	return (
		message.stopReason !== "toolUse" &&
		!message.content.some(block => block.type === "toolCall") &&
		(assistantResponseText(message).length > 0 ||
			Boolean(message.errorMessage) ||
			message.stopReason === "error" ||
			message.stopReason === "aborted")
	);
}

function assistantStreamProcessText(message: AssistantMessage): string {
	const parts: string[] = [];
	const final = assistantStreamIsFinal(message);
	for (const block of message.content) {
		switch (block.type) {
			case "thinking":
				if (block.thinking.length > 0) parts.push(block.thinking);
				break;
			case "redactedThinking":
				parts.push("[思考内容已由模型隐藏]");
				break;
			case "text":
				if (!final && block.text.length > 0) parts.push(block.text);
				break;
			case "toolCall": {
				const presentation = transcriptToolPresentation(block.name);
				if (presentation === "plan") parts.push(planPresentationText(undefined, block.arguments));
				else if (presentation === "operation") {
					parts.push(operationPresentation(block.name, block.arguments, false));
				}
				break;
			}
			default:
				break;
		}
	}
	if (!final && message.errorMessage) parts.push(message.errorMessage);
	return parts.join("\n\n");
}

function estimatedHeight(text: string, kind: DesktopNativeTranscriptKind): number {
	const explicitLines = Math.min(80, text.split("\n").length - 1);
	const wrappedLines = Math.min(80, Math.ceil(text.length / (kind === "user" ? 58 : 82)));
	return Math.max(52, Math.min(2_000, 45 + Math.max(1, explicitLines + wrappedLines) * 21));
}

function row(
	id: string,
	kind: DesktopNativeTranscriptKind,
	text: string,
	flags = 0,
	mediaIds: readonly string[] = [],
	durationMs?: number,
	processItems: readonly DesktopNativeTranscriptProcessItem[] = [],
	metadata: Pick<DesktopNativeTranscriptRow, "timeLabel" | "canEdit"> = {},
): DesktopNativeTranscriptRow {
	const bounded = boundedText(text);
	return {
		id,
		kind,
		text: bounded,
		flags,
		estimatedHeight:
			(kind === "reasoning" || kind === "tool") && (flags & NativeRowFlag.Expandable) !== 0
				? 42
				: estimatedHeight(bounded, kind) + mediaIds.length * 176,
		mediaIds,
		durationMs,
		processItems,
		...metadata,
	};
}

function customPromptText(entry: Extract<SessionEntry, { type: "custom_message" }>): string {
	const details = entry.details;
	if (details !== null && typeof details === "object") {
		const record = details as Record<string, unknown>;
		if (typeof record.displayText === "string") return record.displayText;
	}
	return contentText(entry.content);
}

function nativeTurnRows(turn: TranscriptAssistantTurn): DesktopNativeTranscriptRow[] {
	const rows: DesktopNativeTranscriptRow[] = [];
	const processParts: string[] = [];
	const processMediaIds = new Set<string>();
	const processItems: DesktopNativeTranscriptProcessItem[] = [];
	const calledToolIds = new Set<string>();
	let processFailed = false;

	const appendTool = (name: string, callId: string, args: unknown): void => {
		const presentation = transcriptToolPresentation(name);
		if (presentation === "hidden") return;
		calledToolIds.add(callId);
		const result = turn.toolResults.get(callId)?.message;
		if (result?.isError) processFailed = true;
		if (presentation === "plan") {
			const detail = planPresentationText(result?.details, args);
			processParts.push(detail);
			processItems.push({ id: callId, summary: detail.split("\n", 1)[0] ?? "计划", detail });
		} else {
			const output = result === undefined ? "" : contentText(result.content);
			const summary = operationPresentation(name, args, result?.isError ?? false);
			processParts.push(`${summary}${output ? `\n\n${output}` : ""}`);
			processItems.push({
				id: callId,
				summary,
				detail: operationDetail(args, output),
				failed: result?.isError === true,
			});
		}
		if (result !== undefined) {
			for (const mediaId of contentMediaIds(result.content)) {
				if (processMediaIds.size < 8) processMediaIds.add(mediaId);
			}
		}
	};

	for (const entry of turn.assistantEntries) {
		for (const [blockIndex, block] of entry.message.content.entries()) {
			switch (block.type) {
				case "thinking":
					if (block.thinking.length > 0) {
						processParts.push(block.thinking);
						processItems.push({
							id: `${entry.id}:thinking:${blockIndex}`,
							summary: "思考过程",
							detail: boundedProcessDetail(block.thinking),
						});
					}
					break;
				case "redactedThinking":
					processParts.push("思考内容已由模型隐藏");
					processItems.push({
						id: `${entry.id}:thinking:${blockIndex}`,
						summary: "思考过程",
						detail: "思考内容已由模型隐藏",
					});
					break;
				case "text":
					if (entry !== turn.finalEntry && block.text.length > 0) {
						processParts.push(block.text);
						processItems.push({
							id: `${entry.id}:note:${blockIndex}`,
							summary: "工作说明",
							detail: boundedProcessDetail(block.text),
						});
					}
					break;
				case "toolCall":
					appendTool(block.name, block.id, block.arguments);
					break;
				default:
					break;
			}
		}
		if (
			entry !== turn.finalEntry &&
			(entry.message.stopReason === "error" || entry.message.stopReason === "aborted")
		) {
			processFailed = true;
			const detail =
				entry.message.errorMessage ?? (entry.message.stopReason === "error" ? "操作过程出错" : "操作过程已中止");
			processParts.push(detail);
			processItems.push({ id: `${entry.id}:error`, summary: "操作过程出错", detail, failed: true });
		}
	}
	for (const entry of turn.toolResultEntries) {
		const { message } = entry;
		if (calledToolIds.has(message.toolCallId) || transcriptToolPresentation(message.toolName) === "hidden") continue;
		appendTool(message.toolName, message.toolCallId, undefined);
	}
	if (turn.hasProcess && processParts.length > 0) {
		rows.push(
			row(
				`${turn.id}:process`,
				"reasoning",
				processParts.join("\n\n"),
				NativeRowFlag.Expandable | (processFailed ? NativeRowFlag.Failed : 0),
				[...processMediaIds],
				turn.durationMs,
				processItems,
			),
		);
	}
	if (turn.finalEntry !== undefined) {
		const message = turn.finalEntry.message;
		const failed = message.stopReason === "error" || message.stopReason === "aborted";
		rows.push(
			row(
				turn.finalEntry.id,
				failed ? "error" : "assistant",
				assistantResponseText(message) || "…",
				failed ? NativeRowFlag.Failed : 0,
				[],
				undefined,
				[],
				{ timeLabel: timeLabel(turn.finalEntry.timestamp) },
			),
		);
	}
	return rows;
}

/** Convert durable wire entries to compact native rows grouped by user turn. */
export function projectNativeTranscript(
	entries: readonly SessionEntry[],
	options: NativeTranscriptProjectionOptions = {},
): DesktopNativeTranscriptRow[] {
	const rows: DesktopNativeTranscriptRow[] = [];
	for (const item of projectTranscriptItems(entries)) {
		if (item.kind === "assistant-turn") {
			rows.push(...nativeTurnRows(item));
			continue;
		}
		const { entry } = item;
		switch (entry.type) {
			case "message":
				if (entry.message.role === "user") {
					rows.push(
						row(
							entry.id,
							"user",
							contentText(entry.message.content),
							0,
							contentMediaIds(entry.message.content),
							undefined,
							[],
							{
								timeLabel: timeLabel(entry.timestamp),
								canEdit: entry.id === options.editableUserEntryId,
							},
						),
					);
				}
				break;
			case "custom_message":
				if (entry.customType === COLLAB_PROMPT_MESSAGE_TYPE) {
					rows.push(
						row(entry.id, "user", customPromptText(entry), 0, contentMediaIds(entry.content), undefined, [], {
							timeLabel: timeLabel(entry.timestamp),
							canEdit: entry.id === options.editableUserEntryId,
						}),
					);
				} else if (entry.display && !isSystemReminder(entry.customType, contentText(entry.content))) {
					rows.push(
						row(
							entry.id,
							"system",
							`${entry.customType}\n${contentText(entry.content)}`,
							0,
							contentMediaIds(entry.content),
						),
					);
				}
				break;
			case "compaction":
				rows.push(
					row(
						entry.id,
						"compaction",
						`上下文已压缩 · 压缩前 ${entry.tokensBefore.toLocaleString()} tokens\n${entry.shortSummary ?? entry.summary}`,
						NativeRowFlag.Expandable,
					),
				);
				break;
			case "branch_summary":
				rows.push(row(entry.id, "compaction", `分支摘要\n${entry.summary}`, NativeRowFlag.Expandable));
				break;
			case "model_change":
			case "thinking_level_change":
				break;
			default:
				break;
		}
	}
	return rows;
}

export function nativeStreamRowId(sessionId?: string | null): string {
	return `${STREAM_PREFIX}${sessionId ?? "current"}`;
}

/** Project only the mutable tail so token updates never resend committed history. */
export function projectNativeStream(
	stream: AssistantMessage | null,
	streamDone: boolean,
	working: boolean,
	sessionId?: string | null,
): DesktopNativeTranscriptRow | null {
	const id = nativeStreamRowId(sessionId);
	if (stream !== null) {
		const failed = streamDone && (stream.stopReason === "error" || stream.stopReason === "aborted");
		if (assistantStreamIsFinal(stream)) {
			if (!streamDone) {
				const process = assistantStreamProcessText(stream);
				return row(id, "reasoning", process || "正在处理…", NativeRowFlag.Streaming);
			}
			return row(
				id,
				failed ? "error" : "assistant",
				assistantResponseText(stream) || "…",
				failed ? NativeRowFlag.Failed : 0,
			);
		}
		const process = assistantStreamProcessText(stream);
		if (process.length === 0) return working ? row(id, "reasoning", "正在处理…", NativeRowFlag.Streaming) : null;
		return row(
			id,
			"reasoning",
			process,
			(streamDone ? NativeRowFlag.Expandable : NativeRowFlag.Streaming) | (failed ? NativeRowFlag.Failed : 0),
		);
	}
	return working ? row(id, "reasoning", "正在处理…", NativeRowFlag.Streaming) : null;
}
