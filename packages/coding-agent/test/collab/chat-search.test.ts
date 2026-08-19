import { describe, expect, it } from "bun:test";
import type { AssistantMessage, UserMessage } from "@oh-my-pi/pi-ai";
import { COLLAB_PROMPT_MESSAGE_TYPE } from "@oh-my-pi/pi-wire";
import { searchChatEntries } from "../../src/collab/chat-search";
import type { SessionEntry } from "../../src/session/session-entries";

function user(id: string, text: string, timestamp = "2026-08-18T12:00:00.000Z"): SessionEntry {
	const message: UserMessage = { role: "user", content: text, timestamp: Date.parse(timestamp) };
	return { type: "message", id, parentId: null, timestamp, message };
}

function assistant(
	id: string,
	text: string,
	stopReason: AssistantMessage["stopReason"] = "stop",
	timestamp = "2026-08-18T12:01:00.000Z",
): SessionEntry {
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "test",
		model: "test/model",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.parse(timestamp),
	};
	return { type: "message", id, parentId: null, timestamp, message };
}

describe("chat history search", () => {
	it("searches final user/assistant bubbles newest-first and excludes tool-use process text", () => {
		const entries: SessionEntry[] = [
			user("u1", "请部署测试环境"),
			assistant("work", "正在部署测试环境", "toolUse"),
			assistant("a1", "测试环境已经部署完成"),
		];
		const response = searchChatEntries(entries, { query: "测试环境", kind: "all", role: "all", limit: 20 });
		expect(response.results.map(result => result.entryId)).toEqual(["a1", "u1"]);
		expect(response.results.every(result => result.rowId === result.entryId)).toBe(true);
	});

	it("classifies referenced files, images, and links without loading their contents", () => {
		const entries: SessionEntry[] = [
			{
				type: "custom_message",
				id: "prompt",
				parentId: null,
				timestamp: "2026-08-18T12:00:00.000Z",
				customType: COLLAB_PROMPT_MESSAGE_TYPE,
				content: "报告在 https://example.com/report",
				display: true,
				details: {
					from: "tester",
					localFiles: [
						{ kind: "local-file", path: "C:\\work\\screen.png", name: "screen.png" },
						{ kind: "local-file", path: "C:\\work\\report.docx", name: "report.docx" },
					],
				},
			},
		];
		expect(searchChatEntries(entries, { query: "", kind: "image", role: "all", limit: 20 }).results[0]?.snippet).toBe(
			"screen.png",
		);
		expect(
			searchChatEntries(entries, { query: "report", kind: "file", role: "all", limit: 20 }).results[0]?.snippet,
		).toBe("report.docx");
		expect(
			searchChatEntries(entries, { query: "example", kind: "link", role: "all", limit: 20 }).results[0]?.kind,
		).toBe("link");
	});

	it("includes image-only and file-only messages in the unfiltered All view", () => {
		const imageMessage: UserMessage = {
			role: "user",
			content: [{ type: "image", data: "dGVzdA==", mimeType: "image/png" }],
			timestamp: Date.parse("2026-08-18T12:00:00.000Z"),
		};
		const entries: SessionEntry[] = [
			{ type: "message", id: "image", parentId: null, timestamp: "2026-08-18T12:00:00.000Z", message: imageMessage },
			{
				type: "custom_message",
				id: "file",
				parentId: null,
				timestamp: "2026-08-18T12:01:00.000Z",
				customType: COLLAB_PROMPT_MESSAGE_TYPE,
				content: "",
				display: true,
				details: {
					from: "tester",
					localFiles: [{ kind: "local-file", path: "C:\\work\\report.docx", name: "report.docx" }],
				},
			},
		];

		const response = searchChatEntries(entries, { query: "", kind: "all", role: "all", limit: 20 });

		expect(response.results.map(result => [result.entryId, result.kind])).toEqual([
			["file", "file"],
			["image", "image"],
		]);
	});

	it("applies role/date filters and reports truncation", () => {
		const entries = [user("u1", "alpha"), assistant("a1", "alpha"), assistant("a2", "alpha")];
		const response = searchChatEntries(entries, {
			query: "alpha",
			kind: "text",
			role: "assistant",
			date: "2026-08-18",
			limit: 1,
		});
		expect(response.results).toHaveLength(1);
		expect(response.total).toBe(2);
		expect(response.truncated).toBe(true);
	});
});
