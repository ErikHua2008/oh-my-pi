import { describe, expect, it } from "bun:test";
import type { AssistantMessage, SessionEntry } from "@oh-my-pi/pi-wire";
import { renderToStaticMarkup } from "react-dom/server";
import "./transcript-dom-shim";
import { Transcript } from "../src/components/transcript/Transcript";
import type { ActiveTool } from "../src/lib/client";

const TOOL_CALL_ID = "call-running-tool";
const TOOL_NAME = "probe_tool";

const RAW_ASSISTANT_TARGET = "stale-raw-assistant-target";
const ACTIVE_TOOL_TARGET = "effective-active-tool-target";

function assistantUsage(): AssistantMessage["usage"] {
	return { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { total: 0 } };
}

function committedAssistantToolCall(): SessionEntry {
	return {
		type: "message",
		id: "assistant-entry-1",
		parentId: null,
		timestamp: "2026-07-09T00:00:00Z",
		message: {
			role: "assistant",
			content: [
				{ type: "text", text: "I will run the tool." },
				{
					type: "toolCall",
					id: TOOL_CALL_ID,
					name: TOOL_NAME,
					arguments: { target: RAW_ASSISTANT_TARGET },
					intent: "Inspect fixture input",
				},
			],
			model: "test/model",
			usage: assistantUsage(),
			stopReason: "stop",
			timestamp: 1,
		},
	};
}

function activeTool(): ActiveTool {
	return {
		toolCallId: TOOL_CALL_ID,
		toolName: TOOL_NAME,
		args: { target: ACTIVE_TOOL_TARGET },
		intent: "Inspect fixture input",
		startedAt: 1,
	};
}

function renderTranscript(props: {
	entries?: readonly SessionEntry[];
	stream?: AssistantMessage | null;
	streamDone?: boolean;
	activeTools?: ReadonlyMap<string, ActiveTool>;
	working: boolean;
	onEditLastUserMessage?: (text: string) => void;
	historyRemaining?: number;
	historyLoading?: boolean;
}): string {
	return renderToStaticMarkup(
		<Transcript
			entries={props.entries ?? []}
			stream={props.stream ?? null}
			streamDone={props.streamDone ?? true}
			activeTools={props.activeTools ?? new Map()}
			working={props.working}
			onEditLastUserMessage={props.onEditLastUserMessage}
			historyRemaining={props.historyRemaining}
			historyLoading={props.historyLoading}
		/>,
	);
}

function countElements(html: string, selector: string): number {
	let count = 0;
	new HTMLRewriter()
		.on(selector, {
			element() {
				count++;
			},
		})
		.transform(html);
	return count;
}

function countOccurrences(text: string, needle: string): number {
	let count = 0;
	let start = 0;
	while (true) {
		const index = text.indexOf(needle, start);
		if (index === -1) return count;
		count++;
		start = index + needle.length;
	}
}

describe("Transcript live tool rendering", () => {
	it("renders one running card for a committed tool call using active args without the working shimmer", () => {
		const html = renderTranscript({
			entries: [committedAssistantToolCall()],
			activeTools: new Map([[TOOL_CALL_ID, activeTool()]]),
			working: true,
		});

		expect(countElements(html, ".tv-card")).toBe(1);
		expect(countElements(html, ".tr-assistant-bubble")).toBe(1);
		expect(countElements(html, ".tr-assistant-bubble .tv-card")).toBe(0);
		expect(countElements(html, ".tv-status-dots--run")).toBe(1);
		expect(countOccurrences(html, TOOL_NAME)).toBe(1);
		expect(html).not.toContain("thinking…");
		expect(html).toContain(ACTIVE_TOOL_TARGET);
		expect(html).not.toContain(RAW_ASSISTANT_TARGET);
	});

	it("keeps the working shimmer when no tool is active", () => {
		const html = renderTranscript({ working: true, activeTools: new Map() });

		expect(html).toContain("thinking…");
	});
});

