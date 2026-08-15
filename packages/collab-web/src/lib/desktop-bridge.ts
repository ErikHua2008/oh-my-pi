export interface DesktopProject {
	path: string;
	name: string;
	current: boolean;
}

export interface DesktopSessionPreferences {
	pinnedSessions: readonly string[];
	sessionReadThrough: Readonly<Record<string, string>>;
}

export interface DesktopBridge {
	available: boolean;
	listProjects(): Promise<readonly DesktopProject[]>;
	openProject(): Promise<void>;
	switchProject(path: string): Promise<void>;
	renameProject(path: string, name: string): Promise<void>;
	revealPath(path: string): Promise<void>;
	loadSessionPreferences(): Promise<DesktopSessionPreferences | null>;
	saveSessionPreferences(preferences: DesktopSessionPreferences): Promise<void>;
}

interface ProjectListResponse {
	recent_projects: string[];
	last_project: string | null;
	current_project: string | null;
	project_names: Record<string, string>;
}

interface SessionPreferencesResponse {
	pinned_sessions: string[];
	session_read_through: Record<string, string>;
}

export type TauriInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

interface TauriWindow extends Window {
	__TAURI_INTERNALS__?: {
		invoke?: TauriInvoke;
	};
}

function getTauriInvoke(): TauriInvoke | null {
	if (typeof window === "undefined") return null;
	const invoke = (window as TauriWindow).__TAURI_INTERNALS__?.invoke;
	return typeof invoke === "function" ? invoke : null;
}

function comparablePath(path: string): string {
	const normalized = path.replaceAll("\\", "/").replace(/\/+$/, "");
	return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith("//") ? normalized.toLocaleLowerCase() : normalized;
}

function basename(path: string): string {
	const withoutTrailingSeparators = path.replace(/[\\/]+$/, "");
	return withoutTrailingSeparators.split(/[\\/]/).pop() || path;
}

function projectAlias(path: string, aliases: Readonly<Record<string, string>>): string | undefined {
	const target = comparablePath(path);
	for (const [aliasPath, name] of Object.entries(aliases)) {
		if (comparablePath(aliasPath) === target && name.trim().length > 0) return name;
	}
	return undefined;
}

function browserBridge(): DesktopBridge {
	return {
		available: false,
		async listProjects() {
			return [];
		},
		async openProject() {},
		async switchProject(_path: string) {},
		async renameProject(_path: string, _name: string) {},
		async revealPath(_path: string) {},
		async loadSessionPreferences() {
			return null;
		},
		async saveSessionPreferences(_preferences: DesktopSessionPreferences) {},
	};
}

function tauriBridge(invoke: TauriInvoke): DesktopBridge {
	let authorization: "unknown" | "authorized" | "denied" = "unknown";

	return {
		get available() {
			return authorization === "authorized";
		},
		async listProjects() {
			if (authorization === "denied") return [];
			try {
				const list = await invoke<ProjectListResponse>("project_list");
				authorization = "authorized";
				const current = list.current_project === null ? null : comparablePath(list.current_project);
				const aliases = list.project_names ?? {};
				const projects = list.recent_projects.map(path => ({
					path,
					name: projectAlias(path, aliases) ?? basename(path),
					current: current !== null && comparablePath(path) === current,
				}));
				if (list.current_project !== null && !projects.some(project => project.current)) {
					projects.unshift({
						path: list.current_project,
						name: projectAlias(list.current_project, aliases) ?? basename(list.current_project),
						current: true,
					});
				}
				return projects;
			} catch {
				authorization = "denied";
				return [];
			}
		},
		async openProject() {
			if (authorization !== "authorized") return;
			try {
				await invoke<void>("project_open");
			} catch (error) {
				authorization = "denied";
				throw error;
			}
		},
		async switchProject(path: string) {
			if (authorization !== "authorized") return;
			try {
				await invoke<void>("project_switch", { path });
			} catch (error) {
				authorization = "denied";
				throw error;
			}
		},
		async renameProject(path: string, name: string) {
			if (authorization !== "authorized") return;
			try {
				await invoke<void>("project_rename", { path, name });
			} catch (error) {
				authorization = "denied";
				throw error;
			}
		},
		async revealPath(path: string) {
			if (authorization !== "authorized") return;
			try {
				await invoke<void>("project_reveal", { path });
			} catch (error) {
				authorization = "denied";
				throw error;
			}
		},
		async loadSessionPreferences() {
			if (authorization !== "authorized") return null;
			try {
				const value = await invoke<SessionPreferencesResponse>("session_preferences");
				return {
					pinnedSessions: value.pinned_sessions ?? [],
					sessionReadThrough: value.session_read_through ?? {},
				};
			} catch (error) {
				authorization = "denied";
				throw error;
			}
		},
		async saveSessionPreferences(preferences: DesktopSessionPreferences) {
			if (authorization !== "authorized") return;
			try {
				await invoke<void>("session_preferences_update", {
					pinnedSessions: preferences.pinnedSessions,
					sessionReadThrough: preferences.sessionReadThrough,
				});
			} catch (error) {
				authorization = "denied";
				throw error;
			}
		},
	};
}

/** Copy text with the modern clipboard API, retaining a WebView-compatible fallback. */
export async function copyText(text: string): Promise<void> {
	if (navigator.clipboard?.writeText) {
		await navigator.clipboard.writeText(text);
		return;
	}
	const textarea = document.createElement("textarea");
	textarea.value = text;
	textarea.style.position = "fixed";
	textarea.style.opacity = "0";
	document.body.append(textarea);
	textarea.select();
	const copied = document.execCommand("copy");
	textarea.remove();
	if (!copied) throw new Error("clipboard copy was rejected");
}

/** Creates an isolated bridge so capability probing can be exercised without a Tauri runtime. */
export function createDesktopBridge(invoke: TauriInvoke | null = getTauriInvoke()): DesktopBridge {
	return invoke === null ? browserBridge() : tauriBridge(invoke);
}

export const desktopBridge: DesktopBridge = createDesktopBridge();
