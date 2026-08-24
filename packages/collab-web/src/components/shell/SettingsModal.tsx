import type { SessionSummary } from "@oh-my-pi/pi-wire";
import {
	Archive,
	ArrowLeft,
	CircleGauge,
	Folder,
	Monitor,
	Moon,
	Network,
	Palette,
	PanelsTopLeft,
	RotateCcw,
	Settings2,
	ShieldCheck,
	Sparkles,
	Sun,
	Trash2,
} from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { useModelVisibility } from "../../lib/model-visibility";
import { blockNativeSurfaces } from "../../lib/native-surface-visibility";
import { type ThemePreference, useThemePreference } from "../../lib/theme";
import { ConfirmDialog } from "./ConfirmDialog";

export interface SettingsModalProps {
	onClose(): void;
	/** Read-only session metadata. Omitted values are reported as unavailable. */
	project?: string | null;
	session?: string | null;
	readOnly?: boolean | null;
	connection?: string | null;
	model?: string | null;
	context?: string | null;
	loadArchivedSessions?(): Promise<readonly SessionSummary[]>;
	onRestoreArchivedSession?(id: string): Promise<void>;
	onDeleteArchivedSession?(id: string): Promise<void>;
}

type SettingsSection = "general" | "appearance" | "archived";

const THEME_OPTIONS: readonly {
	preference: ThemePreference;
	label: string;
	description: string;
	Icon: typeof Monitor;
}[] = [
	{ preference: "system", label: "System", description: "Match your device appearance", Icon: Monitor },
	{ preference: "light", label: "Light", description: "Use the light appearance", Icon: Sun },
	{ preference: "dark", label: "Dark", description: "Use the dark appearance", Icon: Moon },
];

const UNAVAILABLE = "Not available";

interface ArchivedProjectGroup {
	path: string;
	name: string;
	sessions: readonly SessionSummary[];
}

function archivedSessionTitle(session: SessionSummary): string {
	if (session.title?.trim()) return session.title.trim();
	return (
		session.cwd
			.split(/[\\/]+/)
			.filter(Boolean)
			.pop() || "Untitled chat"
	);
}

export function groupArchivedSessions(sessions: readonly SessionSummary[]): readonly ArchivedProjectGroup[] {
	const projects = new Map<string, { path: string; sessions: SessionSummary[] }>();
	for (const session of sessions) {
		const path = session.cwd.trim() || "Unknown project";
		const key = /^[A-Za-z]:[\\/]/.test(path) ? path.toLocaleLowerCase() : path;
		const existing = projects.get(key);
		if (existing) existing.sessions.push(session);
		else projects.set(key, { path, sessions: [session] });
	}
	return Array.from(projects.values())
		.map(project => ({
			...project,
			name:
				project.path
					.split(/[\\/]+/)
					.filter(Boolean)
					.pop() || project.path,
			sessions: project.sessions.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)),
		}))
		.sort((a, b) => (b.sessions[0]?.modifiedAt ?? "").localeCompare(a.sessions[0]?.modifiedAt ?? ""));
}

/**
 * Settings sheet. Theme is the only writable preference; session facts remain
 * metadata so the surface never implies unsupported controls.
 */
