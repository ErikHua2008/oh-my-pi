import type { ForeignSessionSummary } from "@oh-my-pi/pi-wire";
import { Archive, ArrowLeft, Check, Folder, Inbox, MessageSquare, Search, X } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { CodexImportResult } from "../../lib/control-client";
import { blockNativeSurfaces } from "../../lib/native-surface-visibility";

export interface CodexImportModalProps {
	loadSessions(archived: boolean): Promise<readonly ForeignSessionSummary[]>;
	onImport(session: ForeignSessionSummary, merge?: boolean): Promise<CodexImportResult>;
	onClose(): void;
}

export interface CodexImportProject {
	readonly path: string;
	readonly name: string;
	readonly sessions: readonly ForeignSessionSummary[];
}

type ImportStep = "select" | "confirm" | "conflict";

function sessionTitle(session: ForeignSessionSummary): string {
	return session.title?.trim() || session.firstMessage?.trim() || "Untitled Codex conversation";
}

function sessionDescription(session: ForeignSessionSummary): string | undefined {
	const title = sessionTitle(session);
	const description = session.description?.trim() || session.firstMessage?.trim();
	return description && description !== title ? description : undefined;
}

function modifiedLabel(value: string): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	return new Intl.DateTimeFormat(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	}).format(date);
}

function displayProjectPath(value: string): string {
	if (value.startsWith("\\\\?\\UNC\\")) return `\\\\${value.slice(8)}`;
	return value.startsWith("\\\\?\\") ? value.slice(4) : value;
}

function normalizedProjectPath(value: string): string {
	const displayed = displayProjectPath(value).replaceAll("\\", "/");
	const trimmed = displayed.length > 1 ? displayed.replace(/\/+$/, "") : displayed;
	return /^[A-Za-z]:/.test(trimmed) ? trimmed.toLocaleLowerCase() : trimmed;
}

function projectName(value: string): string {
	const displayed = displayProjectPath(value).replaceAll("\\", "/").replace(/\/+$/, "");
	return displayed.split("/").filter(Boolean).at(-1) || displayed || "Project";
}

export function groupCodexImportSessions(sessions: readonly ForeignSessionSummary[]): CodexImportProject[] {
	const groups = new Map<string, { path: string; name: string; sessions: ForeignSessionSummary[] }>();
	for (const session of sessions) {
		const key = normalizedProjectPath(session.cwd);
		let group = groups.get(key);
		if (!group) {
			group = { path: displayProjectPath(session.cwd), name: projectName(session.cwd), sessions: [] };
			groups.set(key, group);
		}
		group.sessions.push(session);
	}
	return [...groups.values()]
		.map(group => ({
			...group,
			sessions: group.sessions.sort(
				(left, right) =>
					Date.parse(right.modifiedAt) - Date.parse(left.modifiedAt) || left.id.localeCompare(right.id),
			),
		}))
		.sort((left, right) => {
			const leftTime = Date.parse(left.sessions[0]?.modifiedAt ?? "");
			const rightTime = Date.parse(right.sessions[0]?.modifiedAt ?? "");
			return rightTime - leftTime || left.name.localeCompare(right.name);
		});
}

