import {
	type AssistantMessage,
	COLLAB_PROMPT_MESSAGE_TYPE,
	type ImageContent,
	type SessionEntry,
	type TextContent,
} from "@oh-my-pi/pi-wire";
import type { DesktopNativeTranscriptKind, DesktopNativeTranscriptRow } from "./desktop-bridge";

const MAX_ROW_TEXT = 256 * 1024;
const STREAM_PREFIX = "__omp_native_stream__:";

const NativeRowFlag = {
	Streaming: 1,
	Expandable: 2,
	Failed: 8,
} as const;

function boundedText(value: string): string {
	if (value.length <= MAX_ROW_TEXT) return value;
	return `${value.slice(0, MAX_ROW_TEXT)}\n\n[内容过长，原生视图已截断；可切换 Web 兼容视图查看完整内容]`;
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

function assistantText(message: AssistantMessage): string {
	const parts: string[] = [];
	for (const block of message.content) {
		switch (block.type) {
			case "text":
				if (block.text.length > 0) parts.push(block.text);
				break;
			case "thinking":
				if (block.thinking.length > 0) parts.push(`思考\n${block.thinking}`);
				break;
			case "redactedThinking":
				parts.push("[思考内容已由模型隐藏]");
				break;
			case "toolCall":
				parts.push(`工具 · ${block.name}${block.intent ? `\n${block.intent}` : ""}`);
				break;
			default:
				break;
		}
	}
	if (message.errorMessage) parts.push(message.errorMessage);
	return parts.join("\n\n") || "…";
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
): DesktopNativeTranscriptRow {
	const bounded = boundedText(text);
	return {
		id,
		kind,
		text: bounded,
		flags,
		estimatedHeight: estimatedHeight(bounded, kind) + mediaIds.length * 176,
		mediaIds,
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

/** Convert durable wire entries to the compact, renderer-independent native rows. */
export function projectNativeTranscript(entries: readonly SessionEntry[]): DesktopNativeTranscriptRow[] {
	const rows: DesktopNativeTranscriptRow[] = [];
	for (const entry of entries) {
		switch (entry.type) {
			case "message": {
				const message = entry.message;
				switch (message.role) {
					case "user":
						rows.push(row(entry.id, "user", contentText(message.content), 0, contentMediaIds(message.content)));
						break;
					case "assistant": {
						const failed = message.stopReason === "error" || message.stopReason === "aborted";
						rows.push(
							row(
								entry.id,
								failed ? "error" : "assistant",
								assistantText(message),
								failed ? NativeRowFlag.Failed : 0,
							),
						);
						break;
					}
					case "developer":
						rows.push(row(entry.id, "system", contentText(message.content), 0, contentMediaIds(message.content)));
						break;
					case "toolResult": {
						const output = contentText(message.content);
						rows.push(
							row(
								entry.id,
								message.isError ? "error" : "tool",
								`${message.toolName}${output ? `\n${output}` : ""}`,
								NativeRowFlag.Expandable | (message.isError ? NativeRowFlag.Failed : 0),
								contentMediaIds(message.content),
							),
						);
						break;
					}
					default:
						break;
				}
				break;
			}
			case "custom_message":
				if (entry.customType === COLLAB_PROMPT_MESSAGE_TYPE) {
					rows.push(row(entry.id, "user", customPromptText(entry), 0, contentMediaIds(entry.content)));
				} else if (entry.display) {
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
				rows.push(row(entry.id, "system", `模型 → ${entry.model}`));
				break;
			case "thinking_level_change":
				rows.push(row(entry.id, "system", `思考强度 → ${entry.thinkingLevel ?? "关闭"}`));
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
		return row(
			id,
			failed ? "error" : "assistant",
			assistantText(stream),
			(streamDone ? 0 : NativeRowFlag.Streaming) | (failed ? NativeRowFlag.Failed : 0),
		);
	}
	return working ? row(id, "assistant", "正在思考…", NativeRowFlag.Streaming) : null;
}
