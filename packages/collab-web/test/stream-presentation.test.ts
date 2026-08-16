import { describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-wire";
import { STREAM_BATCH_MAX_DELAY_MS, shouldFlushAssistantStreamBatch } from "../src/lib/stream-presentation";

function stream(type: "thinking" | "text", value: string): AssistantMessage {
	return {
		role: "assistant",
		content: [type === "thinking" ? { type, thinking: value } : { type, text: value }],
		model: "test/model",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
		stopReason: "stop",
		timestamp: 1,
	};
}

describe("assistant stream presentation batching", () => {
	it("holds incomplete token fragments instead of laying out every update", () => {
		expect(
			shouldFlushAssistantStreamBatch(stream("thinking", "正在分析"), stream("thinking", "正在分析代码"), 80),
		).toBe(false);
	});

	it("flushes complete sentences and paragraphs immediately", () => {
		expect(
			shouldFlushAssistantStreamBatch(stream("thinking", "正在分析"), stream("thinking", "正在分析这个问题。"), 80),
		).toBe(true);
		expect(shouldFlushAssistantStreamBatch(stream("text", "first"), stream("text", "first paragraph\n"), 80)).toBe(
			true,
		);
	});

	it("uses a bounded delay when the model emits no punctuation", () => {
		expect(
			shouldFlushAssistantStreamBatch(
				stream("thinking", "正在分析"),
				stream("thinking", "正在分析一段没有任何标点的连续内容"),
				STREAM_BATCH_MAX_DELAY_MS,
			),
		).toBe(true);
	});

	it("flushes structural transitions such as thinking to answer text", () => {
		expect(shouldFlushAssistantStreamBatch(stream("thinking", "done"), stream("text", "answer"), 10)).toBe(true);
	});
});
