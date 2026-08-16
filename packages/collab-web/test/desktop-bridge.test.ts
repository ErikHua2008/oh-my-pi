import { describe, expect, it } from "bun:test";
import { createDesktopBridge, desktopBridge, type TauriInvoke } from "../src/lib/desktop-bridge";

interface InvokeCall {
	command: string;
	args?: Record<string, unknown>;
}

function respondingInvoke(response: unknown, calls: InvokeCall[]): TauriInvoke {
	return async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
		calls.push({ command, args });
		return response as T;
	};
}

describe("DesktopBridge browser fallback", () => {
	it("imports without Tauri and exposes no desktop capability", async () => {
		expect(desktopBridge.available).toBe(false);
		expect(desktopBridge.localFilesAvailable).toBe(false);
		expect(desktopBridge.nativeTranscriptAvailable).toBe(false);
		expect(await desktopBridge.setAgentRailOpen(true)).toBe(false);
		expect(await desktopBridge.setWindowTheme("light")).toBe(false);
		expect(await desktopBridge.runWindowAction("minimize")).toBe(false);
		expect(await desktopBridge.setNativeTranscriptOcclusion({ x: 1, y: 2, width: 3, height: 4 })).toBe(false);
		expect(await desktopBridge.listProjects()).toEqual([]);
		await expect(desktopBridge.openProject()).resolves.toBeUndefined();
		await expect(desktopBridge.switchProject("/work/project")).resolves.toBeUndefined();
		expect(await desktopBridge.openImportedSession("/work/project", "session-1")).toBe(false);
		expect(await desktopBridge.takePendingImportedSession()).toBeNull();
		await expect(desktopBridge.renameProject("/work/project", "Project")).resolves.toBeUndefined();
		await expect(desktopBridge.removeProject("/work/project")).resolves.toBeUndefined();
		await expect(desktopBridge.revealPath("/work/project")).resolves.toBeUndefined();
		expect(await desktopBridge.pickAttachments()).toEqual([]);
		expect(await desktopBridge.checkAttachments(["/work/file.txt"])).toEqual([]);
		expect(await desktopBridge.loadSessionPreferences()).toBeNull();
		await expect(
			desktopBridge.saveSessionPreferences({ pinnedSessions: [], sessionReadThrough: {} }),
		).resolves.toBeUndefined();
	});
});

