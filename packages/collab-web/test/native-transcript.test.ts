import { describe, expect, it } from "bun:test";
import type { AssistantMessage, SessionEntry } from "@oh-my-pi/pi-wire";
import { nativeStreamRowId, projectNativeStream, projectNativeTranscript } from "../src/lib/native-transcript";

function usage(): AssistantMessage["usage"] {
	return { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { total: 0 } };
}

describe("native transcript projection", () => {
	it("keeps stable entry ids and excludes inline image bytes", () => {
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "user-1",
				parentId: null,
				timestamp: "2026-08-16T00:00:00Z",
				message: {
					role: "user",
					content: [
						{ type: "text", text: "看一下" },
						{ type: "image", mimeType: "image/png", data: "VERY-LARGE-BASE64", imageId: "sha256-image" },
					],
					timestamp: 1,
				},
			},
			{
				type: "message",
				id: "assistant-1",
				parentId: "user-1",
				timestamp: "2026-08-16T00:00:01Z",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "我来检查。" },
						{ type: "toolCall", id: "call-1", name: "inspect_image", arguments: {}, intent: "检查图片" },
					],
					model: "test/model",
					usage: usage(),
					stopReason: "toolUse",
					timestamp: 2,
				},
			},
		];

		const projected = projectNativeTranscript(entries);
		expect(projected.map(row => row.id)).toEqual(["user-1", "assistant-1"]);
		expect(projected[0]?.mediaIds).toEqual(["sha256-image"]);
		expect(projected[0]?.text).not.toContain("VERY-LARGE-BASE64");
		expect(projected[1]?.text).toContain("工具 · inspect_image");
	});

	it("projects compaction markers and a separately updatable stream tail", () => {
		const entries: SessionEntry[] = [
			{
				type: "compaction",
				id: "compact-1",
				parentId: null,
				timestamp: "2026-08-16T00:00:00Z",
				summary: "保留项目目标和未完成任务",
				shortSummary: "保留关键目标",
				firstKeptEntryId: "kept-1",
				tokensBefore: 1234,
			},
		];
		const stream: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "正在回复" }],
			model: "test/model",
			usage: usage(),
			stopReason: "stop",
			timestamp: 2,
		};

		expect(projectNativeTranscript(entries)[0]).toMatchObject({ id: "compact-1", kind: "compaction", flags: 2 });
		expect(projectNativeStream(stream, false, true, "session-1")).toMatchObject({
			id: nativeStreamRowId("session-1"),
			kind: "assistant",
			flags: 1,
			text: "正在回复",
		});
		expect(projectNativeStream(null, false, false, "session-1")).toBeNull();
	});
});
