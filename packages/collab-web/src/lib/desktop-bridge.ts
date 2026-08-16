export interface DesktopProject {
	path: string;
	name: string;
	current: boolean;
}

export interface DesktopSessionPreferences {
	pinnedSessions: readonly string[];
	sessionReadThrough: Readonly<Record<string, string>>;
}

export interface DesktopAttachmentStatus {
	path: string;
	available: boolean;
}

export type DesktopNativeTranscriptKind =
	| "user"
	| "assistant"
	| "reasoning"
	| "tool"
	| "system"
	| "compaction"
	| "error";

export interface DesktopNativeTranscriptRow {
	id: string;
	kind: DesktopNativeTranscriptKind;
	text: string;
	flags: number;
	estimatedHeight: number;
	mediaIds: readonly string[];
}

export interface DesktopNativeTranscriptImage {
	imageId: string;
	mimeType: string;
	data: string;
}

export interface DesktopNativeTranscriptSnapshot {
	sessionId: string | null;
	rows: readonly DesktopNativeTranscriptRow[];
	historyRemaining: number;
	historyLoading: boolean;
}

export interface DesktopNativeTranscriptViewport {
	x: number;
	y: number;
	width: number;
	height: number;
	theme: DesktopTheme;
}

export type DesktopTheme = "light" | "dark";

export type DesktopNativeTranscriptEvent =
	| "load-earlier"
	| "use-native"
	| "use-web"
	| { type: "image-needed"; imageId: string };

export type DesktopWindowAction =
	| "drag"
	| "minimize"
	| "toggle_maximize"
	| "close"
	| "exit"
	| "open_project"
	| "reload"
	| "toggle_native_transcript"
	| "undo"
	| "redo"
	| "cut"
	| "copy"
	| "paste"
	| "select_all"
	| "about";

export interface DesktopBridge {
	available: boolean;
	/** True while the native host supports, or has not yet rejected, local-file commands. */
	localFilesAvailable: boolean;
	/** Native virtual transcript is probed independently from project/file capabilities. */
	nativeTranscriptAvailable: boolean;
	/** Resize the native host to add or remove the docked Agent rail. */
	setAgentRailOpen(open: boolean): Promise<boolean>;
	/** Keep native HWND surfaces and DWM chrome aligned with the resolved Web theme. */
	setWindowTheme(theme: DesktopTheme): Promise<boolean>;
	/** Run native title-bar, application-menu, or window commands. */
	runWindowAction(action: DesktopWindowAction): Promise<boolean>;
	listProjects(): Promise<readonly DesktopProject[]>;
	openProject(): Promise<void>;
	switchProject(path: string): Promise<void>;
	renameProject(path: string, name: string): Promise<void>;
	revealPath(path: string): Promise<void>;
	pickAttachments(): Promise<readonly string[]>;
	checkAttachments(paths: readonly string[]): Promise<readonly DesktopAttachmentStatus[]>;
	loadSessionPreferences(): Promise<DesktopSessionPreferences | null>;
	saveSessionPreferences(preferences: DesktopSessionPreferences): Promise<void>;
	replaceNativeTranscript(snapshot: DesktopNativeTranscriptSnapshot): Promise<boolean>;
	upsertNativeTranscript(row: DesktopNativeTranscriptRow): Promise<boolean>;
	removeNativeTranscript(id: string): Promise<void>;
	setNativeTranscriptViewport(viewport: DesktopNativeTranscriptViewport): Promise<boolean>;
	provideNativeTranscriptImage(image: DesktopNativeTranscriptImage): Promise<boolean>;
	hideNativeTranscript(): Promise<void>;
	takeNativeTranscriptEvents(): Promise<readonly DesktopNativeTranscriptEvent[]>;
	subscribeNativeTranscriptEvents(handler: (event: DesktopNativeTranscriptEvent) => void): () => void;
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

const ATTACHMENT_STATUS_BATCH = 64;

export type TauriInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

interface TauriWindow extends Window {
	__OMP_CPP_SHELL__?: boolean;
	__TAURI_INTERNALS__?: {
		invoke?: TauriInvoke;
	};
	chrome?: {
		webview?: {
			addEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
			removeEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
		};
	};
}

export function isCppShellHost(): boolean {
	return typeof window !== "undefined" && (window as TauriWindow).__OMP_CPP_SHELL__ === true;
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
		localFilesAvailable: false,
		nativeTranscriptAvailable: false,
		async setAgentRailOpen(_open: boolean) {
			return false;
		},
		async setWindowTheme(_theme: DesktopTheme) {
			return false;
		},
		async runWindowAction(_action: DesktopWindowAction) {
			return false;
		},
		async listProjects() {
			return [];
		},
		async openProject() {},
		async switchProject(_path: string) {},
		async renameProject(_path: string, _name: string) {},
		async revealPath(_path: string) {},
		async pickAttachments() {
			return [];
		},
		async checkAttachments(_paths: readonly string[]) {
			return [];
		},
		async loadSessionPreferences() {
			return null;
		},
		async saveSessionPreferences(_preferences: DesktopSessionPreferences) {},
		async replaceNativeTranscript(_snapshot: DesktopNativeTranscriptSnapshot) {
			return false;
		},
		async upsertNativeTranscript(_row: DesktopNativeTranscriptRow) {
			return false;
		},
		async removeNativeTranscript(_id: string) {},
		async setNativeTranscriptViewport(_viewport: DesktopNativeTranscriptViewport) {
			return false;
		},
		async provideNativeTranscriptImage(_image: DesktopNativeTranscriptImage) {
			return false;
		},
		async hideNativeTranscript() {},
		async takeNativeTranscriptEvents() {
			return [];
		},
		subscribeNativeTranscriptEvents(_handler: (event: DesktopNativeTranscriptEvent) => void) {
			return () => {};
		},
	};
}