export function CodexImportModal({ loadSessions, onImport, onClose }: CodexImportModalProps): ReactNode {
	const [archived, setArchived] = useState(false);
	const [sessions, setSessions] = useState<readonly ForeignSessionSummary[] | null>(null);
	const [selectedKey, setSelectedKey] = useState<string | null>(null);
	const [step, setStep] = useState<ImportStep>("select");
	const [query, setQuery] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [importing, setImporting] = useState(false);
	const [conflict, setConflict] = useState<Extract<CodexImportResult, { kind: "conflict" }>["conflict"] | null>(null);
	const surfaceRef = useRef<HTMLDivElement>(null);
	const onCloseRef = useRef(onClose);
	const importingRef = useRef(importing);
	onCloseRef.current = onClose;
	importingRef.current = importing;

	useEffect(() => {
		const releaseNativeSurfaces = blockNativeSurfaces();
		const previousOverflow = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		surfaceRef.current?.focus();
		const closeOnEscape = (event: globalThis.KeyboardEvent): void => {
			if (event.key !== "Escape" || importingRef.current) return;
			event.preventDefault();
			onCloseRef.current();
		};
		document.addEventListener("keydown", closeOnEscape);
		return () => {
			releaseNativeSurfaces();
			document.removeEventListener("keydown", closeOnEscape);
			document.body.style.overflow = previousOverflow;
		};
	}, []);

	useEffect(() => {
		let active = true;
		setSessions(null);
		setError(null);
		void loadSessions(archived)
			.then(loaded => {
				if (!active) return;
				setSessions(loaded);
			})
			.catch(reason => {
				if (!active) return;
				setSessions([]);
				setError(reason instanceof Error ? reason.message : String(reason));
			});
		return () => {
			active = false;
		};
	}, [archived, loadSessions]);

	const selected = useMemo(
		() => sessions?.find(session => `${session.id}\0${session.path}` === selectedKey),
		[selectedKey, sessions],
	);
	const filtered = useMemo(() => {
		if (!sessions) return [];
		const needle = query.trim().toLocaleLowerCase();
		if (!needle) return sessions;
		return sessions.filter(session =>
			[
				sessionTitle(session),
				sessionDescription(session),
				session.cwd,
				displayProjectPath(session.cwd),
				projectName(session.cwd),
				session.id,
			]
				.filter((value): value is string => typeof value === "string")
				.some(value => value.toLocaleLowerCase().includes(needle)),
		);
	}, [query, sessions]);
	const projects = useMemo(() => groupCodexImportSessions(filtered), [filtered]);

	const switchCollection = (nextArchived: boolean): void => {
		if (nextArchived === archived || importing) return;
		setArchived(nextArchived);
		setSelectedKey(null);
		setStep("select");
		setQuery("");
		setError(null);
		setConflict(null);
	};

	const trapFocus = (event: KeyboardEvent<HTMLDivElement>): void => {
		if (event.key !== "Tab") return;
		const focusable = surfaceRef.current?.querySelectorAll<HTMLElement>(
			'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])',
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

	const beginImport = async (merge = false): Promise<void> => {
		if (!selected || importing) return;
		setImporting(true);
		setError(null);
		try {
			const result = await onImport(selected, merge);
			if (result.kind === "conflict") {
				setConflict(result.conflict);
				setStep("conflict");
				setImporting(false);
				return;
			}
			onCloseRef.current();
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
			setImporting(false);
		}
	};

	return (
		<div className="sh-codex-import-backdrop">
			<div
				ref={surfaceRef}
				className="sh-codex-import-dialog"
				role="dialog"
				aria-modal="true"
				aria-labelledby="sh-codex-import-title"
				tabIndex={-1}
				onKeyDown={trapFocus}
			>
				<header className="sh-codex-import-head">
					<div>
						<p>Codex</p>
						<h1 id="sh-codex-import-title">
							{step === "select"
								? "Import a conversation"
								: step === "conflict"
									? "Merge conversations"
									: "Confirm import"}
						</h1>
					</div>
					<button type="button" onClick={onClose} disabled={importing} aria-label="Close import dialog">
						<X size={18} aria-hidden="true" />
					</button>
				</header>

				{step === "select" ? (
					<>
						<div className="sh-codex-import-toolbar">
							<div className="sh-codex-import-collection" aria-label="Conversation collection">
								<button
									type="button"
									data-active={!archived ? "true" : undefined}
									onClick={() => switchCollection(false)}
								>
									<Inbox size={14} aria-hidden="true" /> Current chats
								</button>
								<button
									type="button"
									data-active={archived ? "true" : undefined}
									onClick={() => switchCollection(true)}
								>
									<Archive size={14} aria-hidden="true" /> Archived chats
								</button>
							</div>
							<label className="sh-codex-import-search">
								<Search size={15} aria-hidden="true" />
								<input
									autoFocus
									value={query}
									onChange={event => setQuery(event.currentTarget.value)}
									placeholder="Search chats or projects"
									aria-label="Search Codex conversations"
								/>
							</label>
						</div>
						<div className="sh-codex-import-list" role="radiogroup" aria-label="Codex conversations">
							{sessions === null && <p className="sh-codex-import-state">Loading Codex conversations…</p>}
							{sessions !== null && filtered.length === 0 && !error && (
								<p className="sh-codex-import-state">
									{sessions.length === 0
										? archived
											? "No archived Codex conversations were found on this computer."
											: "No current Codex conversations were found on this computer."
										: "No matches."}
								</p>
							)}
							{projects.map(project => (
								<section className="sh-codex-import-project" key={normalizedProjectPath(project.path)}>
									<header>
										<span className="sh-codex-import-project-icon" aria-hidden="true">
											<Folder size={14} />
										</span>
										<span>
											<strong>{project.name}</strong>
											<small title={project.path}>{project.path}</small>
										</span>
									</header>
									<div>
										{project.sessions.map(session => {
											const key = `${session.id}\0${session.path}`;
											const checked = key === selectedKey;
											const description = sessionDescription(session);
											return (
												<label
													key={key}
													className="sh-codex-import-item"
													data-selected={checked ? "true" : undefined}
												>
													<input
														type="radio"
														name="codex-session"
														value={key}
														checked={checked}
														onChange={() => setSelectedKey(key)}
													/>
													<span className="sh-codex-import-radio" aria-hidden="true">
														{checked && <Check size={11} />}
													</span>
													<span className="sh-codex-import-item-copy">
														<strong>{sessionTitle(session)}</strong>
														{description && <span title={description}>{description}</span>}
														<small>{modifiedLabel(session.modifiedAt)}</small>
													</span>
												</label>
											);
										})}
									</div>
								</section>
							))}
						</div>
					</>
				) : step === "confirm" ? (
					selected && (
						<div className="sh-codex-import-confirm">
							<div className="sh-codex-import-confirm-icon">
								<MessageSquare size={22} aria-hidden="true" />
							</div>
							<div>
								<h2>{sessionTitle(selected)}</h2>
								<p>
									The conversation will be converted to OMP format and associated with its original project.
									Chat data is stored in OMP&apos;s app data directory, not inside the project folder.
								</p>
							</div>
							<dl>
								<div>
									<dt>Source</dt>
									<dd>{selected.archived ? "Archived Codex chats" : "Current Codex chats"}</dd>
								</div>
								<div>
									<dt>Project folder</dt>
									<dd title={displayProjectPath(selected.cwd)}>{displayProjectPath(selected.cwd)}</dd>
								</div>
								<div>
									<dt>Last updated</dt>
									<dd>{modifiedLabel(selected.modifiedAt)}</dd>
								</div>
							</dl>
							<p className="sh-codex-import-note">
								The source Codex conversation and its linked project files will not be modified or copied.
							</p>
						</div>
					)
				) : (
					selected &&
					conflict && (
						<div className="sh-codex-import-confirm">
							<div className="sh-codex-import-confirm-icon">
								<MessageSquare size={22} aria-hidden="true" />
							</div>
							<div>
								<h2>This Codex conversation is already linked</h2>
								<p>
									The existing OMP chat contains {conflict.localMessageCount} later user or assistant
									{conflict.localMessageCount === 1 ? " message" : " messages"}. Updating it directly could
									discard that work.
								</p>
							</div>
							<dl>
								<div>
									<dt>OMP chat</dt>
									<dd>{conflict.title?.trim() || sessionTitle(selected)}</dd>
								</div>
								<div>
									<dt>Copies found</dt>
									<dd>{conflict.duplicateCount}</dd>
								</div>
								<div>
									<dt>Project folder</dt>
									<dd title={displayProjectPath(conflict.cwd)}>{displayProjectPath(conflict.cwd)}</dd>
								</div>
							</dl>
							<p className="sh-codex-import-note">
								Merge keeps the original OMP chat id and places Codex and OMP entries in timestamp order. Extra
								duplicate imports are moved to Archived chats for recovery.
							</p>
						</div>
					)
				)}

				{error && (
					<p className="sh-codex-import-error" role="alert">
						{error}
					</p>
				)}
				<footer className="sh-codex-import-foot">
					{step !== "select" && (
						<button
							type="button"
							className="sh-btn"
							onClick={() => {
								setStep("select");
								setConflict(null);
							}}
							disabled={importing}
						>
							<ArrowLeft size={15} aria-hidden="true" /> Back
						</button>
					)}
					<span />
					<button type="button" className="sh-btn" onClick={onClose} disabled={importing}>
						Cancel
					</button>
					{step === "select" ? (
						<button
							type="button"
							className="sh-btn sh-btn-primary"
							onClick={() => setStep("confirm")}
							disabled={!selected}
						>
							Next
						</button>
					) : (
						<button
							type="button"
							className="sh-btn sh-btn-primary"
							onClick={() => void beginImport(step === "conflict")}
							disabled={!selected || importing}
						>
							{importing
								? step === "conflict"
									? "Merging…"
									: "Importing…"
								: step === "conflict"
									? "Merge and update"
									: "Import conversation"}
						</button>
					)}
				</footer>
			</div>
		</div>
	);
}
