import { describe, expect, it } from "bun:test";
import type { ForeignSessionSummary, SessionSummary } from "@oh-my-pi/pi-wire";
import { renderToStaticMarkup } from "react-dom/server";
import { CodexImportModal, groupCodexImportSessions } from "../src/components/sessions/CodexImportModal";
import {
	SessionsPanel,
	groupSessionsByProject,
	isSessionUnread,
	placeContextMenu,
	removePinnedSession,
	removeSessionReadThrough,
} from "../src/components/sessions/SessionsPanel";
import { ProjectRenameDialog } from "../src/components/sessions/ProjectRenameDialog";
import { ConfirmDialog } from "../src/components/shell/ConfirmDialog";
import { groupArchivedSessions, SettingsModal } from "../src/components/shell/SettingsModal";
import type { ControlSnapshot } from "../src/lib/control-client";

function session(id: string, cwd: string, modifiedAt: string, title = id): SessionSummary {
	return {
		id,
		title,
		cwd,
		createdAt: "2026-08-01T00:00:00.000Z",
		modifiedAt,
		messageCount: 0,
		status: "complete",
		running: false,
		streaming: false,
	};
}

function codexSession(
	id: string,
	cwd: string,
	modifiedAt: string,
	title: string,
	description?: string,
): ForeignSessionSummary {
	return {
		source: "codex",
		id,
		path: `C:\\codex\\${id}.jsonl`,
		cwd,
		title,
		description,
		archived: false,
		createdAt: "2026-08-01T00:00:00.000Z",
		modifiedAt,
	};
}

function snapshot(sessions: readonly SessionSummary[], readOnly = false): ControlSnapshot {
	return {
		phase: "live",
		endedReason: null,
		readOnly,
		sessions,
	};
}

function renderPanel(
	snap: ControlSnapshot,
	activeSessionId: string | null = null,
	pending = false,
	creating = false,
): string {
	return renderToStaticMarkup(
		<SessionsPanel
			snapshot={snap}
			activeSessionId={activeSessionId}
			pending={pending}
			creating={creating}
			onOpenSettings={() => {}}
			onOpenSession={() => {}}
			onNewSession={() => {}}
			onSelectProject={() => {}}
			onInitializeProject={() => {}}
			onListCodexSessions={async () => []}
			onImportCodexSession={async () => ({
				kind: "imported",
				session: { id: "omp", cwd: "/work", requiresProjectSwitch: false },
			})}
			onRenameSession={() => {}}
			onArchiveSession={async () => {}}
			onLeave={() => {}}
		/>,
	);
}

describe("SessionsPanel project grouping", () => {
	it("normalizes cwd separators, trailing slashes, and Windows path case", () => {
		const groups = groupSessionsByProject([
			session("windows-new", "C:\\Work\\Repo\\", "2026-08-10T12:00:00.000Z"),
			session("windows-old", "c:/work//repo/", "2026-08-09T12:00:00.000Z"),
			session("posix", "/srv/project///", "2026-08-08T12:00:00.000Z"),
		]);

		expect(groups).toHaveLength(2);
		expect(groups[0]?.path).toBe("C:/Work/Repo");
		expect(groups[0]?.sessions.map(item => item.id)).toEqual(["windows-new", "windows-old"]);
		expect(groups[1]?.path).toBe("/srv/project");
		expect(groups[1]?.sessions.map(item => item.id)).toEqual(["posix"]);
	});

	it("sorts sessions newest first and projects by their latest activity", () => {
		const groups = groupSessionsByProject([
			session("alpha-old", "/work/alpha", "2026-08-03T09:00:00.000Z"),
			session("beta", "/work/beta", "2026-08-04T09:00:00.000Z"),
			session("alpha-new", "/work/alpha", "2026-08-05T09:00:00.000Z"),
		]);

		expect(groups.map(group => group.name)).toEqual(["alpha", "beta"]);
		expect(groups[0]?.sessions.map(item => item.id)).toEqual(["alpha-new", "alpha-old"]);
		expect(groups[1]?.sessions.map(item => item.id)).toEqual(["beta"]);
	});

	it("keeps pinned sessions above newer unpinned sessions within a project", () => {
		const groups = groupSessionsByProject(
			[
				session("newest", "/work/alpha", "2026-08-05T09:00:00.000Z"),
				session("pinned", "/work/alpha", "2026-08-03T09:00:00.000Z"),
			],
			[],
			new Set(["pinned"]),
		);

		expect(groups[0]?.sessions.map(item => item.id)).toEqual(["pinned", "newest"]);
	});

	it("keeps cross-project sessions under their recorded project while another project is current", () => {
		const groups = groupSessionsByProject(
			[
				session("current-chat", "C:\\work\\current", "2026-08-04T09:00:00.000Z"),
				session("imported-chat", "C:\\work\\test", "2026-08-05T09:00:00.000Z", "Screen"),
			],
			[
				{ path: "C:\\work\\current", name: "current", current: true },
				{ path: "C:\\work\\test", name: "test", current: false },
			],
		);

		expect(groups.find(group => group.name === "current")?.sessions.map(item => item.id)).toEqual(["current-chat"]);
		expect(groups.find(group => group.name === "test")?.sessions.map(item => item.id)).toEqual(["imported-chat"]);
	});
});

