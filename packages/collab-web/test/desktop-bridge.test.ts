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
		expect(await desktopBridge.setNativeTranscriptOcclusions([{ x: 1, y: 2, width: 3, height: 4 }])).toBe(false);
		expect(await desktopBridge.listProjects()).toEqual([]);
		await expect(desktopBridge.openProject()).resolves.toBeUndefined();
		await expect(desktopBridge.switchProject("/work/project")).resolves.toBeUndefined();
		expect(await desktopBridge.openImportedSession("/work/project", "session-1")).toBe(false);
		expect(await desktopBridge.takePendingImportedSession()).toBeNull();
		await expect(desktopBridge.renameProject("/work/project", "Project")).resolves.toBeUndefined();
		await expect(desktopBridge.removeProject("/work/project")).resolves.toBeUndefined();
		await expect(desktopBridge.revealPath("/work/project")).resolves.toBeUndefined();
		expect(await desktopBridge.pickAttachments()).toEqual([]);
		expect(await desktopBridge.startScreenshot()).toBeNull();
		expect(desktopBridge.subscribeDroppedFiles(() => {})).toBeFunction();
		expect(await desktopBridge.checkAttachments(["/work/file.txt"])).toEqual([]);
		expect(await desktopBridge.loadSessionPreferences()).toBeNull();
		await expect(
			desktopBridge.saveSessionPreferences({ pinnedSessions: [], sessionReadThrough: {} }),
		).resolves.toBeUndefined();
		expect(await desktopBridge.loadModelVisibility()).toEqual({ showAllModels: true });
		await expect(desktopBridge.saveModelVisibility({ showAllModels: false })).resolves.toBeUndefined();
		expect(await desktopBridge.openGrimoireConfig("effective")).toBeNull();
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
		expect(
			await bridge.setNativeTranscriptViewport({
				x: 10,
				y: 20,
				width: 700,
				height: 500,
				theme: "light",
				dropEnabled: true,
			}),
		).toBe(true);
		expect(
			await bridge.setNativeTranscriptOcclusions([
				{ x: 20, y: 300, width: 260, height: 180 },
				{ x: 500, y: 40, width: 220, height: 90 },
			]),
		).toBe(true);
		expect(await bridge.setNativeTranscriptOcclusions([])).toBe(true);
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
		expect(calls[2]).toEqual({
			command: "native_transcript_viewport",
			args: {
				viewport: {
					x: 10,
					y: 20,
					width: 700,
					height: 500,
					theme: "light",
					dropEnabled: true,
				},
			},
		});
		expect(calls[3]).toEqual({
			command: "native_transcript_occlusion",
			args: {
				occlusions: [
					{ x: 20, y: 300, width: 260, height: 180 },
					{ x: 500, y: 40, width: 220, height: 90 },
				],
			},
		});
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
			dropEnabled: false,
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
	it("loads and persists the native shell model visibility setting", async () => {
		const calls: InvokeCall[] = [];
		const bridge = createDesktopBridge(async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
			calls.push({ command, args });
			return { show_all_models: true } as T;
		});

		expect(await bridge.loadModelVisibility()).toEqual({ showAllModels: true });
		await bridge.saveModelVisibility({ showAllModels: false });
		expect(calls).toEqual([
			{ command: "model_visibility", args: undefined },
			{ command: "model_visibility_update", args: { showAllModels: false } },
		]);
	});

	it("opens each native Grimoire config destination and returns the host path", async () => {
		const calls: InvokeCall[] = [];
		const bridge = createDesktopBridge(async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
			calls.push({ command, args });
			const target = args?.target;
			return { path: `C:\\config\\${String(target)}` } as T;
		});

		expect(await bridge.openGrimoireConfig("effective")).toBe("C:\\config\\effective");
		expect(await bridge.openGrimoireConfig("team")).toBe("C:\\config\\team");
		expect(await bridge.openGrimoireConfig("folder")).toBe("C:\\config\\folder");
		expect(calls).toEqual([
			{ command: "grimoire_config_open", args: { target: "effective" } },
			{ command: "grimoire_config_open", args: { target: "team" } },
			{ command: "grimoire_config_open", args: { target: "folder" } },
		]);
	});

	it("selects original file paths and batches native availability checks without copying bytes", async () => {
		const calls: InvokeCall[] = [];
		const invoke: TauriInvoke = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
			calls.push({ command, args });
			if (command === "attachment_pick") return ["C:\\work\\a.txt", "C:\\work\\b.png"] as T;
			if (command === "screenshot_start") {
				return {
					completed: true,
					clipboardWritten: true,
					mimeType: "image/png",
					name: "screenshot.png",
					data: "iVBORw==",
					width: 640,
					height: 480,
				} as T;
			}
			if (command === "attachment_status") {
				const paths = args?.paths as readonly string[];
				return paths.map(path => ({ path, available: !path.endsWith("64.txt") })) as T;
			}
			throw new Error(`unexpected command ${command}`);
		};
		const bridge = createDesktopBridge(invoke);

		expect(bridge.localFilesAvailable).toBe(true);
		expect(await bridge.pickAttachments("image")).toEqual(["C:\\work\\a.txt", "C:\\work\\b.png"]);
		expect(await bridge.startScreenshot()).toEqual({
			clipboardWritten: true,
			mimeType: "image/png",
			name: "screenshot.png",
			data: "iVBORw==",
			width: 640,
			height: 480,
		});
		const paths = Array.from({ length: 65 }, (_, index) => `C:\\work\\${index}.txt`);
		const statuses = await bridge.checkAttachments(paths);

		expect(statuses).toHaveLength(65);
		expect(statuses.at(-1)).toEqual({ path: "C:\\work\\64.txt", available: false });
		expect(calls.map(call => call.command)).toEqual([
			"attachment_pick",
			"screenshot_start",
			"attachment_status",
			"attachment_status",
		]);
		expect(calls[0]?.args).toEqual({ kind: "image" });
		expect(calls[2]?.args?.paths).toHaveLength(64);
		expect(calls[3]?.args?.paths).toHaveLength(1);
	});

	it("distinguishes a cancelled native capture from a malformed screenshot response", async () => {
		const cancelled = createDesktopBridge(async <T>(command: string): Promise<T> => {
			if (command === "screenshot_start") return { completed: false } as T;
			throw new Error(`unexpected command ${command}`);
		});
		expect(await cancelled.startScreenshot()).toBeNull();

		const malformed = createDesktopBridge(async <T>(command: string): Promise<T> => {
			if (command === "screenshot_start") return { completed: true, mimeType: "image/png", data: "" } as T;
			throw new Error(`unexpected command ${command}`);
		});
		await expect(malformed.startScreenshot()).rejects.toThrow("native screenshot response is invalid");
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

	it("keeps project controls available after a recoverable rename failure", async () => {
		const calls: InvokeCall[] = [];
		const bridge = createDesktopBridge(async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
			calls.push({ command, args });
			if (command === "project_list") {
				return {
					recent_projects: ["C:\\work\\project"],
					last_project: "C:\\work\\project",
					current_project: "C:\\work\\project",
					project_names: {},
				} as T;
			}
			if (command === "project_rename") throw new Error("saving the project name failed");
			throw new Error(`unexpected command ${command}`);
		});

		await bridge.listProjects();
		await expect(bridge.renameProject("C:\\work\\project", "New name")).rejects.toThrow("saving");
		expect(bridge.available).toBe(true);
		expect(await bridge.listProjects()).toHaveLength(1);
		expect(calls.map(call => call.command)).toEqual(["project_list", "project_rename", "project_list"]);
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
