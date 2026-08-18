import { describe, expect, it } from "bun:test";
import { inspectForeignSessionImport } from "../src/session/foreign-session-import";
import type { SessionEntry } from "../src/session/session-entries";

function userEntry(id: string, parentId: string | null, timestamp: string, content: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp,
		message: { role: "user", content, timestamp: Date.parse(timestamp) },
	};
}

describe("foreign session import provenance", () => {
	it("recognizes legacy boundary markers from conversations imported before refresh support", () => {
		const entries: SessionEntry[] = [
			userEntry("codex-1", null, "2026-08-01T00:00:00.000Z", "Codex"),
			{
				type: "custom",
				customType: "foreign_session_import",
				data: { source: "codex", sourceId: "thread-1" },
				id: "legacy-marker",
				parentId: "codex-1",
				timestamp: "2026-08-01T00:00:01.000Z",
			},
			userEntry("omp-1", "legacy-marker", "2026-08-02T00:00:00.000Z", "OMP"),
		];

		const inspected = inspectForeignSessionImport(entries, "codex", "thread-1");
		expect(inspected.matched).toBe(true);
		expect(inspected.sourceEntries.map(entry => entry.id)).toEqual(["codex-1"]);
		expect(inspected.localEntries.map(entry => entry.id)).toEqual(["omp-1"]);
		expect(inspected.hasLocalConversation).toBe(true);
	});

	it("retains provenance after source and OMP entries have been interleaved by timestamp", () => {
		const entries: SessionEntry[] = [
			userEntry("codex-1", null, "2026-08-01T00:00:00.000Z", "Codex first"),
			userEntry("omp-1", "codex-1", "2026-08-02T00:00:00.000Z", "OMP"),
			userEntry("codex-2", "omp-1", "2026-08-03T00:00:00.000Z", "Codex later"),
			{
				type: "title_change",
				id: "source-title",
				parentId: "codex-2",
				timestamp: "2026-08-03T00:00:01.000Z",
				title: "Visible Codex title",
				source: "auto",
			},
			{
				type: "custom",
				customType: "foreign_session_import",
				data: {
					version: 2,
					source: "codex",
					sourceId: "thread-1",
					sourceExtraEntryIds: ["source-title"],
				},
				id: "v2-marker",
				parentId: "source-title",
				timestamp: "2026-08-04T00:00:00.000Z",
			},
		];

		const inspected = inspectForeignSessionImport(entries, "codex", "thread-1");
		expect(inspected.sourceEntries.map(entry => entry.id)).toEqual(["codex-1", "codex-2", "source-title"]);
		expect(inspected.localEntries.map(entry => entry.id)).toEqual(["omp-1"]);
		expect(inspected.localMessageCount).toBe(1);
	});
});