describe("Codex import conversation matching", () => {
	it("groups visible Codex thread names under their original projects", () => {
		const groups = groupCodexImportSessions([
			codexSession("screen", "C:\\work\\test", "2026-08-03T00:00:00.000Z", "Screen", "Screenshot analysis"),
			codexSession("main", "C:\\work\\OMP", "2026-08-05T00:00:00.000Z", "main", "C++ shell work"),
			codexSession("gitlab", "c:/work/test/", "2026-08-04T00:00:00.000Z", "Gitlab126&127"),
		]);

		expect(groups.map(group => group.name)).toEqual(["OMP", "test"]);
		expect(groups[1]?.sessions.map(item => item.title)).toEqual(["Gitlab126&127", "Screen"]);
	});

	it("shows an explicit archived-chat control in the picker", () => {
		const html = renderToStaticMarkup(
			<CodexImportModal
				loadSessions={async () => []}
				onImport={async () => ({
					kind: "imported",
					session: { id: "omp", cwd: "C:\\work", requiresProjectSwitch: false },
				})}
				onClose={() => {}}
			/>,
		);

		expect(html).toContain("Current chats");
		expect(html).toContain("Archived chats");
		expect(html).toContain("Search chats or projects");
	});
});

describe("SessionsPanel session actions", () => {
	it("uses the Grimoire Router App name and both theme-aware cube marks", () => {
		const html = renderPanel(snapshot([]));

		expect(html).toContain("Grimoire Router App");
		expect(html).toContain("grimoire-cube-on-light.svg");
		expect(html).toContain("grimoire-cube-on-dark.svg");
		expect(html).not.toContain(">OMP<");
	});

	it("places the Codex import action directly after the new-session action", () => {
		const html = renderPanel(snapshot([]));
		const newSessionIndex = html.indexOf("New session");
		const importIndex = html.indexOf("Import Chat from Codex");

		expect(newSessionIndex).toBeGreaterThan(-1);
		expect(importIndex).toBeGreaterThan(newSessionIndex);
		expect(html).toContain(">Import Chat from Codex</span>");
	});

	it("keeps the new-session action visually stable while an existing session resumes", () => {
		const html = renderPanel(snapshot([]), null, true, false);
		const newSessionButton = html.match(
			/<button type="button" class="sh-sessions-action"[^>]*>.*?<span>New session<\/span><\/button>/,
		)?.[0];

		expect(newSessionButton).toBeDefined();
		expect(newSessionButton).not.toContain("disabled");
		expect(html).not.toContain("Starting session");
	});

	it("keeps context menus inside every viewport edge", () => {
		expect(placeContextMenu(900, 700, 220, 214, 960, 720)).toEqual({ x: 732, y: 498 });
		expect(placeContextMenu(-20, -10, 220, 214, 960, 720)).toEqual({ x: 8, y: 8 });
	});

	it("reports unread only after a known session advances beyond its read watermark", () => {
		const item = { ...session("chat", "/work/project", "2026-08-05T09:00:00.000Z"), messageCount: 2 };
		expect(isSessionUnread(item, {})).toBe(false);
		expect(isSessionUnread(item, { chat: "2026-08-04T09:00:00.000Z" })).toBe(true);
		expect(isSessionUnread(item, { chat: "2026-08-04T09:00:00.000Z" }, "chat")).toBe(false);
		expect(isSessionUnread(item, { chat: item.modifiedAt })).toBe(false);
	});

	it("removes archived sessions from pinned and read-through preferences", () => {
		const pinned = new Set(["keep", "deleted"]);
		const readThrough = {
			keep: "2026-08-04T09:00:00.000Z",
			deleted: "2026-08-05T09:00:00.000Z",
		};

		expect([...removePinnedSession(pinned, "deleted")]).toEqual(["keep"]);
		expect(removeSessionReadThrough(readThrough, "deleted")).toEqual({
			keep: "2026-08-04T09:00:00.000Z",
		});
		// Unknown ids are left alone; a failed Core archive never calls these helpers.
		expect(removePinnedSession(pinned, "missing")).toBe(pinned);
		expect(removeSessionReadThrough(readThrough, "missing")).toBe(readThrough);
	});

	it("maps activeSessionId to the active row's aria-current state", () => {
		const html = renderPanel(
			snapshot([
				session("other", "/work/project", "2026-08-05T09:00:00.000Z", "Other session"),
				session("active", "/work/project", "2026-08-04T09:00:00.000Z", "Active session"),
			]),
			"active",
		);

		expect(html).toContain('aria-current="page" title="Open Active session"');
		expect(html).not.toContain('aria-current="page" title="Open Other session"');
		expect(html).toContain('title="Rename session Active session"');
		expect(html).toContain('class="sh-sessions-archive" title="归档 Active session"');
		expect(html).not.toContain("删除 Active session");
	});

	it("uses the project label to expand or collapse instead of switching and restarting the core", () => {
		const html = renderPanel(
			snapshot([session("chat", "/work/test", "2026-08-05T09:00:00.000Z", "Screen")]),
		);

		expect(html).toContain('class="sh-project-label sh-project-toggle"');
		expect(html).toContain('title="Collapse test"');
		expect(html).not.toContain("Switching to test");
	});

	it("shows a compact new-chat action on each writable project row", () => {
		const html = renderPanel(
			snapshot([session("chat", "/work/test", "2026-08-05T09:00:00.000Z", "Screen")]),
		);

		expect(html).toContain('class="sh-project-new"');
		expect(html).toContain('title="在 test 中新建对话"');
	});

	it("uses a dedicated project display-name dialog instead of renaming the folder", () => {
		const html = renderToStaticMarkup(
			<ProjectRenameDialog
				name="旧名称"
				path="C:\work\folder"
				onSave={async () => {}}
				onCancel={() => {}}
			/>,
		);

		expect(html).toContain('role="dialog"');
		expect(html).toContain("重命名项目");
		expect(html).toContain("不会重命名或移动硬盘上的文件夹");
		expect(html).toContain('maxLength="120"');
		expect(html).toContain("C:\\work\\folder");
	});

	it("blocks inline archive while another session operation is pending", () => {
		const html = renderPanel(
			snapshot([session("chat", "/work/test", "2026-08-05T09:00:00.000Z", "Screen")]),
			null,
			true,
			false,
		);
		const archiveButton = html.match(/<button[^>]*class="sh-sessions-archive"[^>]*>/)?.[0];

		expect(archiveButton).toBeDefined();
		expect(archiveButton).toContain("disabled");
	});

	it("marks the explicitly selected project instead of the first or native current project", () => {
		const html = renderToStaticMarkup(
			<SessionsPanel
				snapshot={snapshot([
					session("first", "/work/first", "2026-08-05T09:00:00.000Z"),
					session("selected", "/work/selected", "2026-08-04T09:00:00.000Z"),
				])}
				selectedProjectPath="/work/selected"
				onOpenSettings={() => {}}
				onOpenSession={() => {}}
				onNewSession={() => {}}
				onSelectProject={() => {}}
				onInitializeProject={() => {}}
				onListCodexSessions={async () => []}
				onImportCodexSession={async () => ({
					kind: "imported",
					session: { id: "omp", cwd: "/work", requiresProjectSwitch: false },
				})}
				onRenameSession={() => {}}
				onArchiveSession={async () => {}}
				onLeave={() => {}}
			/>,
		);

		expect(html).toMatch(/data-selected="true"[\s\S]*?>selected<\/span>/);
		expect(html).not.toMatch(/data-selected="true"[\s\S]*?>first<\/span>/);
	});

	it("renders read-only session rows without resume, create, or archive controls", () => {
		const html = renderPanel(
			snapshot([session("readonly", "/work/project", "2026-08-05T09:00:00.000Z", "Read only session")], true),
			"readonly",
		);

		expect(html).toContain('<div class="sh-sessions-item-open" title="Read only session">');
		expect(html).not.toContain('title="Open Read only session"');
		expect(html).not.toContain("Resume");
		expect(html).not.toContain("New session");
		expect(html).not.toContain("Import Chat from Codex");
		expect(html).not.toContain("归档 Read only session");
		expect(html).not.toContain("Rename session Read only session");
		expect(html).not.toContain('class="sh-project-new"');
	});
});