describe("DesktopBridge native transcript capability", () => {
	it("forwards native window layout and title-bar actions without changing other desktop capabilities", async () => {
		const calls: InvokeCall[] = [];
		const bridge = createDesktopBridge(respondingInvoke(null, calls));

		expect(await bridge.setAgentRailOpen(true)).toBe(true);
		expect(await bridge.setAgentRailOpen(false)).toBe(true);
		expect(await bridge.setWindowTheme("light")).toBe(true);
		expect(await bridge.runWindowAction("toggle_maximize")).toBe(true);
		expect(await bridge.runWindowAction("resize_bottom_right")).toBe(true);
		expect(calls).toEqual([
			{ command: "window_agent_rail", args: { open: true } },
			{ command: "window_agent_rail", args: { open: false } },
			{ command: "window_theme", args: { theme: "light" } },
			{ command: "window_action", args: { action: "toggle_maximize" } },
			{ command: "window_action", args: { action: "resize_bottom_right" } },
		]);
		expect(bridge.available).toBe(false);
	});

	it("probes transcript commands independently and keeps message rows as metadata", async () => {
		const calls: InvokeCall[] = [];
		const bridge = createDesktopBridge(async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
			calls.push({ command, args });
			return (
				command === "native_transcript_take_events"
					? [
							"load-earlier",
							{ type: "image-needed", imageId: "image-1" },
							{ type: "edit-message", rowId: "entry-1" },
							"unknown",
						]
					: null
			) as T;
		});
		const row = {
			id: "entry-1",
			kind: "assistant" as const,
			text: "hello",
			flags: 0,
			estimatedHeight: 64,
			mediaIds: [],
		};

		expect(bridge.nativeTranscriptAvailable).toBe(true);
		expect(
			await bridge.replaceNativeTranscript({
				sessionId: "session-1",
				rows: [row],
				historyRemaining: 0,
				historyLoading: false,
			}),
		).toBe(true);
		expect(await bridge.upsertNativeTranscript(row)).toBe(true);
		expect(await bridge.setNativeTranscriptViewport({ x: 10, y: 20, width: 700, height: 500, theme: "light" })).toBe(
			true,
		);
		expect(await bridge.setNativeTranscriptOcclusion({ x: 20, y: 300, width: 260, height: 180 })).toBe(true);
		expect(await bridge.setNativeTranscriptOcclusion(null)).toBe(true);
		await bridge.removeNativeTranscript("entry-1");
		await bridge.hideNativeTranscript();
		expect(await bridge.takeNativeTranscriptEvents()).toEqual([
			"load-earlier",
			{ type: "image-needed", imageId: "image-1" },
			{ type: "edit-message", rowId: "entry-1" },
		]);

		expect(calls.map(call => call.command)).toEqual([
			"native_transcript_replace",
			"native_transcript_upsert",
			"native_transcript_viewport",
			"native_transcript_occlusion",
			"native_transcript_occlusion",
			"native_transcript_remove",
			"native_transcript_hide",
			"native_transcript_take_events",
		]);
	});

	it("falls back to Web transcript after the native host rejects a command", async () => {
		const bridge = createDesktopBridge(async <T>(): Promise<T> => {
			throw new Error("unsupported desktop command");
		});
		const enabled = await bridge.setNativeTranscriptViewport({
			x: 0,
			y: 0,
			width: 100,
			height: 100,
			theme: "dark",
		});
		expect(enabled).toBe(false);
		expect(bridge.nativeTranscriptAvailable).toBe(false);
	});

	it("honors the host's Web compatibility mode without disabling native capability", async () => {
		const bridge = createDesktopBridge(async <T>(): Promise<T> => ({ enabled: false }) as T);
		const enabled = await bridge.replaceNativeTranscript({
			sessionId: "session-1",
			rows: [],
			historyRemaining: 0,
			historyLoading: false,
		});
		expect(enabled).toBe(false);
		expect(bridge.nativeTranscriptAvailable).toBe(true);
	});
});

