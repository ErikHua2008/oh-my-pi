import type { ChatSearchResult, ImportedForeignSession } from "@oh-my-pi/pi-wire";
import { X } from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentDrawer } from "./components/agents/AgentDrawer";
import { AgentsPanel } from "./components/agents/AgentsPanel";
import { SessionsLayout } from "./components/sessions/SessionsLayout";
import { Banners } from "./components/shell/Banners";
import { ChatSearchPanel } from "./components/shell/ChatSearchPanel";
import { Composer } from "./components/shell/Composer";
import { ConnectScreen } from "./components/shell/ConnectScreen";
import { DesktopFrame } from "./components/shell/DesktopFrame";
import { HeaderBar } from "./components/shell/HeaderBar";
import { SettingsModal } from "./components/shell/SettingsModal";
import { Toasts } from "./components/shell/Toasts";
import { Transcript } from "./components/transcript/Transcript";
import { GuestClient, type GuestSnapshot, type Notice } from "./lib/client";
import { ControlClient, type ControlSessionInfo } from "./lib/control-client";
import { ControlSessionFlow } from "./lib/control-session-flow";
import { desktopBridge } from "./lib/desktop-bridge";
import { fmtPercent, fmtTokens } from "./lib/format";
import { parseCollabLink } from "./lib/link";
import { notifySessionPreferencesRemoved } from "./lib/session-preference-events";
import { useGuestSnapshot } from "./lib/use-guest";
import type { ToolRenderHost } from "./tool-render";
import "./components/shell/shell.css";

const NAME_KEY = "omp.collab.name";
const CONTROL_KEY = "omp.collab.control";
const MAX_CONTROL_NOTICES = 50;

/**
 * `control`: joined a core-mode control room (session sidebar). The control
 * client lives in state so the sidebar keeps receiving `ctrl-sessions`
 * broadcasts while a session is open. `sessionId` is the authoritative id
 * supplied by that session's directed `ctrl-session` reply.
 * `session`: a plain session deep link, no control room.
 */
type AppState =
	| { kind: "control"; client: ControlClient; session: GuestClient | null; sessionId: string | null }
	| { kind: "session"; client: GuestClient }
	| null;

interface Creds {
	link: string;
	name: string;
}

type ControlPendingOperation = "create" | "resume" | null;

function storedName(): string {
	try {
		return localStorage.getItem(NAME_KEY) ?? "guest";
	} catch {
		return "guest";
	}
}

function storedControlLink(): string | null {
	try {
		return localStorage.getItem(CONTROL_KEY);
	} catch {
		return null;
	}
}

/** Deep link = everything after the FIRST `#` (legacy links carry a second `#` inside the fragment). */
function hashLink(): string | null {
	const href = window.location.href;
	const i = href.indexOf("#");
	if (i < 0 || i + 1 >= href.length) return null;
	return href.slice(i + 1);
}

function contextLabel(snapshot: GuestSnapshot): string | null {
	const usage = snapshot.state?.contextUsage;
	if (!usage) return null;
	if (usage.percent != null) return fmtPercent(usage.percent);
	if (usage.tokens != null) return `${fmtTokens(usage.tokens)} tokens`;
	return null;
}

