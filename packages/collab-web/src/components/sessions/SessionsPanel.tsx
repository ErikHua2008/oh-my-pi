import type { ForeignSessionSummary, SessionSummary } from "@oh-my-pi/pi-wire";
import {
	Archive,
	Check,
	ChevronRight,
	Copy,
	Download,
	FolderOpen,
	LogOut,
	MailCheck,
	Pencil,
	Pin,
	PinOff,
	Plus,
	Settings,
	Trash2,
	X,
} from "lucide-react";
import { type FormEvent, type MouseEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ControlSnapshot } from "../../lib/control-client";
import { copyText, type DesktopProject, desktopBridge } from "../../lib/desktop-bridge";
import { relTime } from "../../lib/format";
import { useNativeTranscriptOcclusion } from "../shell/useNativeTranscriptOcclusion";
import { CodexImportModal } from "./CodexImportModal";

export interface SessionsPanelProps {
	snapshot: ControlSnapshot;
	activeSessionId?: string | null;
	pending?: boolean;
	creating?: boolean;
	onOpenSettings(): void;
	onOpenSession(id: string): void;
	onNewSession(): void;
	onListCodexSessions(archived?: boolean): Promise<readonly ForeignSessionSummary[]>;
	onImportCodexSession(session: ForeignSessionSummary): Promise<void>;
	onRenameSession(id: string, title: string): void;
	onDropSession(id: string): void;
	onArchiveSession(id: string): Promise<void>;
	onLeave(): void;
}

interface ProjectGroup {
	path: string;
	name: string;
	sessions: readonly SessionSummary[];
	modifiedMs: number;
	desktopProject: DesktopProject | undefined;
}

interface SessionContextMenu {
	id: string;
	title: string;
	cwd: string;
	pinned: boolean;
	unread: boolean;
	x: number;
	y: number;
}

interface ProjectContextMenu {
	key: string;
	path: string;
	name: string;
	current: boolean;
	x: number;
	y: number;
}

export function placeContextMenu(
	clientX: number,
	clientY: number,
	menuWidth: number,
	menuHeight: number,
	viewportWidth: number,
	viewportHeight: number,
): { x: number; y: number } {
	const margin = 8;
	return {
		x: Math.max(margin, Math.min(clientX, viewportWidth - menuWidth - margin)),
		y: Math.max(margin, Math.min(clientY, viewportHeight - menuHeight - margin)),
	};
}

const PINNED_SESSIONS_KEY = "omp.shell.pinned-sessions";
const SESSION_READ_THROUGH_KEY = "omp.shell.session-read-through";

function loadStringSet(key: string): ReadonlySet<string> {
	try {
		const value: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
		return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
	} catch {
		return new Set();
	}
}

function loadStringRecord(key: string): Readonly<Record<string, string>> {
	try {
		const value: unknown = JSON.parse(localStorage.getItem(key) ?? "{}");
		if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
		return Object.fromEntries(
			Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
		);
	} catch {
		return {};
	}
}

function persistPreference(key: string, value: unknown): void {
	try {
		localStorage.setItem(key, JSON.stringify(value));
	} catch {
		// Storage can be unavailable in private browsing; the in-memory preference still works.
	}
}

export function isSessionUnread(
	session: SessionSummary,
	readThrough: Readonly<Record<string, string>>,
	activeSessionId: string | null = null,
): boolean {
	const readAt = readThrough[session.id];
	return (
		activeSessionId !== session.id && session.messageCount > 0 && readAt !== undefined && session.modifiedAt > readAt
	);
}

/** Session title falls back to the basename of the working directory. */
function sessionTitle(s: SessionSummary): string {
	if (s.title && s.title.length > 0) return s.title;
	const base = s.cwd
		.split(/[\\/]+/)
		.filter(Boolean)
		.pop();
	return base && base.length > 0 ? base : s.cwd;
}

function sessionModifiedMs(s: SessionSummary): number {
	const t = Date.parse(s.modifiedAt);
	return Number.isFinite(t) ? t : 0;
}

/** Normalizes grouping keys without changing the path displayed to the user. */
function normalizeProjectPath(path: string): string {
	const slashPath = path.trim().replaceAll("\\", "/");
	const normalized = slashPath.startsWith("//")
		? `//${slashPath.slice(2).replace(/\/{2,}/g, "/")}`
		: slashPath.replace(/\/{2,}/g, "/");
	if (normalized === "/") return normalized;
	return normalized.replace(/\/+$/, "") || path.trim();
}