describe("Transcript thinking disclosure", () => {
	const thinkingMessage: AssistantMessage = {
		role: "assistant",
		content: [{ type: "thinking", thinking: "private streamed reasoning" }],
		model: "test/model",
		usage: assistantUsage(),
		stopReason: "stop",
		timestamp: 1,
	};

	it("keeps live thinking open while it is arriving", () => {
		const html = renderTranscript({ working: true, stream: thinkingMessage, streamDone: false });

		expect(html).toContain('aria-expanded="true"');
		expect(html).toContain("private streamed reasoning");
	});

	it("renders completed thinking collapsed by default", () => {
		const completedAt = "2026-08-16T00:00:00Z";
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "completed-thinking",
				parentId: null,
				timestamp: completedAt,
				message: {
					...thinkingMessage,
					content: [
						{ type: "thinking", thinking: "first private reasoning segment" },
						{ type: "thinking", thinking: "second private reasoning segment" },
					],
					timestamp: Date.parse(completedAt) - 539_000,
				},
			},
		];
		const html = renderTranscript({ working: false, entries });

		expect(html).toContain('aria-expanded="false"');
		expect(html).toContain("Worked for 8m 59s");
		expect(countElements(html, ".tr-think")).toBe(1);
		expect(countElements(html, ".tr-assistant-bubble")).toBe(0);
		expect(html).not.toContain("private streamed reasoning");
	});
});