export function App(): ReactNode {
	const [appState, setAppState] = useState<AppState>(null);
	const [controlPendingOperation, setControlPendingOperation] = useState<ControlPendingOperation>(null);
	const [connectError, setConnectError] = useState<string | null>(null);
	const [controlNotices, setControlNotices] = useState<Notice[]>([]);
	const credsRef = useRef<Creds | null>(null);
	const [controlFlow] = useState(() => new ControlSessionFlow());
	const noticeSeqRef = useRef(0);

	const pushNotice = useCallback((level: Notice["level"], message: string): void => {
		setControlNotices(prev => {
			const next = [...prev, { id: ++noticeSeqRef.current, level, message, at: Date.now() }];
			if (next.length > MAX_CONTROL_NOTICES) next.splice(0, next.length - MAX_CONTROL_NOTICES);
			return next;
		});
	}, []);

	/** Open a session room from the control sidebar; the control client stays connected. */
	const openSessionLink = useCallback(
		(ctrl: ControlClient, link: string, sessionId: string): void => {
			let next: GuestClient;
			try {
				next = new GuestClient(link, storedName());
			} catch (err) {
				pushNotice("error", err instanceof Error ? err.message : String(err));
				return;
			}
			next.connect();
			if (controlFlow.activeClient !== ctrl) {
				next.close();
				return;
			}
			credsRef.current = { link, name: storedName() };
			window.location.hash = link;
			setAppState(prev => {
				if (prev?.kind === "session") prev.client.close();
				if (prev?.kind === "control") prev.session?.close();
				return { kind: "control", client: ctrl, session: next, sessionId };
			});
		},
		[controlFlow, pushNotice],
	);

	/** Directed `ctrl-session` reply: honored only when it matches a pending op. */
	const handleCtrlSession = useCallback(
		(source: ControlClient, info: ControlSessionInfo): void => {
			const accepted = controlFlow.accept(source, info);
			if (!accepted) return;
			setControlPendingOperation(null);
			openSessionLink(source, accepted.link, accepted.id);
		},
		[controlFlow, openSessionLink],
	);

	const connect = useCallback(
		(link: string, name: string): void => {
			const parsed = parseCollabLink(link);
			if ("error" in parsed) {
				setConnectError(parsed.error);
				return;
			}
			credsRef.current = { link, name };
			setConnectError(null);

			if (parsed.roomId.startsWith("ctrl-")) {
				let ctrl: ControlClient;
				try {
					ctrl = new ControlClient(link, name);
				} catch (err) {
					setConnectError(err instanceof Error ? err.message : String(err));
					return;
				}
				ctrl.onError = message => {
					// A failed op ends the pending create/resume round trip.
					if (controlFlow.fail(ctrl)) setControlPendingOperation(null);
					pushNotice("error", message);
				};
				ctrl.onEnded = () => {
					// A terminal room/socket event cannot produce the pending reply.
					if (controlFlow.fail(ctrl)) setControlPendingOperation(null);
				};
				ctrl.onSession = info => handleCtrlSession(ctrl, info);
				ctrl.connect();
				try {
					localStorage.setItem(NAME_KEY, name);
					localStorage.setItem(CONTROL_KEY, link);
				} catch {
					// storage unavailable (private mode) — non-fatal
				}
				window.location.hash = link;
				controlFlow.activate(ctrl)?.close();
				setControlPendingOperation(null);
				setAppState(prev => {
					if (prev?.kind === "session") prev.client.close();
					if (prev?.kind === "control") prev.session?.close();
					return { kind: "control", client: ctrl, session: null, sessionId: null };
				});
				return;
			}

			let next: GuestClient;
			try {
				next = new GuestClient(link, name);
			} catch (err) {
				setConnectError(err instanceof Error ? err.message : String(err));
				return;
			}
			next.connect();
			try {
				localStorage.setItem(NAME_KEY, name);
			} catch {
				// storage unavailable (private mode) — non-fatal
			}
			window.location.hash = link;
			// A plain session deep link replaces any active control room.
			controlFlow.deactivate()?.close();
			setControlPendingOperation(null);
			setAppState(prev => {
				if (prev?.kind === "session") prev.client.close();
				if (prev?.kind === "control") prev.session?.close();
				return { kind: "session", client: next };
			});
		},
		[controlFlow, handleCtrlSession, pushNotice],
	);

	const leave = useCallback((): void => {
		const control = controlFlow.deactivate();
		setControlPendingOperation(null);
		setAppState(prev => {
			prev?.client.close();
			if (prev?.kind === "control") prev.session?.close();
			return null;
		});
		control?.close();
		history.replaceState(null, "", window.location.pathname + window.location.search);
	}, [controlFlow]);

	/** Control mode: return from a session view to the sidebar. */
	const backToSessions = useCallback((): void => {
		controlFlow.cancelPending();
		setControlPendingOperation(null);
		const ctrl = controlFlow.activeClient;
		if (!ctrl) {
			leave();
			return;
		}
		ctrl.sendList();
		setAppState(prev => {
			if (prev?.kind === "session") prev.client.close();
			if (prev?.kind === "control") prev.session?.close();
			return { kind: "control", client: ctrl, session: null, sessionId: null };
		});
	}, [controlFlow, leave]);

	const rejoin = useCallback((): void => {
		const creds = credsRef.current;
		if (creds) connect(creds.link, creds.name);
	}, [connect]);

	// Visual Viewport: adjust app height to fit screen space when mobile keyboard opens.
	useEffect(() => {
		const vv = window.visualViewport;
		if (!vv) return;

		const updateHeight = () => {
			document.documentElement.style.setProperty("--viewport-height", `${vv.height}px`);
			window.scrollTo(0, 0);
		};

		updateHeight();
		vv.addEventListener("resize", updateHeight);
		vv.addEventListener("scroll", updateHeight);

		return () => {
			vv.removeEventListener("resize", updateHeight);
			vv.removeEventListener("scroll", updateHeight);
		};
	}, []);

	// Deep link: a page load with a hash auto-connects.
	useEffect(() => {
		const link = hashLink();
		if (link) connect(link, storedName());
	}, [connect]);

	useEffect(() => {
		if (!appState) document.title = "omp collab";
		else if (appState.kind === "control" && !appState.session) document.title = "sessions · omp collab";
	}, [appState]);

	const startCreate = useCallback(
		(client: ControlClient, projectPath?: string): void => {
			if (!controlFlow.startCreate(client, projectPath)) return;
			setControlPendingOperation("create");
		},
		[controlFlow],
	);

	const startResume = useCallback(
		(client: ControlClient, id: string): void => {
			if (!controlFlow.startResume(client, id)) return;
			setControlPendingOperation("resume");
		},
		[controlFlow],
	);

	const startArchive = useCallback(
		async (client: ControlClient, id: string, isActive: boolean): Promise<void> => {
			try {
				await client.archiveSession(id);
				if (isActive && controlFlow.activeClient === client) backToSessions();
				pushNotice("info", "对话已归档，可在 Settings 的 Archived chats 中恢复。");
			} catch (error) {
				pushNotice("error", error instanceof Error ? error.message : String(error));
				throw error;
			}
		},
		[backToSessions, controlFlow, pushNotice],
	);

	const openImportedSession = useCallback(
		async (client: ControlClient, session: ImportedForeignSession): Promise<void> => {
			if (controlFlow.activeClient !== client) throw new Error("the control room changed during import");
			if (!session.requiresProjectSwitch) {
				startResume(client, session.id);
				return;
			}
			if (!desktopBridge.available) {
				throw new Error(
					"the imported conversation belongs to another project, but desktop project switching is unavailable",
				);
			}
			const switched = await desktopBridge.openImportedSession(session.cwd, session.id);
			if (!switched) startResume(client, session.id);
		},
		[controlFlow, startResume],
	);

	useEffect(() => {
		if (appState?.kind !== "control" || appState.session !== null || controlPendingOperation !== null) return;
		const client = appState.client;
		let checked = false;
		let active = true;
		const resumePendingImport = (): void => {
			if (checked || client.getSnapshot().phase !== "live") return;
			checked = true;
			void desktopBridge.takePendingImportedSession().then(sessionId => {
				if (active && sessionId) startResume(client, sessionId);
			});
		};
		const unsubscribe = client.subscribe(resumePendingImport);
		resumePendingImport();
		return () => {
			active = false;
			unsubscribe();
		};
	}, [appState, controlPendingOperation, startResume]);

	if (!appState) {
		return (
			<DesktopFrame>
				<ConnectScreen
					defaultName={storedName()}
					error={connectError}
					savedControlLink={storedControlLink()}
					onConnect={connect}
				/>
				<Toasts notices={controlNotices} />
			</DesktopFrame>
		);
	}

	if (appState.kind === "session") {
		return (
			<DesktopFrame>
				<Session client={appState.client} onLeave={leave} onRejoin={rejoin} />
				<Toasts notices={controlNotices} />
			</DesktopFrame>
		);
	}

	return (
		<DesktopFrame canGoBack={appState.session !== null} onBack={backToSessions}>
			<SessionsLayout
				client={appState.client}
				activeSessionId={appState.sessionId}
				pending={controlPendingOperation !== null}
				creating={controlPendingOperation === "create"}
				content={
					appState.session ? (
						<Session
							client={appState.session}
							controlClient={appState.client}
							onLeave={backToSessions}
							onRejoin={backToSessions}
							onBack={backToSessions}
						/>
					) : null
				}
				onOpenSession={id => startResume(appState.client, id)}
				onNewSession={projectPath => startCreate(appState.client, projectPath)}
				onOpenImportedSession={session => openImportedSession(appState.client, session)}
				onRenameSession={(id, title) => appState.client.sendRename(id, title)}
				onArchiveSession={id => startArchive(appState.client, id, appState.sessionId === id)}
				onLeave={leave}
			/>
			<Toasts notices={controlNotices} />
		</DesktopFrame>
	);
}