function comparableProjectPath(path: string): string {
	const normalized = normalizeProjectPath(path);
	return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith("//") ? normalized.toLocaleLowerCase() : normalized;
}

function projectName(path: string): string {
	const normalized = normalizeProjectPath(path);
	return normalized.split("/").filter(Boolean).pop() || normalized || "Workspace";
}

export function groupSessionsByProject(
	sessions: readonly SessionSummary[],
	desktopProjects: readonly DesktopProject[] = [],
	pinnedSessionIds: ReadonlySet<string> = new Set(),
): readonly ProjectGroup[] {
	const groups = new Map<string, { path: string; sessions: SessionSummary[] }>();
	for (const session of sessions) {
		const path = normalizeProjectPath(session.cwd);
		const key = comparableProjectPath(path);
		const group = groups.get(key);
		if (group) group.sessions.push(session);
		else groups.set(key, { path, sessions: [session] });
	}

	for (const project of desktopProjects) {
		const path = normalizeProjectPath(project.path);
		const key = comparableProjectPath(path);
		if (!groups.has(key)) {
			groups.set(key, { path: project.path, sessions: [] });
		}
	}

	return Array.from(groups.values())
		.map(group => {
			const sortedSessions = [...group.sessions].sort(
				(a, b) =>
					Number(pinnedSessionIds.has(b.id)) - Number(pinnedSessionIds.has(a.id)) ||
					sessionModifiedMs(b) - sessionModifiedMs(a),
			);
			const desktopProject = desktopProjects.find(
				project => comparableProjectPath(project.path) === comparableProjectPath(group.path),
			);
			const modifiedMs = sortedSessions[0] ? sessionModifiedMs(sortedSessions[0]) : 0;
			return {
				path: desktopProject?.path ?? group.path,
				name: desktopProject?.name || projectName(group.path),
				sessions: sortedSessions,
				modifiedMs,
				desktopProject,
			};
		})
		.sort(
			(a, b) =>
				Number(b.desktopProject?.current) - Number(a.desktopProject?.current) ||
				b.modifiedMs - a.modifiedMs ||
				a.name.localeCompare(b.name),
		);
}

function snapshotMessage(snapshot: ControlSnapshot): string {
	if (snapshot.phase === "ended")
		return snapshot.endedReason ? `Connection ended: ${snapshot.endedReason}` : "Connection ended.";
	if (snapshot.phase === "reconnecting") return "Reconnecting to sessions…";
	if (snapshot.phase === "connecting" || snapshot.phase === "waiting") return "Connecting to sessions…";
	return snapshot.readOnly ? "No sessions are available to view." : "No sessions yet. Start one above.";
}

function InlineRename({
	value,
	label,
	onSave,
	onCancel,
}: {
	value: string;
	label: string;
	onSave(value: string): Promise<void> | void;
	onCancel(): void;
}): ReactNode {
	const [draft, setDraft] = useState(value);
	const [saving, setSaving] = useState(false);
	const save = async (event: FormEvent): Promise<void> => {
		event.preventDefault();
		const name = draft.trim();
		if (!name || saving) return;
		setSaving(true);
		try {
			await onSave(name);
			onCancel();
		} catch {
			// The parent keeps the editor open and surfaces the operation error.
		} finally {
			setSaving(false);
		}
	};
	return (
		<form className="sh-inline-rename" onSubmit={event => void save(event)}>
			<input
				autoFocus
				aria-label={label}
				value={draft}
				disabled={saving}
				onChange={event => setDraft(event.currentTarget.value)}
				onKeyDown={event => {
					if (event.key === "Escape") {
						event.preventDefault();
						onCancel();
					}
				}}
			/>
			<button type="submit" disabled={saving || draft.trim().length === 0} title="Save name">
				<Check size={14} aria-hidden="true" />
			</button>
			<button type="button" disabled={saving} onClick={onCancel} title="Cancel rename">
				<X size={14} aria-hidden="true" />
			</button>
		</form>
	);
}