describe("Settings archived chats", () => {
	it("shows the Codex-style archived chats destination when a control client is available", () => {
		const html = renderToStaticMarkup(
			<SettingsModal
				onClose={() => {}}
				loadArchivedSessions={async () => []}
				onRestoreArchivedSession={async () => {}}
			/>,
		);

		expect(html).toContain("Archived chats");
		expect(html).toContain('aria-controls="sh-settings-panel-archived"');
	});

	it("groups archived chats under their original project and keeps newest chats first", () => {
		const groups = groupArchivedSessions([
			session("old", "C:\\work\\project", "2026-08-01T00:00:00.000Z", "Old chat"),
			session("new", "C:\\work\\project", "2026-08-03T00:00:00.000Z", "New chat"),
			session("other", "C:\\work\\other", "2026-08-02T00:00:00.000Z", "Other chat"),
		]);

		expect(groups.map(group => group.name)).toEqual(["project", "other"]);
		expect(groups[0]?.sessions.map(item => item.id)).toEqual(["new", "old"]);
	});
});

describe("Session action confirmation", () => {
	it("renders a modal archive warning with cancel before the reversible action", () => {
		const html = renderToStaticMarkup(
			<ConfirmDialog
				title="归档这个对话？"
				description={<>之后仍可恢复。</>}
				confirmLabel="归档"
				onCancel={() => {}}
				onConfirm={() => {}}
			/>,
		);

		expect(html).toContain('role="alertdialog"');
		expect(html).toContain('aria-modal="true"');
		expect(html).toContain("归档这个对话？");
		expect(html).toContain("之后仍可恢复。");
		expect(html.indexOf(">取消</button>")).toBeLessThan(html.indexOf(">归档</button>"));
		expect(html).not.toContain('class="is-danger"');
	});

	it("renders permanent deletion as an explicit destructive confirmation", () => {
		const html = renderToStaticMarkup(
			<ConfirmDialog
				title="彻底删除这个对话？"
				description={<>此操作无法撤销。</>}
				confirmLabel="彻底删除"
				danger
				onCancel={() => {}}
				onConfirm={() => {}}
			/>,
		);

		expect(html).toContain("彻底删除这个对话？");
		expect(html).toContain("此操作无法撤销。");
		expect(html).toContain('class="is-danger"');
	});
});
