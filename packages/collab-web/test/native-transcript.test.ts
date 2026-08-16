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
		expect(projected[1]?.text).toBe("我来检查。");
		expect(projected[1]?.text).not.toContain("inspect_image");
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

	it("separates completed reasoning into a collapsed expandable native row", () => {
		const completedAt = "2026-08-16T00:00:00Z";
		const message: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "需要保留但默认隐藏的详细思考" },
				{ type: "thinking", thinking: "连续的思考片段应合并到同一个折叠项" },
				{ type: "text", text: "这是最终回答。" },
			],
			model: "test/model",
			usage: usage(),
			stopReason: "stop",
			timestamp: Date.parse(completedAt) - 539_000,
		};
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "assistant-with-reasoning",
				parentId: null,
				timestamp: completedAt,
				message,
			},
		];

		const projected = projectNativeTranscript(entries);
		expect(projected).toHaveLength(2);
		expect(projected[0]).toMatchObject({
			id: "assistant-with-reasoning:reasoning",
			kind: "reasoning",
			flags: 2,
			estimatedHeight: 42,
			durationMs: 539_000,
		});
		expect(projected[0]?.text).toContain("需要保留但默认隐藏的详细思考");
		expect(projected[0]?.text).toContain("连续的思考片段应合并到同一个折叠项");
		expect(projected[1]).toMatchObject({
			id: "assistant-with-reasoning",
			kind: "assistant",
			text: "这是最终回答。",
		});

		const completedTail = projectNativeStream(message, true, false, "session-1");
		expect(completedTail?.text).toContain("思考过程（已折叠）");
		expect(completedTail?.text).not.toContain("需要保留但默认隐藏的详细思考");
		expect(completedTail?.text).toContain("这是最终回答。");
	});

	it("hides system reminders, summarizes plans, and collapses real operations", () => {
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "reminder",
				parentId: null,
				timestamp: "2026-08-16T00:00:00Z",
				message: {
					role: "developer",
					content: "<system-reminder>Continue all incomplete tasks.</system-reminder>",
					timestamp: 1,
				},
			},
			{
				type: "message",
				id: "tool-calls",
				parentId: "reminder",
				timestamp: "2026-08-16T00:00:01Z",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "todo-call", name: "todo", arguments: { op: "view" } },
						{ type: "toolCall", id: "bash-call", name: "bash", arguments: { command: "bun test" } },
						{ type: "toolCall", id: "goal-call", name: "goal", arguments: {} },
					],
					model: "test/model",
					usage: usage(),
					stopReason: "toolUse",
					timestamp: 2,
				},
			},
			{
				type: "message",
				id: "todo-result",
				parentId: "tool-calls",
				timestamp: "2026-08-16T00:00:02Z",
				message: {
					role: "toolResult",
					toolCallId: "todo-call",
					toolName: "todo",
					content: [{ type: "text", text: "Remaining items (2): a very verbose raw result" }],
					details: {
						phases: [
							{
								name: "Implementation",
								tasks: [
									{ content: "隐藏系统提醒", status: "completed" },
									{ content: "折叠命令操作", status: "in_progress" },
									{ content: "运行回归测试", status: "pending" },
								],
							},
						],
					},
					isError: false,
					timestamp: 3,
				},
			},
			{
				type: "message",
				id: "bash-result",
				parentId: "todo-result",
				timestamp: "2026-08-16T00:00:03Z",
				message: {
					role: "toolResult",
					toolCallId: "bash-call",
					toolName: "bash",
					content: [{ type: "text", text: "18 pass\n0 fail" }],
					isError: false,
					timestamp: 4,
				},
			},
			{
				type: "message",
				id: "goal-result",
				parentId: "bash-result",
				timestamp: "2026-08-16T00:00:04Z",
				message: {
					role: "toolResult",
					toolCallId: "goal-call",
					toolName: "goal",
					content: [{ type: "text", text: "internal workflow state" }],
					isError: false,
					timestamp: 5,
				},
			},
			{
				type: "model_change",
				id: "model-change",
				parentId: "goal-result",
				timestamp: "2026-08-16T00:00:05Z",
				model: "test/other-model",
			},
		];

		const projected = projectNativeTranscript(entries);
		expect(projected.map(item => item.id)).toEqual(["todo-result", "bash-result"]);
		expect(projected[0]).toMatchObject({ kind: "plan", text: "计划 · 1/3\n→ 折叠命令操作\n○ 下一步：运行回归测试" });
		expect(projected[0]?.text).not.toContain("Remaining items");
		expect(projected[1]).toMatchObject({ kind: "tool", flags: 2, estimatedHeight: 42 });
		expect(projected[1]?.text).toBe("已执行命令 · bun test\n\n18 pass\n0 fail");
	});

	it("uses compact plan and operation rows while tools are running", () => {
		const planStream: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "todo-call",
					name: "todo",
					arguments: { op: "init", list: [{ phase: "Work", items: ["First", "Second"] }] },
				},
			],
			model: "test/model",
			usage: usage(),
			stopReason: "toolUse",
			timestamp: 1,
		};
		const commandStream: AssistantMessage = {
			...planStream,
			content: [{ type: "toolCall", id: "bash-call", name: "bash", arguments: { command: "bun test" } }],
		};

		expect(projectNativeStream(planStream, false, true)).toMatchObject({
			kind: "plan",
			text: "计划 · 0/2\n→ First\n○ 下一步：Second",
			flags: 1,
		});
		expect(projectNativeStream(commandStream, false, true)).toMatchObject({
			kind: "tool",
			text: "已执行命令 · bun test",
			flags: 3,
			estimatedHeight: 42,
		});
	});
});