export function SessionsPanel({
	snapshot,
	activeSessionId = null,
	pending = false,
	creating = false,
	onOpenSettings,
	onOpenSession,
	onNewSession,
	onListCodexSessions,
	onImportCodexSession,
	onRenameSession,
	onDropSession,
	onArchiveSession,
	onLeave,
}: SessionsPanelProps): ReactNode {
	const { sessions, readOnly, phase } = snapshot;
	const [desktopProjects, setDesktopProjects] = useState<readonly DesktopProject[]>([]);
	const [desktopAvailable, setDesktopAvailable] = useState(false);
	const [collapsedProjects, setCollapsedProjects] = useState<ReadonlySet<string>>(() => new Set());
	const [desktopAction, setDesktopAction] = useState<string | null>(null);
	const [desktopError, setDesktopError] = useState<string | null>(null);
	const [renamingProject, setRenamingProject] = useState<string | null>(null);
	const [renamingSession, setRenamingSession] = useState<string | null>(null);
	const [sessionContextMenu, setSessionContextMenu] = useState<SessionContextMenu | null>(null);
	const [projectContextMenu, setProjectContextMenu] = useState<ProjectContextMenu | null>(null);
	const [codexImportOpen, setCodexImportOpen] = useState(false);
	const projectContextMenuRef = useRef<HTMLDivElement | null>(null);
	const sessionContextMenuRef = useRef<HTMLDivElement | null>(null);
	const [pinnedSessions, setPinnedSessions] = useState<ReadonlySet<string>>(() => loadStringSet(PINNED_SESSIONS_KEY));
	const [readThrough, setReadThrough] = useState<Readonly<Record<string, string>>>(() =>
		loadStringRecord(SESSION_READ_THROUGH_KEY),
	);
	const [desktopPreferencesReady, setDesktopPreferencesReady] = useState(false);
	useNativeTranscriptOcclusion(projectContextMenu !== null, projectContextMenuRef);
	useNativeTranscriptOcclusion(sessionContextMenu !== null, sessionContextMenuRef);

	useEffect(() => {
		let active = true;
		void desktopBridge
			.listProjects()
			.then(async projects => {
				if (!active) return;
				const available = desktopBridge.available;
				setDesktopAvailable(available);
				setDesktopProjects(available ? projects : []);
				if (available) {
					const preferences = await desktopBridge.loadSessionPreferences();
					if (!active) return;
					if (preferences) {
						setPinnedSessions(new Set(preferences.pinnedSessions));
						setReadThrough(preferences.sessionReadThrough);
					}
				}
				setDesktopPreferencesReady(true);
			})
			.catch(() => {
				if (active) {
					setDesktopAvailable(false);
					setDesktopProjects([]);
					setDesktopPreferencesReady(true);
				}
			});
		return () => {
			active = false;
		};
	}, []);

	useEffect(() => {
		const pinned = Array.from(pinnedSessions);
		persistPreference(PINNED_SESSIONS_KEY, pinned);
		persistPreference(SESSION_READ_THROUGH_KEY, readThrough);
		if (!desktopPreferencesReady) return;
		void desktopBridge
			.saveSessionPreferences({ pinnedSessions: pinned, sessionReadThrough: readThrough })
			.catch(() => setDesktopAvailable(false));
	}, [desktopPreferencesReady, pinnedSessions, readThrough]);

	useEffect(() => {
		setReadThrough(current => {
			let next: Record<string, string> | null = null;
			for (const session of sessions) {
				if (current[session.id] !== undefined && session.id !== activeSessionId) continue;
				if (current[session.id] === session.modifiedAt) continue;
				next ??= { ...current };
				next[session.id] = session.modifiedAt;
			}
			return next ?? current;
		});
	}, [activeSessionId, sessions]);

	useEffect(() => {
		if (sessionContextMenu === null && projectContextMenu === null) return;
		const dismiss = (): void => {
			setSessionContextMenu(null);
			setProjectContextMenu(null);
		};
		const dismissOnEscape = (event: globalThis.KeyboardEvent): void => {
			if (event.key === "Escape") dismiss();
		};
		document.addEventListener("pointerdown", dismiss);
		document.addEventListener("scroll", dismiss, true);
		window.addEventListener("resize", dismiss);
		document.addEventListener("keydown", dismissOnEscape);
		return () => {
			document.removeEventListener("pointerdown", dismiss);
			document.removeEventListener("scroll", dismiss, true);
			window.removeEventListener("resize", dismiss);
			document.removeEventListener("keydown", dismissOnEscape);
		};
	}, [projectContextMenu, sessionContextMenu]);

	const groups = useMemo(
		() => groupSessionsByProject(sessions, desktopAvailable ? desktopProjects : [], pinnedSessions),
		[desktopAvailable, desktopProjects, pinnedSessions, sessions],
	);
	const toggleProject = (path: string): void => {
		const key = comparableProjectPath(path);
		setCollapsedProjects(current => {
			const next = new Set(current);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	};
	const runDesktopAction = async (key: string, action: () => Promise<void>): Promise<void> => {
		setDesktopAction(key);
		setDesktopError(null);
		try {
			await action();
		} catch {
			if (!desktopBridge.available) {
				setDesktopAvailable(false);
				setDesktopProjects([]);
			}
			setDesktopError("The desktop project action could not be completed.");
		} finally {
			setDesktopAction(null);
		}
	};
	const renameProject = async (path: string, name: string): Promise<void> => {
		setDesktopAction(`rename:${path}`);
		setDesktopError(null);
		try {
			await desktopBridge.renameProject(path, name);
			setDesktopProjects(await desktopBridge.listProjects());
		} catch (error) {
			setDesktopAvailable(desktopBridge.available);
			setDesktopError("The project name could not be saved.");
			throw error;
		} finally {
			setDesktopAction(null);
		}
	};
	const removeProject = async (path: string): Promise<void> => {
		setDesktopAction(`remove:${path}`);
		setDesktopError(null);
		try {
			await desktopBridge.removeProject(path);
			setDesktopProjects(await desktopBridge.listProjects());
		} catch {
			setDesktopAvailable(desktopBridge.available);
			setDesktopError("The project could not be removed from the list.");
		} finally {
			setDesktopAction(null);
		}
	};
	const markSessionRead = (session: SessionSummary): void => {
		setReadThrough(current =>
			current[session.id] === session.modifiedAt ? current : { ...current, [session.id]: session.modifiedAt },
		);
	};
	const togglePinnedSession = (id: string): void => {
		setPinnedSessions(current => {
			const next = new Set(current);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};
	const openSessionContextMenu = (event: MouseEvent, session: SessionSummary): void => {
		if (readOnly) return;
		event.preventDefault();
		const position = placeContextMenu(event.clientX, event.clientY, 220, 255, window.innerWidth, window.innerHeight);
		setProjectContextMenu(null);
		setSessionContextMenu({
			id: session.id,
			title: sessionTitle(session),
			cwd: session.cwd,
			pinned: pinnedSessions.has(session.id),
			unread: isSessionUnread(session, readThrough, activeSessionId),
			...position,
		});
	};
	const openProjectContextMenu = (event: MouseEvent, group: ProjectGroup): void => {
		event.preventDefault();
		const position = placeContextMenu(event.clientX, event.clientY, 220, 214, window.innerWidth, window.innerHeight);
		setSessionContextMenu(null);
		setProjectContextMenu({
			key: comparableProjectPath(group.path),
			path: group.path,
			name: group.name,
			current: group.desktopProject?.current ?? groups.length === 1,
			...position,
		});
	};

	return (
		<nav className="sh-sessions" aria-label="Projects and sessions">
			<div className="sh-sessions-brand">
				<span className="sh-sessions-mark" aria-hidden="true">
					<img className="sh-sessions-mark-on-light" src="./public/grimoire-brain-on-light.svg" alt="" />
					<img className="sh-sessions-mark-on-dark" src="./public/grimoire-brain-on-dark.svg" alt="" />
				</span>
				<div className="sh-sessions-brand-copy">
					<span className="sh-sessions-brand-name">Grimoire Router App</span>
					<span className="sh-sessions-brand-status">
						<span className={`sh-sessions-dot sh-sessions-dot-${phase}`} aria-hidden="true" />
						{phase}
					</span>
				</div>
			</div>

			{(desktopAvailable || !readOnly) && (
				<div className="sh-sessions-primary-actions">
					{desktopAvailable && (
						<button
							type="button"
							className="sh-sessions-action"
							disabled={desktopAction !== null}
							onClick={() => void runDesktopAction("open", () => desktopBridge.openProject())}
						>
							<FolderOpen size={16} aria-hidden="true" />
							<span>{desktopAction === "open" ? "Opening project…" : "Open project"}</span>
						</button>
					)}
					{!readOnly && (
						<>
							<button type="button" className="sh-sessions-action" onClick={onNewSession} disabled={creating}>
								<Plus size={16} aria-hidden="true" />
								<span>{creating ? "Starting session…" : "New session"}</span>
							</button>
							<button
								type="button"
								className="sh-sessions-action"
								disabled={pending || phase !== "live"}
								onClick={() => setCodexImportOpen(true)}
							>
								<Download size={16} aria-hidden="true" />
								<span>Import Chat from Codex</span>
							</button>
						</>
					)}
				</div>
			)}
			{desktopError && (
				<p className="sh-sessions-project-error" role="status">
					{desktopError}
				</p>
			)}

			<div className="sh-sessions-projects">
				<div className="sh-sessions-section-title">Projects</div>

				{groups.map(group => {
					const key = comparableProjectPath(group.path);
					const collapsed = collapsedProjects.has(key);
					const sessionsId = `sh-project-${encodeURIComponent(key).replaceAll("%", "-")}`;
					return (
						<section className="sh-project" key={key}>
							<div
								className="sh-project-row"
								data-current={group.desktopProject?.current ? "true" : undefined}
								onContextMenu={event => openProjectContextMenu(event, group)}
							>
								<button
									type="button"
									className="sh-project-disclosure"
									aria-expanded={!collapsed}
									aria-controls={sessionsId}
									onClick={() => toggleProject(group.path)}
									title={collapsed ? `Expand ${group.name}` : `Collapse ${group.name}`}
								>
									<ChevronRight size={15} aria-hidden="true" />
								</button>
								{renamingProject === key ? (
									<InlineRename
										value={group.name}
										label={`Rename project ${group.name}`}
										onSave={name => renameProject(group.path, name)}
										onCancel={() => setRenamingProject(null)}
									/>
								) : (
									<button
										type="button"
										className="sh-project-label sh-project-toggle"
										aria-expanded={!collapsed}
										aria-controls={sessionsId}
										title={collapsed ? `Expand ${group.name}` : `Collapse ${group.name}`}
										onClick={() => toggleProject(group.path)}
									>
										<span className="sh-project-name">{group.name}</span>
										<span className="sh-project-path">{group.path}</span>
									</button>
								)}
								{desktopAvailable && !readOnly && renamingProject !== key && (
									<button
										type="button"
										className="sh-project-rename"
										title={`Rename project ${group.name}`}
										disabled={desktopAction !== null}
										onClick={() => setRenamingProject(key)}
									>
										<Pencil size={13} aria-hidden="true" />
									</button>
								)}
							</div>

							<div className="sh-sessions-list" id={sessionsId} hidden={collapsed}>
								{group.sessions.map(session => (
									<div
										className="sh-sessions-item"
										key={session.id}
										data-pinned={pinnedSessions.has(session.id) ? "true" : undefined}
										data-unread={isSessionUnread(session, readThrough, activeSessionId) ? "true" : undefined}
										onContextMenu={event => openSessionContextMenu(event, session)}
									>
										{renamingSession === session.id ? (
											<InlineRename
												value={sessionTitle(session)}
												label={`Rename session ${sessionTitle(session)}`}
												onSave={title => onRenameSession(session.id, title)}
												onCancel={() => setRenamingSession(null)}
											/>
										) : readOnly ? (
											<div className="sh-sessions-item-open" title={sessionTitle(session)}>
												<span className="sh-sessions-item-copy">
													{pinnedSessions.has(session.id) && (
														<Pin className="sh-sessions-pin" size={11} aria-hidden="true" />
													)}
													<span className="sh-sessions-item-title">{sessionTitle(session)}</span>
													<span className="sh-sessions-item-meta">
														{relTime(sessionModifiedMs(session))}
													</span>
												</span>
											</div>
										) : (
											<button
												type="button"
												className="sh-sessions-item-open"
												aria-current={session.id === activeSessionId ? "page" : undefined}
												title={`Open ${sessionTitle(session)}`}
												disabled={pending}
												onClick={() => {
													markSessionRead(session);
													onOpenSession(session.id);
												}}
											>
												<span className="sh-sessions-item-copy">
													{pinnedSessions.has(session.id) && (
														<Pin className="sh-sessions-pin" size={11} aria-hidden="true" />
													)}
													<span className="sh-sessions-item-title">{sessionTitle(session)}</span>
													<span className="sh-sessions-item-meta">
														{relTime(sessionModifiedMs(session))}
													</span>
												</span>
												<span
													className={`sh-sessions-state${session.streaming ? " sh-sessions-state-streaming" : session.status === "error" ? " sh-sessions-state-error" : ""}`}
													title={session.streaming ? "Streaming" : session.status}
													aria-label={session.streaming ? "Streaming" : session.status}
												/>
											</button>
										)}
										{!readOnly && renamingSession !== session.id && (
											<button
												type="button"
												className="sh-sessions-rename"
												title={`Rename session ${sessionTitle(session)}`}
												onClick={() => setRenamingSession(session.id)}
											>
												<Pencil size={13} aria-hidden="true" />
												<span className="sh-visually-hidden">Rename {sessionTitle(session)}</span>
											</button>
										)}
										{!readOnly && renamingSession !== session.id && (
											<button
												type="button"
												className="sh-sessions-drop"
												title={`Drop ${sessionTitle(session)}`}
												onClick={() => onDropSession(session.id)}
											>
												<Trash2 size={14} aria-hidden="true" />
												<span className="sh-visually-hidden">Drop {sessionTitle(session)}</span>
											</button>
										)}
									</div>
								))}
								{group.sessions.length === 0 && (
									<p className="sh-sessions-empty-hint">No sessions in this project.</p>
								)}
							</div>
						</section>
					);
				})}

				{groups.length === 0 && <p className="sh-sessions-empty-hint">{snapshotMessage(snapshot)}</p>}
			</div>

			<div className="sh-sessions-foot">
				{readOnly && <span className="sh-sessions-readonly">Read-only · watching</span>}
				<div className="sh-sessions-foot-row">
					<button type="button" className="sh-sessions-settings" onClick={onOpenSettings}>
						<Settings size={15} aria-hidden="true" />
						<span>Settings</span>
					</button>
					<button
						type="button"
						className="sh-sessions-leave"
						onClick={onLeave}
						aria-label="Leave control room"
						title="Leave control room"
					>
						<LogOut size={15} aria-hidden="true" />
					</button>
				</div>
			</div>
			{codexImportOpen &&
				createPortal(
					<CodexImportModal
						loadSessions={onListCodexSessions}
						onImport={onImportCodexSession}
						onClose={() => setCodexImportOpen(false)}
					/>,
					document.body,
				)}
			{projectContextMenu !== null &&
				createPortal(
					<div
						ref={projectContextMenuRef}
						className="sh-context-menu"
						role="menu"
						aria-label={`Project actions for ${projectContextMenu.name}`}
						style={{ left: projectContextMenu.x, top: projectContextMenu.y }}
						onPointerDown={event => event.stopPropagation()}
					>
						{projectContextMenu.current ? (
							<button
								autoFocus
								type="button"
								role="menuitem"
								disabled={readOnly || pending}
								onClick={() => {
									setProjectContextMenu(null);
									onNewSession();
								}}
							>
								<Plus size={14} aria-hidden="true" />
								<span>新建对话</span>
							</button>
						) : (
							<button
								autoFocus
								type="button"
								role="menuitem"
								disabled={!desktopAvailable || desktopAction !== null}
								onClick={() => {
									const { path } = projectContextMenu;
									setProjectContextMenu(null);
									void runDesktopAction(`switch:${path}`, () => desktopBridge.switchProject(path));
								}}
							>
								<FolderOpen size={14} aria-hidden="true" />
								<span>切换到此项目</span>
							</button>
						)}
						<button
							type="button"
							role="menuitem"
							disabled={!desktopAvailable || readOnly || desktopAction !== null}
							onClick={() => {
								setRenamingProject(projectContextMenu.key);
								setProjectContextMenu(null);
							}}
						>
							<Pencil size={14} aria-hidden="true" />
							<span>重命名项目</span>
						</button>
						<button
							type="button"
							role="menuitem"
							disabled={!desktopAvailable || desktopAction !== null}
							onClick={() => {
								const { path } = projectContextMenu;
								setProjectContextMenu(null);
								void runDesktopAction(`reveal-project:${path}`, () => desktopBridge.revealPath(path));
							}}
						>
							<FolderOpen size={14} aria-hidden="true" />
							<span>在资源管理器中打开</span>
						</button>
						<button
							type="button"
							role="menuitem"
							onClick={() => {
								const { path } = projectContextMenu;
								setProjectContextMenu(null);
								void copyText(path).catch(() => setDesktopError("无法复制项目路径。"));
							}}
						>
							<Copy size={14} aria-hidden="true" />
							<span>复制项目路径</span>
						</button>
						<button
							type="button"
							role="menuitem"
							className="sh-context-menu-danger sh-context-menu-separated"
							disabled={!desktopAvailable || projectContextMenu.current || readOnly || desktopAction !== null}
							onClick={() => {
								const { path } = projectContextMenu;
								setProjectContextMenu(null);
								void removeProject(path);
							}}
						>
							<Trash2 size={14} aria-hidden="true" />
							<span>从项目列表移除</span>
						</button>
					</div>,
					document.body,
				)}
			{sessionContextMenu !== null &&
				createPortal(
					<div
						ref={sessionContextMenuRef}
						className="sh-context-menu"
						role="menu"
						aria-label={`Chat actions for ${sessionContextMenu.title}`}
						style={{ left: sessionContextMenu.x, top: sessionContextMenu.y }}
						onPointerDown={event => event.stopPropagation()}
					>
						<button
							autoFocus
							type="button"
							role="menuitem"
							onClick={() => {
								setRenamingSession(sessionContextMenu.id);
								setSessionContextMenu(null);
							}}
						>
							<Pencil size={14} aria-hidden="true" />
							<span>重命名聊天</span>
						</button>
						<button
							type="button"
							role="menuitem"
							onClick={() => {
								togglePinnedSession(sessionContextMenu.id);
								setSessionContextMenu(null);
							}}
						>
							{sessionContextMenu.pinned ? (
								<PinOff size={14} aria-hidden="true" />
							) : (
								<Pin size={14} aria-hidden="true" />
							)}
							<span>{sessionContextMenu.pinned ? "取消置顶" : "置顶对话"}</span>
						</button>
						<button
							type="button"
							role="menuitem"
							disabled={!desktopAvailable}
							onClick={() => {
								const { cwd, id } = sessionContextMenu;
								setSessionContextMenu(null);
								void runDesktopAction(`reveal:${id}`, () => desktopBridge.revealPath(cwd));
							}}
						>
							<FolderOpen size={14} aria-hidden="true" />
							<span>在资源管理器里打开</span>
						</button>
						<button
							type="button"
							role="menuitem"
							onClick={() => {
								const { cwd } = sessionContextMenu;
								setSessionContextMenu(null);
								void copyText(cwd).catch(() => setDesktopError("无法复制工作目录。"));
							}}
						>
							<Copy size={14} aria-hidden="true" />
							<span>复制工作目录</span>
						</button>
						<button
							type="button"
							role="menuitem"
							onClick={() => {
								const { id } = sessionContextMenu;
								setSessionContextMenu(null);
								void copyText(id).catch(() => setDesktopError("无法复制会话 ID。"));
							}}
						>
							<Copy size={14} aria-hidden="true" />
							<span>复制会话 ID</span>
						</button>
						<button
							type="button"
							role="menuitem"
							disabled={!sessionContextMenu.unread}
							onClick={() => {
								const session = sessions.find(item => item.id === sessionContextMenu.id);
								if (session) markSessionRead(session);
								setSessionContextMenu(null);
							}}
						>
							<MailCheck size={14} aria-hidden="true" />
							<span>标记为已读</span>
						</button>
						<button
							type="button"
							role="menuitem"
							className="sh-context-menu-separated"
							disabled={pending}
							onClick={() => {
								const { id } = sessionContextMenu;
								setSessionContextMenu(null);
								void onArchiveSession(id);
							}}
						>
							<Archive size={14} aria-hidden="true" />
							<span>归档对话</span>
						</button>
					</div>,
					document.body,
				)}
		</nav>
	);
}