function tauriBridge(invoke: TauriInvoke): DesktopBridge {
	let authorization: "unknown" | "authorized" | "denied" = "unknown";
	let localFileAuthorization: "unknown" | "authorized" | "denied" = "unknown";
	let nativeTranscriptAuthorization: "unknown" | "authorized" | "denied" = "unknown";
	const invokeNative = async (command: string, args?: Record<string, unknown>): Promise<boolean> => {
		if (nativeTranscriptAuthorization === "denied") return false;
		try {
			await invoke<unknown>(command, args);
			nativeTranscriptAuthorization = "authorized";
			return true;
		} catch {
			nativeTranscriptAuthorization = "denied";
			return false;
		}
	};
	const invokeNativeEnabled = async (command: string, args?: Record<string, unknown>): Promise<boolean> => {
		if (nativeTranscriptAuthorization === "denied") return false;
		try {
			const value = await invoke<unknown>(command, args);
			nativeTranscriptAuthorization = "authorized";
			return value === null || typeof value !== "object" || (value as Record<string, unknown>).enabled !== false;
		} catch {
			nativeTranscriptAuthorization = "denied";
			return false;
		}
	};

	return {
		get available() {
			return authorization === "authorized";
		},
		get localFilesAvailable() {
			return localFileAuthorization !== "denied";
		},
		get nativeTranscriptAvailable() {
			return nativeTranscriptAuthorization !== "denied";
		},
		async setAgentRailOpen(open: boolean) {
			try {
				await invoke<unknown>("window_agent_rail", { open });
				return true;
			} catch {
				return false;
			}
		},
		async setWindowTheme(theme: DesktopTheme) {
			try {
				await invoke<unknown>("window_theme", { theme });
				return true;
			} catch {
				return false;
			}
		},
		async runWindowAction(action: DesktopWindowAction) {
			try {
				await invoke<unknown>("window_action", { action });
				return true;
			} catch {
				return false;
			}
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
		async pickAttachments() {
			if (localFileAuthorization === "denied") return [];
			try {
				const paths = await invoke<string[]>("attachment_pick");
				localFileAuthorization = "authorized";
				return paths;
			} catch (error) {
				localFileAuthorization = "denied";
				throw error;
			}
		},
		async checkAttachments(paths: readonly string[]) {
			if (localFileAuthorization === "denied" || paths.length === 0) return [];
			try {
				const statuses: DesktopAttachmentStatus[] = [];
				for (let offset = 0; offset < paths.length; offset += ATTACHMENT_STATUS_BATCH) {
					statuses.push(
						...(await invoke<DesktopAttachmentStatus[]>("attachment_status", {
							paths: paths.slice(offset, offset + ATTACHMENT_STATUS_BATCH),
						})),
					);
				}
				localFileAuthorization = "authorized";
				return statuses;
			} catch (error) {
				localFileAuthorization = "denied";
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
		async replaceNativeTranscript(snapshot: DesktopNativeTranscriptSnapshot) {
			return invokeNativeEnabled("native_transcript_replace", { snapshot });
		},
		async upsertNativeTranscript(row: DesktopNativeTranscriptRow) {
			return invokeNative("native_transcript_upsert", { row });
		},
		async removeNativeTranscript(id: string) {
			await invokeNative("native_transcript_remove", { id });
		},
		async setNativeTranscriptViewport(viewport: DesktopNativeTranscriptViewport) {
			return invokeNativeEnabled("native_transcript_viewport", { viewport });
		},
		async provideNativeTranscriptImage(image: DesktopNativeTranscriptImage) {
			return invokeNative("native_transcript_image", { image });
		},
		async hideNativeTranscript() {
			await invokeNative("native_transcript_hide");
		},
		async takeNativeTranscriptEvents() {
			if (nativeTranscriptAuthorization === "denied") return [];
			try {
				const events = await invoke<unknown>("native_transcript_take_events");
				nativeTranscriptAuthorization = "authorized";
				if (!Array.isArray(events)) return [];
				const filtered: DesktopNativeTranscriptEvent[] = [];
				for (const event of events) {
					if (event === "load-earlier") {
						filtered.push(event);
					} else if (
						event !== null &&
						typeof event === "object" &&
						(event as Record<string, unknown>).type === "image-needed" &&
						typeof (event as Record<string, unknown>).imageId === "string"
					) {
						filtered.push({
							type: "image-needed",
							imageId: (event as Record<string, unknown>).imageId as string,
						});
					}
				}
				return filtered;
			} catch {
				nativeTranscriptAuthorization = "denied";
				return [];
			}
		},
		subscribeNativeTranscriptEvents(handler: (event: DesktopNativeTranscriptEvent) => void) {
			if (typeof window === "undefined") return () => {};
			const webview = (window as TauriWindow).chrome?.webview;
			if (webview !== undefined) {
				const listener = (event: MessageEvent<unknown>): void => {
					const message = event.data;
					if (
						message !== null &&
						typeof message === "object" &&
						(message as Record<string, unknown>).channel === "omp-native-transcript-event" &&
						typeof (message as Record<string, unknown>).event === "string"
					) {
						const nativeEvent = (message as Record<string, unknown>).event;
						if (nativeEvent === "load-earlier" || nativeEvent === "use-native" || nativeEvent === "use-web") {
							handler(nativeEvent);
						} else if (
							nativeEvent === "image-needed" &&
							typeof (message as Record<string, unknown>).imageId === "string"
						) {
							handler({
								type: "image-needed",
								imageId: (message as Record<string, unknown>).imageId as string,
							});
						}
					}
				};
				webview.addEventListener("message", listener);
				return () => webview.removeEventListener("message", listener);
			}
			const listener = (event: Event): void => {
				const detail = (event as CustomEvent<unknown>).detail;
				if (detail === "load-earlier" || detail === "use-native" || detail === "use-web") handler(detail);
				if (detail !== null && typeof detail === "object") {
					const nativeEvent = (detail as Record<string, unknown>).event;
					if (nativeEvent === "load-earlier" || nativeEvent === "use-native" || nativeEvent === "use-web") {
						handler(nativeEvent);
					} else if (
						nativeEvent === "image-needed" &&
						typeof (detail as Record<string, unknown>).imageId === "string"
					) {
						handler({
							type: "image-needed",
							imageId: (detail as Record<string, unknown>).imageId as string,
						});
					}
				}
			};
			window.addEventListener("omp-native-transcript", listener);
			return () => window.removeEventListener("omp-native-transcript", listener);
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