interface SessionProps {
	client: GuestClient;
	controlClient?: ControlClient;
	onLeave(): void;
	onRejoin(): void;
	/** Control mode: back entry shown in the header; also the post-end auto-return. */
	onBack?: () => void;
}

function Session({ client, controlClient, onLeave, onRejoin, onBack }: SessionProps): ReactNode {
	const snap = useGuestSnapshot(client);
	const [composerPrefill, setComposerPrefill] = useState<string | undefined>(undefined);
	const [railOpen, setRailOpen] = useState(false);
	const [narrowViewport, setNarrowViewport] = useState(() => window.matchMedia("(max-width: 1024px)").matches);
	const [nativeWindowLayout, setNativeWindowLayout] = useState(false);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [searchOpen, setSearchOpen] = useState(false);
	const [revealTarget, setRevealTarget] = useState<{ entryId: string; rowId: string; revision: number } | null>(null);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const autoOpenedRef = useRef(false);
	const agentsButtonRef = useRef<HTMLButtonElement | null>(null);
	const railRef = useRef<HTMLElement | null>(null);
	// Match the CSS breakpoint exactly. The native host may grow the window
	// when Agents opens, which naturally flips this media query from overlay to
	// docked; if the monitor is too narrow it remains an overlay without a
	// second source of truth fighting the layout.
	const railOverlay = narrowViewport;
	const closeRail = useCallback((): void => {
		setRailOpen(false);
		requestAnimationFrame(() => agentsButtonRef.current?.focus());
	}, []);
	const listArchivedSessions = useCallback(
		() => controlClient?.listArchivedSessions() ?? Promise.resolve([]),
		[controlClient],
	);
	const restoreArchivedSession = useCallback(
		async (id: string): Promise<void> => {
			if (!controlClient) throw new Error("archived chats are available from the project window");
			await controlClient.restoreArchivedSession(id);
		},
		[controlClient],
	);
	const deleteArchivedSession = useCallback(
		async (id: string): Promise<void> => {
			if (!controlClient) throw new Error("archived chats are available from the project window");
			await controlClient.deleteArchivedSession(id);
			notifySessionPreferencesRemoved(id);
		},
		[controlClient],
	);
	const toggleRail = useCallback((): void => {
		if (railOpen) closeRail();
		else {
			setSettingsOpen(false);
			setSearchOpen(false);
			setRailOpen(true);
		}
	}, [closeRail, railOpen]);
	const toggleSearch = useCallback((): void => {
		setSearchOpen(open => {
			if (!open) {
				setSettingsOpen(false);
				setRailOpen(false);
			}
			return !open;
		});
	}, []);
	const revealSearchResult = useCallback(
		async (result: ChatSearchResult): Promise<boolean> => {
			if (!(await client.ensureChatEntryLoaded(result.entryId))) return false;
			setRevealTarget(current => ({
				entryId: result.entryId,
				rowId: result.rowId,
				revision: (current?.revision ?? 0) + 1,
			}));
			return true;
		},
		[client],
	);

	useEffect(() => {
		const openChatSearch = (event: globalThis.KeyboardEvent): void => {
			if (event.key.toLocaleLowerCase() !== "f" || (!event.ctrlKey && !event.metaKey)) return;
			event.preventDefault();
			setSettingsOpen(false);
			setRailOpen(false);
			setSearchOpen(true);
		};
		document.addEventListener("keydown", openChatSearch);
		return () => document.removeEventListener("keydown", openChatSearch);
	}, []);

	useEffect(() => {
		// React can preserve this Session component while the control client swaps
		// to another conversation. Never carry a result or highlight across chats.
		setSearchOpen(false);
		setRevealTarget(null);
	}, [client]);

	const subCount = useMemo(() => snap.agents.filter(a => a.kind === "sub").length, [snap.agents]);

	useEffect(() => {
		const media = window.matchMedia("(max-width: 1024px)");
		const update = (): void => setNarrowViewport(media.matches);
		media.addEventListener("change", update);
		return () => media.removeEventListener("change", update);
	}, []);

	useEffect(() => {
		let disposed = false;
		void desktopBridge.setAgentRailOpen(false).then(supported => {
			if (!disposed) setNativeWindowLayout(supported);
		});
		return () => {
			disposed = true;
			void desktopBridge.setAgentRailOpen(false);
		};
	}, []);

	useEffect(() => {
		if (!nativeWindowLayout) return;
		void desktopBridge.setAgentRailOpen(railOpen);
	}, [nativeWindowLayout, railOpen]);

	// Task-card agent chips drill into the same drawer the rail uses.
	const agentIds = useMemo(() => new Set(snap.agents.map(a => a.id)), [snap.agents]);
	const toolHost = useMemo<ToolRenderHost>(
		() => ({
			hasAgent: id => agentIds.has(id),
			openAgent: id => {
				if (agentIds.has(id)) setSelectedId(id);
			},
			loadImage: (imageId, variant) => client.fetchImage(imageId, variant),
		}),
		[agentIds, client],
	);

	// Auto-open the rail the first time a subagent appears.
	useEffect(() => {
		if (subCount > 0 && !railOverlay && !autoOpenedRef.current) {
			autoOpenedRef.current = true;
			setRailOpen(true);
		}
	}, [railOverlay, subCount]);

	useEffect(() => {
		if (!railOpen) return;
		const closeOnEscape = (event: globalThis.KeyboardEvent): void => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			closeRail();
		};
		document.addEventListener("keydown", closeOnEscape);
		return () => document.removeEventListener("keydown", closeOnEscape);
	}, [closeRail, railOpen]);

	useEffect(() => {
		if (!railOpen || !railOverlay) return;
		const previousOverflow = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		const frame = requestAnimationFrame(() => {
			const rail = railRef.current;
			(rail?.querySelector<HTMLElement>("button:not(:disabled)") ?? rail)?.focus();
		});
		return () => {
			cancelAnimationFrame(frame);
			document.body.style.overflow = previousOverflow;
		};
	}, [railOpen, railOverlay]);

	const trapRailFocus = (event: KeyboardEvent<HTMLElement>): void => {
		if (!railOverlay || event.key !== "Tab") return;
		const focusable = railRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled), [href]");
		if (!focusable || focusable.length === 0) {
			event.preventDefault();
			railRef.current?.focus();
			return;
		}
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

	const title = snap.header?.title ?? snap.state?.sessionName ?? "session";
	useEffect(() => {
		document.title = `${title} · omp collab`;
	}, [title]);

	const drawerAgent = selectedId != null ? snap.agents.find(a => a.id === selectedId) : undefined;

	return (
		<div
			className="sh-app"
			data-agent-rail={railOpen && !railOverlay ? "true" : undefined}
			data-chat-search={searchOpen ? "true" : undefined}
		>
			<div inert={railOpen && railOverlay ? true : undefined}>
				<HeaderBar
					snapshot={snap}
					subCount={subCount}
					railOpen={railOpen}
					agentsButtonRef={agentsButtonRef}
					onToggleRail={toggleRail}
					onLeave={onLeave}
					onBack={onBack}
					settingsOpen={settingsOpen}
					onToggleSettings={() => {
						if (!settingsOpen) {
							setRailOpen(false);
							setSearchOpen(false);
						}
						setSettingsOpen(open => !open);
					}}
					searchOpen={searchOpen}
					onToggleSearch={toggleSearch}
				/>
			</div>
			{settingsOpen && (
				<SettingsModal
					onClose={() => setSettingsOpen(false)}
					project={snap.state?.cwd}
					session={title}
					readOnly={snap.readOnly}
					connection={snap.phase}
					model={snap.state?.model?.name}
					context={contextLabel(snap)}
					loadArchivedSessions={controlClient ? listArchivedSessions : undefined}
					onRestoreArchivedSession={controlClient ? restoreArchivedSession : undefined}
					onDeleteArchivedSession={controlClient ? deleteArchivedSession : undefined}
				/>
			)}
			<main className="sh-main">
				{railOpen && railOverlay && <div className="sh-rail-backdrop" aria-hidden="true" onClick={closeRail} />}
				<section
					className="sh-content"
					data-rail={railOpen ? "true" : "false"}
					inert={railOpen && railOverlay ? true : undefined}
				>
					<div className="sh-transcript">
						<Transcript
							entries={snap.entries}
							stream={snap.stream}
							streamDone={snap.streamDone}
							activeTools={snap.activeTools}
							working={snap.working}
							sessionId={snap.header?.id}
							historyRemaining={snap.historyRemaining}
							historyLoading={snap.historyLoading}
							fileDropEnabled={snap.phase === "live" && !snap.readOnly}
							revealTarget={revealTarget}
							onLoadEarlier={() => client.loadEarlierHistory()}
							host={toolHost}
							onEditLastUserMessage={setComposerPrefill}
						/>
					</div>
				</section>
				{searchOpen && (
					<ChatSearchPanel client={client} onClose={() => setSearchOpen(false)} onReveal={revealSearchResult} />
				)}
				{railOpen && (
					<aside
						ref={railRef}
						className="sh-rail"
						role={railOverlay ? "dialog" : undefined}
						aria-modal={railOverlay ? "true" : undefined}
						aria-label="Agents"
						tabIndex={railOverlay ? -1 : undefined}
						onKeyDown={trapRailFocus}
					>
						<div className="sh-rail-header">
							<span className="sh-rail-title">Agents</span>
							<button type="button" className="sh-rail-close" onClick={closeRail} aria-label="Close agents">
								<X size={14} />
							</button>
						</div>
						<AgentsPanel
							agents={snap.agents}
							progress={snap.progress}
							lifecycle={snap.lifecycle}
							selectedId={selectedId}
							onSelect={setSelectedId}
						/>
					</aside>
				)}
			</main>
			{snap.phase === "ended" ? (
				<Banners phase={snap.phase} endedReason={snap.endedReason} onRejoin={onRejoin} onNewLink={onLeave} />
			) : (
				<Composer
					client={client}
					snapshot={snap}
					prefill={composerPrefill}
					onPrefillConsumed={() => setComposerPrefill(undefined)}
					onOpenChatSearch={toggleSearch}
				/>
			)}
			{drawerAgent && (
				<>
					<div className="ag-drawer-backdrop" onClick={() => setSelectedId(null)} />
					<AgentDrawer
						agent={drawerAgent}
						progress={snap.progress.get(drawerAgent.id)}
						client={client}
						readOnly={snap.readOnly}
						host={toolHost}
						onClose={() => setSelectedId(null)}
					/>
				</>
			)}
			{snap.phase !== "ended" && (
				<Banners phase={snap.phase} endedReason={snap.endedReason} onRejoin={onRejoin} onNewLink={onLeave} />
			)}
			<Toasts notices={snap.notices} />
		</div>
	);
}