export function SettingsModal({
	onClose,
	project,
	session,
	readOnly,
	connection,
	model,
	context,
	loadArchivedSessions,
	onRestoreArchivedSession,
	onDeleteArchivedSession,
}: SettingsModalProps): ReactNode {
	const { preference, resolved, setPreference } = useThemePreference();
	const { showAllModels, setShowAllModels, isGrimoireShell } = useModelVisibility();
	const [section, setSection] = useState<SettingsSection>("general");
	const [archivedSessions, setArchivedSessions] = useState<readonly SessionSummary[]>([]);
	const [archivedLoading, setArchivedLoading] = useState(false);
	const [archivedError, setArchivedError] = useState<string | null>(null);
	const [restoringId, setRestoringId] = useState<string | null>(null);
	const [deletingId, setDeletingId] = useState<string | null>(null);
	const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
	const surfaceRef = useRef<HTMLDivElement>(null);
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;
	const returnFocusRef = useRef<HTMLElement | null>(
		typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null,
	);
	const choose = (pref: ThemePreference): void => setPreference(pref);
	const canManageArchived = readOnly !== true && loadArchivedSessions !== undefined;
	const archivedGroups = groupArchivedSessions(archivedSessions);
	const deleteConfirmSession = archivedSessions.find(item => item.id === deleteConfirmId);

	useEffect(() => {
		if (section !== "archived" || !canManageArchived || !loadArchivedSessions) return;
		let active = true;
		setArchivedLoading(true);
		setArchivedError(null);
		void loadArchivedSessions()
			.then(sessions => {
				if (active) setArchivedSessions(sessions);
			})
			.catch(error => {
				if (active) setArchivedError(error instanceof Error ? error.message : String(error));
			})
			.finally(() => {
				if (active) setArchivedLoading(false);
			});
		return () => {
			active = false;
		};
	}, [canManageArchived, loadArchivedSessions, section]);

	const restoreArchived = async (id: string): Promise<void> => {
		if (!onRestoreArchivedSession || restoringId || deletingId) return;
		setDeleteConfirmId(null);
		setRestoringId(id);
		setArchivedError(null);
		try {
			await onRestoreArchivedSession(id);
			setArchivedSessions(current => current.filter(session => session.id !== id));
		} catch (error) {
			setArchivedError(error instanceof Error ? error.message : String(error));
		} finally {
			setRestoringId(null);
		}
	};

	const deleteArchived = async (id: string): Promise<void> => {
		if (!onDeleteArchivedSession || deletingId || restoringId) return;
		setDeletingId(id);
		setArchivedError(null);
		try {
			await onDeleteArchivedSession(id);
			setArchivedSessions(current => current.filter(session => session.id !== id));
			setDeleteConfirmId(null);
		} catch (error) {
			setArchivedError(error instanceof Error ? error.message : String(error));
		} finally {
			setDeletingId(null);
		}
	};

	useEffect(() => {
		const releaseNativeSurfaces = blockNativeSurfaces();
		const previousOverflow = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		surfaceRef.current?.focus();

		const closeOnEscape = (event: globalThis.KeyboardEvent): void => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			onCloseRef.current();
		};
		document.addEventListener("keydown", closeOnEscape);

		return () => {
			releaseNativeSurfaces();
			document.removeEventListener("keydown", closeOnEscape);
			document.body.style.overflow = previousOverflow;
			returnFocusRef.current?.focus();
		};
	}, []);

	const trapFocus = (event: KeyboardEvent<HTMLDivElement>): void => {
		if (event.key !== "Tab") return;
		const focusable = surfaceRef.current?.querySelectorAll<HTMLElement>(
			'button:not(:disabled), input:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
		);
		if (!focusable || focusable.length === 0) return;
		const first = focusable.item(0);
		const last = focusable.item(focusable.length - 1);
		if (event.shiftKey && document.activeElement === first) {
			event.preventDefault();
			last.focus();
		} else if (!event.shiftKey && document.activeElement === last) {
			event.preventDefault();
			first.focus();
		}
	};

	const access = readOnly == null ? UNAVAILABLE : readOnly ? "Read only" : "Read and write";
	const activeLabel = section === "general" ? "General" : section === "appearance" ? "Appearance" : "Archived chats";

	return (
		<div className="sh-settings-backdrop" onClick={onClose}>
			<div
				className="sh-settings-sheet"
				role="dialog"
				aria-modal="true"
				aria-label="Settings"
				tabIndex={-1}
				ref={surfaceRef}
				onKeyDown={trapFocus}
				onClick={event => event.stopPropagation()}
			>
				<aside className="sh-settings-sidebar" aria-label="Settings categories">
					<button type="button" className="sh-settings-back" onClick={onClose} aria-label="Back to application">
						<ArrowLeft size={18} aria-hidden="true" />
						<span>Back to application</span>
					</button>
					<div className="sh-settings-sidebar-title">Settings</div>
					<nav className="sh-settings-nav" aria-label="Settings sections">
						<button
							type="button"
							className={section === "general" ? "sh-settings-nav-item is-active" : "sh-settings-nav-item"}
							aria-current={section === "general" ? "page" : undefined}
							aria-controls="sh-settings-panel-general"
							onClick={() => setSection("general")}
						>
							<Settings2 size={18} aria-hidden="true" />
							<span>General</span>
						</button>
						<button
							type="button"
							className={section === "appearance" ? "sh-settings-nav-item is-active" : "sh-settings-nav-item"}
							aria-current={section === "appearance" ? "page" : undefined}
							aria-controls="sh-settings-panel-appearance"
							onClick={() => setSection("appearance")}
						>
							<Palette size={18} aria-hidden="true" />
							<span>Appearance</span>
						</button>
						{canManageArchived && (
							<button
								type="button"
								className={section === "archived" ? "sh-settings-nav-item is-active" : "sh-settings-nav-item"}
								aria-current={section === "archived" ? "page" : undefined}
								aria-controls="sh-settings-panel-archived"
								onClick={() => setSection("archived")}
							>
								<Archive size={18} aria-hidden="true" />
								<span>Archived chats</span>
							</button>
						)}
					</nav>
				</aside>

				<main className="sh-settings-main">
					<div className="sh-settings-content">
						<header className="sh-settings-head">
							<p className="sh-settings-eyebrow">{activeLabel}</p>
							<h1 className="sh-settings-title">Settings</h1>
							<p className="sh-settings-description">
								{section === "archived"
									? "Archived chats stay on this computer until restored or permanently deleted."
									: "Manage local appearance and inspect the active session."}
							</p>
						</header>

						{section === "general" && (
							<div id="sh-settings-panel-general" className="sh-settings-sections">
								{isGrimoireShell && (
									<section className="sh-settings-section" aria-labelledby="sh-settings-models-title">
										<div className="sh-settings-section-head">
											<h2 id="sh-settings-models-title">模型列表</h2>
											<p>默认只显示魔法书提供的模型。</p>
										</div>
										<label className="sh-settings-switch-row">
											<span>
												<strong>显示全部模型</strong>
												<small>打开后显示 OMP 已发现的其他 Provider 和模型。</small>
											</span>
											<input
												type="checkbox"
												role="switch"
												checked={showAllModels}
												onChange={event => setShowAllModels(event.currentTarget.checked)}
											/>
										</label>
									</section>
								)}
								<section className="sh-settings-section" aria-labelledby="sh-settings-general-title">
									<div className="sh-settings-section-head">
										<h2 id="sh-settings-general-title">Session information</h2>
										<p>Read-only details supplied by the current session.</p>
									</div>
									<dl className="sh-settings-metadata">
										<div className="sh-settings-metadata-row">
											<dt>
												<Folder size={16} aria-hidden="true" /> Current project
											</dt>
											<dd title={project ?? undefined}>{project ?? UNAVAILABLE}</dd>
										</div>
										<div className="sh-settings-metadata-row">
											<dt>
												<PanelsTopLeft size={16} aria-hidden="true" /> Session
											</dt>
											<dd title={session ?? undefined}>{session ?? UNAVAILABLE}</dd>
										</div>
										<div className="sh-settings-metadata-row">
											<dt>
												<ShieldCheck size={16} aria-hidden="true" /> Access
											</dt>
											<dd>{access}</dd>
										</div>
										<div className="sh-settings-metadata-row">
											<dt>
												<Network size={16} aria-hidden="true" /> Connection
											</dt>
											<dd>{connection ?? UNAVAILABLE}</dd>
										</div>
										<div className="sh-settings-metadata-row">
											<dt>
												<Sparkles size={16} aria-hidden="true" /> Model
											</dt>
											<dd title={model ?? undefined}>{model ?? UNAVAILABLE}</dd>
										</div>
										<div className="sh-settings-metadata-row">
											<dt>
												<CircleGauge size={16} aria-hidden="true" /> Context
											</dt>
											<dd>{context ?? UNAVAILABLE}</dd>
										</div>
									</dl>
								</section>
							</div>
						)}

						{section === "appearance" && (
							<section
								className="sh-settings-section"
								id="sh-settings-panel-appearance"
								aria-labelledby="sh-settings-appearance-title"
							>
								<div className="sh-settings-section-head">
									<h2 id="sh-settings-appearance-title">Theme</h2>
									<p>Stored locally for this browser. System currently resolves to {resolved}.</p>
								</div>
								<div className="sh-settings-themes" role="radiogroup" aria-label="Theme preference">
									{THEME_OPTIONS.map(({ preference: option, label, description, Icon }) => (
										<label
											key={option}
											className={
												preference === option ? "sh-settings-theme is-selected" : "sh-settings-theme"
											}
										>
											<span className="sh-settings-theme-copy">
												<Icon size={18} aria-hidden="true" />
												<span>
													<strong>{label}</strong>
													<small>{description}</small>
												</span>
											</span>
											<input
												type="radio"
												name="theme"
												value={option}
												checked={preference === option}
												onChange={() => choose(option)}
											/>
										</label>
									))}
								</div>
							</section>
						)}

						{section === "archived" && (
							<section
								className="sh-settings-section"
								id="sh-settings-panel-archived"
								aria-labelledby="sh-settings-archived-title"
							>
								<div className="sh-settings-section-head">
									<h2 id="sh-settings-archived-title">已归档对话</h2>
									<p>彻底删除只会清理 OMP 保存的附件、剪贴板和截图图片，不会删除拖入或选择的本机源文件。</p>
								</div>
								{archivedError && (
									<p className="sh-settings-archived-error" role="alert">
										{archivedError}
									</p>
								)}
								{archivedLoading ? (
									<p className="sh-settings-archived-empty">正在加载已归档对话…</p>
								) : archivedGroups.length === 0 ? (
									<p className="sh-settings-archived-empty">还没有已归档的对话。</p>
								) : (
									<div className="sh-settings-archived-groups">
										{archivedGroups.map(group => (
											<section className="sh-settings-archived-group" key={group.path}>
												<div className="sh-settings-archived-project">
													<strong>{group.name}</strong>
													<span title={group.path}>{group.path}</span>
												</div>
												{group.sessions.map(item => (
													<div className="sh-settings-archived-row" key={item.id}>
														<div className="sh-settings-archived-copy">
															<strong>{archivedSessionTitle(item)}</strong>
															<span>{new Date(item.modifiedAt).toLocaleString()}</span>
														</div>
														<div className="sh-settings-archived-actions">
															<button
																type="button"
																className="sh-settings-restore"
																disabled={restoringId !== null || deletingId !== null}
																onClick={() => void restoreArchived(item.id)}
															>
																<RotateCcw size={14} aria-hidden="true" />
																{restoringId === item.id ? "恢复中…" : "恢复"}
															</button>
															{onDeleteArchivedSession && (
																<button
																	type="button"
																	className="sh-settings-delete"
																	disabled={restoringId !== null || deletingId !== null}
																	onClick={() => setDeleteConfirmId(item.id)}
																>
																	<Trash2 size={14} aria-hidden="true" />
																	彻底删除
																</button>
															)}
														</div>
													</div>
												))}
											</section>
										))}
									</div>
								)}
							</section>
						)}
					</div>
				</main>
			</div>
			{deleteConfirmSession && (
				<ConfirmDialog
					title="彻底删除这个对话？"
					description={
						<>
							<strong>“{archivedSessionTitle(deleteConfirmSession)}”</strong> 以及 OMP
							为它保存的附件、剪贴板图片和截图将被永久删除。拖入或选择的本机源文件不会被删除。此操作无法撤销。
						</>
					}
					confirmLabel={deletingId === deleteConfirmSession.id ? "删除中…" : "彻底删除"}
					danger
					busy={deletingId === deleteConfirmSession.id}
					onCancel={() => setDeleteConfirmId(null)}
					onConfirm={() => void deleteArchived(deleteConfirmSession.id)}
				/>
			)}
		</div>
	);
}