describe("Transcript message Markdown", () => {
	it("renders user and assistant text in distinct conversation bubbles", () => {
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "bubble-user",
				parentId: null,
				timestamp: "2026-08-16T00:00:00Z",
				message: { role: "user", content: "user bubble", timestamp: 1 },
			},
			{
				type: "message",
				id: "bubble-assistant",
				parentId: "bubble-user",
				timestamp: "2026-08-16T00:00:01Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "OMP bubble" }],
					model: "test/model",
					usage: assistantUsage(),
					stopReason: "stop",
					timestamp: 2,
				},
			},
		];

		const html = renderTranscript({ entries, working: false });

		expect(countElements(html, ".tr-user-bubble")).toBe(1);
		expect(countElements(html, ".tr-assistant-bubble")).toBe(1);
		expect(html).toContain("user bubble");
		expect(html).toContain("OMP bubble");
	});

	it("renders only a bounded tail for long conversations", () => {
		const entries: SessionEntry[] = Array.from({ length: 500 }, (_, index) => ({
			type: "message" as const,
			id: `user-${index}`,
			parentId: index === 0 ? null : `user-${index - 1}`,
			timestamp: "2026-07-15T14:24:00Z",
			message: { role: "user" as const, content: `prompt-${index}`, timestamp: index },
		}));

		const html = renderTranscript({ entries, working: false });

		expect(countElements(html, ".tr-row--user")).toBe(200);
		expect(html).toContain("prompt-499");
		expect(html).not.toContain("prompt-299");
		expect(html).toContain("200 earlier messages · 300 hidden");
	});

	it("reports older host-side pages without placing them in the initial WebView tree", () => {
		const entries = Array.from({ length: 200 }, (_, index): SessionEntry => ({
			type: "message",
			id: `tail-${index}`,
			parentId: null,
			timestamp: "2026-07-15T00:00:00Z",
			message: { role: "user", content: `tail prompt ${index}`, timestamp: index },
		}));

		const html = renderTranscript({ entries, working: false, historyRemaining: 9_800 });
		const loading = renderTranscript({ entries, working: false, historyRemaining: 9_800, historyLoading: true });

		expect(html).toContain("Load 200 earlier messages · 9800 hidden");
		expect(html).not.toContain("9800 earlier entries");
		expect(loading).toContain("Loading earlier messages…");
		expect(loading).toContain('disabled=""');
	});

	it("renders host strings and guest text blocks as Markdown", () => {
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "host-markdown",
				parentId: null,
				timestamp: "2026-07-15T00:00:00Z",
				message: {
					role: "user",
					content: "Use `381866285601915778`",
					timestamp: 1,
				},
			},
			{
				type: "custom_message",
				id: "guest-markdown",
				parentId: "host-markdown",
				timestamp: "2026-07-15T00:00:01Z",
				customType: "collab-prompt",
				content: [{ type: "text", text: "Guest uses **Markdown**" }],
				details: { from: "guest" },
				display: true,
			},
		];

		const html = renderTranscript({ entries, working: false });

		expect(countElements(html, ".tr-row--user .tr-md code")).toBe(1);
		expect(countElements(html, ".tr-row--user .tr-md strong")).toBe(1);
	});

	it("renders local-file metadata as lightweight chips while hiding the model-only reference block", () => {
		const path = "C:\\work\\large-video.mp4";
		const entries: SessionEntry[] = [
			{
				type: "custom_message",
				id: "local-file-ref",
				parentId: null,
				timestamp: "2026-07-15T00:00:00Z",
				customType: "collab-prompt",
				content: `Review this file\n\n<local_file_references>\n[${JSON.stringify(path)}]\n</local_file_references>`,
				details: {
					from: "desktop",
					displayText: "Review this file",
					localFiles: [{ kind: "local-file", path, name: "large-video.mp4" }],
				},
				display: true,
			},
		];

		const html = renderTranscript({ entries, working: false });

		expect(html).toContain("Review this file");
		expect(html).toContain("large-video.mp4");
		expect(html).toContain(`title="${path}"`);
		expect(html).not.toContain("local_file_references");
	});

	it("keeps referenced image base64 out of the initial transcript markup", () => {
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "image-ref",
				parentId: null,
				timestamp: "2026-07-15T00:00:00Z",
				message: {
					role: "user",
					content: [
						{
							type: "image",
							data: "",
							mimeType: "image/png",
							imageId: "b".repeat(64),
						},
					],
					timestamp: 1,
				},
			},
		];

		const html = renderTranscript({ entries, working: false });

		expect(html).toContain("tr-msg-image-placeholder");
		expect(html).not.toContain("data:image/png;base64");
	});

	it("shows time and copy actions for user prompts but edits only the final prompt", () => {
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "older-user",
				parentId: null,
				timestamp: "2026-07-15T14:24:00Z",
				message: { role: "user", content: "older prompt", timestamp: 1 },
			},
			{
				type: "message",
				id: "latest-user",
				parentId: "older-user",
				timestamp: "2026-07-15T14:25:00Z",
				message: { role: "user", content: "latest prompt", timestamp: 2 },
			},
		];

		const html = renderTranscript({ entries, working: false, onEditLastUserMessage: () => {} });

		expect(countElements(html, ".tr-message-time")).toBe(2);
		expect(countElements(html, 'button[title="copy message"]')).toBe(2);
		expect(countElements(html, 'button[title="edit and resend"]')).toBe(1);
	});

	it("treats the newest collab prompt as the editable final user prompt", () => {
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "imported-user",
				parentId: null,
				timestamp: "2026-07-15T14:24:00Z",
				message: { role: "user", content: "imported prompt", timestamp: 1 },
			},
			{
				type: "custom_message",
				id: "latest-collab-user",
				parentId: "imported-user",
				timestamp: "2026-07-15T14:25:00Z",
				customType: "collab-prompt",
				content: "latest shell prompt",
				details: { from: "guest" },
				display: true,
			},
		];

		const html = renderTranscript({ entries, working: false, onEditLastUserMessage: () => {} });
		const importedStart = html.indexOf("imported prompt");
		const latestStart = html.indexOf("latest shell prompt");
		const editButton = 'title="edit and resend"';

		expect(importedStart).toBeGreaterThanOrEqual(0);
		expect(latestStart).toBeGreaterThan(importedStart);
		expect(html.slice(importedStart, latestStart)).not.toContain(editButton);
		expect(html.slice(latestStart)).toContain(editButton);
		expect(countElements(html, ".tr-message-time")).toBe(2);
		expect(countElements(html, 'button[title="copy message"]')).toBe(2);
		expect(countElements(html, 'button[title="edit and resend"]')).toBe(1);
	});
});