describe("DesktopBridge Tauri capability probe", () => {
	it("selects original file paths and batches native availability checks without copying bytes", async () => {
		const calls: InvokeCall[] = [];
		const invoke: TauriInvoke = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
			calls.push({ command, args });
			if (command === "attachment_pick") return ["C:\\work\\a.txt", "C:\\work\\b.png"] as T;
			if (command === "attachment_status") {
				const paths = args?.paths as readonly string[];
				return paths.map(path => ({ path, available: !path.endsWith("64.txt") })) as T;
			}
			throw new Error(`unexpected command ${command}`);
		};
		const bridge = createDesktopBridge(invoke);

		expect(bridge.localFilesAvailable).toBe(true);
		expect(await bridge.pickAttachments()).toEqual(["C:\\work\\a.txt", "C:\\work\\b.png"]);
		const paths = Array.from({ length: 65 }, (_, index) => `C:\\work\\${index}.txt`);
		const statuses = await bridge.checkAttachments(paths);

		expect(statuses).toHaveLength(65);
		expect(statuses.at(-1)).toEqual({ path: "C:\\work\\64.txt", available: false });
		expect(calls.map(call => call.command)).toEqual(["attachment_pick", "attachment_status", "attachment_status"]);
		expect(calls[1]?.args?.paths).toHaveLength(64);
		expect(calls[2]?.args?.paths).toHaveLength(1);
	});

	it("disables only local-file commands when an older native host rejects them", async () => {
		const bridge = createDesktopBridge(async <T>(command: string): Promise<T> => {
			if (command === "project_list") {
				return { recent_projects: [], last_project: null, current_project: null, project_names: {} } as T;
			}
			throw new Error("unsupported desktop command");
		});

		await bridge.listProjects();
		expect(bridge.available).toBe(true);
		await expect(bridge.pickAttachments()).rejects.toThrow("unsupported desktop command");
		expect(bridge.localFilesAvailable).toBe(false);
		expect(bridge.available).toBe(true);
	});

	it("maps authorized projects and enables mutations only after project_list succeeds", async () => {
		const calls: InvokeCall[] = [];
		const bridge = createDesktopBridge(
			respondingInvoke(
				{
					recent_projects: ["C:\\Work\\Current\\", "/srv/other"],
					last_project: "/ignored/last-project",
					current_project: "c:/work/current",
					project_names: { "C:\\Work\\Current\\": "Renamed current" },
				},
				calls,
			),
		);

		expect(bridge.available).toBe(false);
		expect(await bridge.listProjects()).toEqual([
			{ path: "C:\\Work\\Current\\", name: "Renamed current", current: true },
			{ path: "/srv/other", name: "other", current: false },
		]);
		expect(bridge.available).toBe(true);

		await bridge.openProject();
		await bridge.switchProject("/srv/other");
		expect(await bridge.openImportedSession("/srv/imported", "session-imported")).toBe(false);
		expect(await bridge.takePendingImportedSession()).toBeNull();
		await bridge.renameProject("/srv/other", "Other repo");
		await bridge.removeProject("/srv/other");
		await bridge.revealPath("/srv/other");
		expect(await bridge.loadSessionPreferences()).toEqual({ pinnedSessions: [], sessionReadThrough: {} });
		await bridge.saveSessionPreferences({
			pinnedSessions: ["session-1"],
			sessionReadThrough: { "session-1": "2026-08-15T10:00:00.000Z" },
		});
		expect(calls).toEqual([
			{ command: "project_list", args: undefined },
			{ command: "project_open", args: undefined },
			{ command: "project_switch", args: { path: "/srv/other" } },
			{ command: "project_open_imported", args: { path: "/srv/imported", sessionId: "session-imported" } },
			{ command: "project_take_imported", args: undefined },
			{ command: "project_rename", args: { path: "/srv/other", name: "Other repo" } },
			{ command: "project_remove", args: { path: "/srv/other" } },
			{ command: "project_reveal", args: { path: "/srv/other" } },
			{ command: "session_preferences", args: undefined },
			{
				command: "session_preferences_update",
				args: {
					pinnedSessions: ["session-1"],
					sessionReadThrough: { "session-1": "2026-08-15T10:00:00.000Z" },
				},
			},
		]);
	});

	it("inserts the active project when it is absent from recent projects", async () => {
		const bridge = createDesktopBridge(
			respondingInvoke(
				{
					recent_projects: ["/work/older"],
					last_project: "/work/older",
					current_project: "/work/live/",
					project_names: {},
				},
				[],
			),
		);

		expect(await bridge.listProjects()).toEqual([
			{ path: "/work/live/", name: "live", current: true },
			{ path: "/work/older", name: "older", current: false },
		]);
	});

	it("falls back after a denied probe and never invokes project mutations", async () => {
		const calls: InvokeCall[] = [];
		const deniedInvoke: TauriInvoke = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
			calls.push({ command, args });
			throw new Error("command project_list not allowed by capability");
		};
		const bridge = createDesktopBridge(deniedInvoke);

		expect(await bridge.listProjects()).toEqual([]);
		expect(bridge.available).toBe(false);
		await expect(bridge.openProject()).resolves.toBeUndefined();
		await expect(bridge.switchProject("/work/project")).resolves.toBeUndefined();
		await expect(bridge.removeProject("/work/project")).resolves.toBeUndefined();
		expect(await bridge.listProjects()).toEqual([]);
		expect(calls).toEqual([{ command: "project_list", args: undefined }]);
	});

	it("disables later mutations when an authorized command is denied", async () => {
		const calls: InvokeCall[] = [];
		const invoke: TauriInvoke = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
			calls.push({ command, args });
			if (command === "project_list") {
				return { recent_projects: [], last_project: null, current_project: null, project_names: {} } as T;
			}
			throw new Error(`command ${command} not allowed by capability`);
		};
		const bridge = createDesktopBridge(invoke);

		await bridge.listProjects();
		expect(bridge.available).toBe(true);
		await expect(bridge.openProject()).rejects.toThrow("not allowed by capability");
		expect(bridge.available).toBe(false);
		await expect(bridge.switchProject("/work/project")).resolves.toBeUndefined();
		expect(calls.map(call => call.command)).toEqual(["project_list", "project_open"]);
	});
});
