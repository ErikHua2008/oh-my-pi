import type { ForeignSessionSummary, ImportedForeignSession } from "@oh-my-pi/pi-wire";
import { Menu, Plus } from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ControlClient, ControlSnapshot } from "../../lib/control-client";
import { useControlSnapshot } from "../../lib/use-control";
import { SettingsModal } from "../shell/SettingsModal";
import { SessionsPanel } from "./SessionsPanel";

export interface SessionsLayoutProps {
	client: ControlClient;
	/** Authoritative id from the active ctrl-session reply; null on the home view. */
	activeSessionId?: string | null;
	/** A create/resume request is awaiting its directed ctrl-session reply. */
	pending?: boolean;
	/** A create request specifically is awaiting its directed ctrl-session reply. */
	creating?: boolean;
	/** Active session view, or null for the empty state (no session open). */
	content: ReactNode;
	onOpenSession(id: string): void;
	onNewSession(): void;
	onOpenImportedSession(session: ImportedForeignSession): Promise<void>;
	onRenameSession(id: string, title: string): void;
	onDropSession(id: string): void;
	onLeave(): void;
}

/**
 * Control-mode frame: project/session navigation + active session or neutral home.
 * The sidebar remains mounted so ctrl-sessions broadcasts keep its state fresh.
 */
export function SessionsLayout({
	client,
	activeSessionId = null,
	pending = false,
	creating = false,
	content,
	onOpenSession,
	onNewSession,
	onOpenImportedSession,
	onRenameSession,
	onDropSession,
	onLeave,
}: SessionsLayoutProps): ReactNode {
	const snap = useControlSnapshot(client);
	const [sidebarOpen, setSidebarOpen] = useState(false);
	const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
	const [sidebarOverlay, setSidebarOverlay] = useState(() => window.matchMedia("(max-width: 900px)").matches);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const sidebarRef = useRef<HTMLElement | null>(null);
	const sidebarTriggerRef = useRef<HTMLButtonElement | null>(null);

	const openSession = (id: string): void => {
		setSidebarOpen(false);
		onOpenSession(id);
	};
	const newSession = (): void => {
		setSidebarOpen(false);
		onNewSession();
	};
	const listCodexSessions = useCallback((archived = false) => client.listCodexSessions(archived), [client]);
	const importCodexSession = useCallback(
		async (source: ForeignSessionSummary): Promise<void> => {
			const imported = await client.importCodexSession(source);
			await onOpenImportedSession(imported);
		},
		[client, onOpenImportedSession],
	);

	useEffect(() => {
		const media = window.matchMedia("(max-width: 900px)");
		const update = (): void => setSidebarOverlay(media.matches);
		media.addEventListener("change", update);
		return () => media.removeEventListener("change", update);
	}, []);

	useEffect(() => {
		const toggle = (): void => {
			if (sidebarOverlay) setSidebarOpen(open => !open);
			else setSidebarCollapsed(collapsed => !collapsed);
		};
		window.addEventListener("omp-toggle-sidebar", toggle);
		return () => window.removeEventListener("omp-toggle-sidebar", toggle);
	}, [sidebarOverlay]);

	useEffect(() => {
		if (!sidebarOpen) return;
		const previousOverflow = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		const focusFrame = requestAnimationFrame(() => {
			sidebarRef.current?.querySelector<HTMLElement>("button:not(:disabled)")?.focus();
		});
		const closeOnEscape = (event: globalThis.KeyboardEvent): void => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			setSidebarOpen(false);
			sidebarTriggerRef.current?.focus();
		};
		document.addEventListener("keydown", closeOnEscape);
		return () => {
			cancelAnimationFrame(focusFrame);
			document.removeEventListener("keydown", closeOnEscape);
			document.body.style.overflow = previousOverflow;
		};
	}, [sidebarOpen]);

	const trapSidebarFocus = (event: KeyboardEvent<HTMLElement>): void => {
		if (event.key !== "Tab") return;
		const focusable = sidebarRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled), [href]");
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

	return (
		<div className="sh-control" data-sidebar-collapsed={sidebarCollapsed ? "true" : undefined}>
			{settingsOpen && (
				<SettingsModal
					onClose={() => setSettingsOpen(false)}
					project={snap.sessions[0]?.cwd}
					readOnly={snap.readOnly}
					connection={snap.phase}
				/>
			)}
			{sidebarOpen && (
				<button
					type="button"
					className="sh-sidebar-backdrop"
					onClick={() => {
						setSidebarOpen(false);
						requestAnimationFrame(() => sidebarTriggerRef.current?.focus());
					}}
					aria-label="Close project navigation"
				/>
			)}
			<aside
				ref={sidebarRef}
				className="sh-sidebar"
				data-open={sidebarOpen ? "true" : "false"}
				role={sidebarOpen && sidebarOverlay ? "dialog" : undefined}
				aria-modal={sidebarOpen && sidebarOverlay ? "true" : undefined}
				aria-label={sidebarOpen && sidebarOverlay ? "Project navigation" : undefined}
				onKeyDown={trapSidebarFocus}
			>
				<SessionsPanel
					snapshot={snap}
					activeSessionId={activeSessionId}
					pending={pending}
					creating={creating}
					onOpenSettings={() => setSettingsOpen(true)}
					onOpenSession={openSession}
					onNewSession={newSession}
					onListCodexSessions={listCodexSessions}
					onImportCodexSession={importCodexSession}
					onRenameSession={onRenameSession}
					onDropSession={onDropSession}
					onLeave={onLeave}
				/>
			</aside>
			<div className="sh-control-main">
				<button
					ref={sidebarTriggerRef}
					type="button"
					className="sh-sidebar-toggle"
					onClick={() => setSidebarOpen(true)}
					aria-label="Show project navigation"
				>
					<Menu size={18} aria-hidden="true" />
				</button>
				<div className="sh-control-view">
					{content ?? <SessionsEmpty snap={snap} creating={creating} onNewSession={newSession} />}
				</div>
			</div>
		</div>
	);
}

function SessionsEmpty({
	snap,
	creating,
	onNewSession,
}: {
	snap: ControlSnapshot;
	creating: boolean;
	onNewSession(): void;
}): ReactNode {
	const { readOnly, phase } = snap;
	const unavailable = phase === "connecting" || phase === "waiting" || phase === "reconnecting" || phase === "ended";
	const title = readOnly
		? "Select a session to view"
		: phase === "ended"
			? "The control room has ended"
			: "What should we do?";
	const hint =
		phase === "ended"
			? snap.endedReason || "This control room is no longer available."
			: phase === "reconnecting"
				? "Reconnecting to the control room…"
				: phase === "connecting" || phase === "waiting"
					? "Connecting to the control room…"
					: readOnly
						? "Choose a session from the project navigation."
						: "Start a new session in the current project.";

	return (
		<div className="sh-sessions-empty">
			<div className="sh-sessions-empty-stack">
				<h1 className="sh-sessions-empty-title">{title}</h1>
				<div className="sh-sessions-empty-composer" data-disabled={readOnly || unavailable ? "true" : undefined}>
					<p>{hint}</p>
					{!readOnly && !unavailable && (
						<button
							type="button"
							className="sh-btn sh-sessions-new-button"
							onClick={onNewSession}
							disabled={creating}
						>
							<Plus size={15} aria-hidden="true" />
							{creating ? "Starting…" : "New session"}
						</button>
					)}
				</div>
			</div>
		</div>
	);
}
