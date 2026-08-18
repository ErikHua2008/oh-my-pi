/**
 * Contract tests for the core-mode control room and session registry
 * (multi-session core): hello/list/create/resume over the control room,
 * read-only enforcement for peers without the write token, per-session agent
 * scoping in the session rooms, and the registry's failure cleanup.
 *
 * Runs over the real local relay server (dual rooms: control + a session
 * room) with real AES-GCM sealing — only AgentSession/SessionManager are
 * fakes (model is always undefined; collab never needs an LLM). The relay
 * room the initial session and any registry-created session host is real, so
 * the created deep link is provably usable by a plain guest.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ControlHost } from "@oh-my-pi/pi-coding-agent/collab/control-host";
import { importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import type { CollabHostContext } from "@oh-my-pi/pi-coding-agent/collab/host-context";
import { type LocalServer, startLocalServer } from "@oh-my-pi/pi-coding-agent/collab/local-server";
import { COLLAB_PROTO, type CollabFrame, parseCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import { SessionRegistry } from "@oh-my-pi/pi-coding-agent/collab/session-registry";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { CodexSessionStore } from "@oh-my-pi/pi-coding-agent/session/codex-session-store";
import type { ForeignSessionInfo } from "@oh-my-pi/pi-coding-agent/session/foreign-session-store";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getBlobsDir, getManagedMediaDir, getSessionsDir } from "@oh-my-pi/pi-utils";
import type { Settings } from "../../src/config/settings";
import * as sdk from "../../src/sdk";
import { EventBus } from "../../src/utils/event-bus";

const GUEST_TIMEOUT_MS = 5_000;
const INITIAL_SESSION_ID = "sess-1";
const INITIAL_SESSION_CWD = "/tmp";
/** Scope of the foreign agent registered in scenario 5 — not the initial session's. */
const OTHER_SCOPE_ID = "other-scope-1";
const OTHER_AGENT_ID = "other-session-agent";

// ── Doubles ────────────────────────────────────────────────────────────────

/**
 * Minimal AgentSession double covering exactly the surface CollabHost and the
 * registry touch (see read-only.test.ts's makeHostContext): identity, the
 * state fields #buildState reads, and no-op lifecycle hooks. `model` stays
 * undefined — collab tests never need an LLM.
 */
function makeSessionDouble(scopeId: string, sessionManager: SessionManager): AgentSession {
	return {
		sessionManager,
		settings: { get: () => "" } as unknown as Settings,
		isStreaming: false,
		isAborting: false,
		queuedMessageCount: 0,
		sessionName: undefined,
		model: undefined,
		thinkingLevel: undefined,
		configuredThinkingLevel: () => undefined,
		getAgentScopeId: () => scopeId,
		getContextUsage: () => undefined,
		subscribe: () => () => {},
		emitNotice: () => {},
		promptCustomMessage: async () => {},
		abort: async () => {},
		dispose: async () => {},
	} as unknown as AgentSession;
}

/**
 * Minimal SessionManager double: identity + the replication surface the
 * CollabHost hello path reads (snapshotForReplication), plus the file
 * accessors the registry's resume/list paths use. `onEntryAppended` must be
 * writable — CollabHost.start installs its entry broadcast there.
 */
function makeSessionManagerDouble(
	id: string,
	sessionFile: { current: string | undefined },
	cwd: string,
): SessionManager {
	let title: string | undefined;
	return {
		getSessionId: () => id,
		getCwd: () => cwd,
		getSessionDir: () => (sessionFile.current ? path.dirname(sessionFile.current) : cwd),
		getSessionFile: () => sessionFile.current,
		getSessionName: () => title,
		setSessionName: async (name: string) => {
			title = name.trim();
			const header = { type: "session", id, timestamp: new Date().toISOString(), cwd, title };
			if (!sessionFile.current) throw new Error("test session has no persisted file");
			await fs.writeFile(sessionFile.current, `${JSON.stringify(header)}\n`);
			return title.length > 0;
		},
		snapshotForReplication: () => ({
			header: { type: "session", id, timestamp: new Date().toISOString(), cwd, title },
			entries: [],
		}),
		onEntryAppended: undefined,
	} as unknown as SessionManager;
}

/** Minimal CollabHostContext double (mirrors read-only.test.ts's makeHostContext). */
function makeHostContext(session: AgentSession, sessionManager: SessionManager, eventBus: EventBus): CollabHostContext {
	return {
		settings: { get: () => "" } as unknown as Settings,
		sessionManager,
		session,
		eventBus,
		statusLine: {
			setCollabStatus: () => {},
			invalidate: () => {},
			getCachedContextBreakdown: () => ({ usedTokens: 0, contextWindow: 0 }),
		},
		ui: { requestRender: () => {} },
		showStatus: () => {},
		updatePendingMessagesDisplay: () => {},
		collabHost: undefined,
	} as unknown as CollabHostContext;
}

// ── Raw guest over the wire protocol (control or session room) ─────────────

interface TestGuest {
	socket: CollabSocket;
	/**
	 * Resolve with the next frame satisfying `predicate` (skipping unrelated
	 * interleaved broadcast frames), or reject on timeout. Frames are never
	 * dropped: non-matching ones stay queued for later predicates.
	 */
	nextFrame(predicate?: (frame: CollabFrame) => boolean, timeoutMs?: number): Promise<CollabFrame>;
	close(): void;
}

interface JoinRoomOptions {
	/** Send the control-room hello (ctrl-hello) instead of the session hello. */
	ctrl?: boolean;
	/**
	 * Write token for hello. undefined → derive from the link; null → omit
	 * (a read-only peer); a string → use verbatim.
	 */
	writeToken?: string | null;
}

async function joinRoom(link: string, name: string, options: JoinRoomOptions = {}): Promise<TestGuest> {
	const parsed = parseCollabLink(link);
	if ("error" in parsed) throw new Error(parsed.error);
	const writeToken =
		options.writeToken === null
			? undefined
			: (options.writeToken ??
				(parsed.writeToken ? Buffer.from(parsed.writeToken).toString("base64url") : undefined));
	const key = await importRoomKey(parsed.key);
	const socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
	const queue: CollabFrame[] = [];
	const waiters: {
		predicate: (frame: CollabFrame) => boolean;
		resolve: (frame: CollabFrame) => void;
		timer: Timer;
	}[] = [];
	socket.onFrame = frame => {
		for (let i = 0; i < waiters.length; i++) {
			const waiter = waiters[i];
			if (waiter?.predicate(frame)) {
				waiters.splice(i, 1);
				clearTimeout(waiter.timer);
				waiter.resolve(frame);
				return;
			}
		}
		queue.push(frame);
	};
	socket.onOpen = () => {
		if (options.ctrl) {
			socket.send({ t: "ctrl-hello", proto: COLLAB_PROTO, name, writeToken });
		} else {
			socket.send({ t: "hello", proto: COLLAB_PROTO, name, writeToken });
		}
	};
	socket.connect();
	const nextFrame = (
		predicate: (frame: CollabFrame) => boolean = () => true,
		timeoutMs = GUEST_TIMEOUT_MS,
	): Promise<CollabFrame> => {
		const queuedIndex = queue.findIndex(predicate);
		if (queuedIndex >= 0) {
			const [frame] = queue.splice(queuedIndex, 1);
			return Promise.resolve(frame!);
		}
		const { promise, resolve, reject } = Promise.withResolvers<CollabFrame>();
		// Hang guard only: it fires on a missing frame (a test failure) and
		// never asserts on elapsed time, so real wall-clock timing is the
		// right tool here — fake timers cannot make a live websocket deliver.
		const timer = setTimeout(() => {
			const index = waiters.findIndex(waiter => waiter.resolve === resolve);
			if (index >= 0) waiters.splice(index, 1);
			reject(new Error(`timed out after ${timeoutMs}ms waiting for a collab frame`));
		}, timeoutMs);
		waiters.push({ predicate, resolve, timer });
		return promise;
	};
	return { socket, nextFrame, close: () => socket.close() };
}

// ── Harness: registry + initial session host + control host ────────────────

interface Harness {
	registry: SessionRegistry;
	initialHost: CollabHost;
	controlHost: ControlHost;
	sessionDir: string;
	agentDir: string;
	persistInitialMessage(): Promise<void>;
}

let server: LocalServer;
let harness: Harness | undefined;
const guestCleanups: (() => void)[] = [];

async function setupHarness(persistedInitial = true): Promise<Harness> {
	const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-core-ctrl-"));
	const agentDir = path.join(sessionDir, "agent");
	const initialSessionFile = path.join(sessionDir, "initial.jsonl");
	const initialSessionFileRef: { current: string | undefined } = {
		// SessionManager.create() assigns the future JSONL path immediately even
		// though lazy persistence has not created the file yet.
		current: initialSessionFile,
	};
	const header = {
		type: "session",
		id: INITIAL_SESSION_ID,
		timestamp: new Date().toISOString(),
		cwd: INITIAL_SESSION_CWD,
	};
	if (persistedInitial) await fs.writeFile(initialSessionFile, `${JSON.stringify(header)}\n`);

	const registry = new SessionRegistry({
		relayUrl: server.relayUrl,
		webLinkBase: server.webLinkBase,
		baseSessionOptions: {},
		sessionDir,
		agentDir,
	});

	const initialManager = makeSessionManagerDouble(INITIAL_SESSION_ID, initialSessionFileRef, INITIAL_SESSION_CWD);
	const initialSession = makeSessionDouble(INITIAL_SESSION_ID, initialManager);
	const initialBus = new EventBus();
	const initialHost = new CollabHost(makeHostContext(initialSession, initialManager, initialBus));
	await initialHost.start(server.relayUrl, server.webLinkBase);
	const parsed = parseCollabLink(initialHost.link);
	if ("error" in parsed) throw new Error(parsed.error);
	registry.registerInitial({
		id: INITIAL_SESSION_ID,
		agentId: `session-${INITIAL_SESSION_ID}`,
		roomId: parsed.roomId,
		createdAt: new Date().toISOString(),
		session: initialSession,
		sessionManager: initialManager,
		eventBus: initialBus,
		collabHost: initialHost,
		streaming: false,
		state: "running",
	});

	const controlHost = new ControlHost(registry);
	await controlHost.start(server.relayUrl, server.webLinkBase);
	return {
		registry,
		initialHost,
		controlHost,
		sessionDir,
		agentDir,
		persistInitialMessage: async () => {
			initialSessionFileRef.current = initialSessionFile;
			const message = {
				type: "message",
				id: "message-1",
				parentId: null,
				timestamp: new Date().toISOString(),
				message: { role: "user", content: [{ type: "text", text: "hello" }] },
			};
			await fs.writeFile(initialSessionFile, `${JSON.stringify(header)}\n${JSON.stringify(message)}\n`);
		},
	};
}

async function teardownHarness(target: Harness | undefined): Promise<void> {
	if (!target) return;
	try {
		await target.controlHost.stop("test done");
	} catch {
		// Best-effort teardown; never mask the test result.
	}
	try {
		await target.registry.stopAll();
	} catch {
		// Best-effort teardown; never mask the test result.
	}
	await fs.rm(target.sessionDir, { recursive: true, force: true });
}

/**
 * Replace createAgentSession with a double returning the shape the registry
 * consumes: a fake session whose sessionManager and agent scope come from the
 * options the registry injected (mirroring the sdk's `scopeId = agentScopeId
 * ?? sessionManager.getSessionId()`), so the provisioned CollabHost and the
 * registry's entry agree on the session id and agent scope. The registry
 * imports createAgentSession as a named export, and Bun's ESM namespace is
 * live, so spying on the module namespace intercepts the registry's calls.
 */
function spyOnCreateAgentSession(): { created: Array<{ id: string; session: AgentSession }> } {
	const created: Array<{ id: string; session: AgentSession }> = [];
	vi.spyOn(sdk, "createAgentSession").mockImplementation(async options => {
		if (!options) throw new Error("test spy: expected registry-injected options");
		const manager = options.sessionManager;
		if (!manager) throw new Error("test spy: expected a registry-injected sessionManager");
		const session = makeSessionDouble(manager.getSessionId(), manager);
		created.push({ id: manager.getSessionId(), session });
		return {
			session,
			eventBus: new EventBus(),
			setToolUIContext: () => {},
			extensionsResult: {} as unknown as sdk.CreateAgentSessionResult["extensionsResult"],
			mcpManager: undefined,
		};
	});
	return { created };
}

async function importedCodexManager(info: ForeignSessionInfo, content = "Imported prompt"): Promise<SessionManager> {
	const manager = SessionManager.inMemory(info.cwd);
	manager.ingestReplicatedEntry({
		type: "message",
		id: "codex-user-audit",
		parentId: null,
		timestamp: "2026-08-01T00:00:00.000Z",
		message: { role: "user", content, timestamp: Date.parse("2026-08-01T00:00:00.000Z") },
	});
	await manager.setSessionName(info.title ?? "Imported Codex chat", "auto", "codex-import");
	return manager;
}

// ── Suite ──────────────────────────────────────────────────────────────────

describe("control room + session registry (multi-session core)", () => {
	beforeAll(async () => {
		const distDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-core-ctrl-web-"));
		await fs.writeFile(path.join(distDir, "index.html"), "<html>core control test</html>");
		server = startLocalServer({ webDistDir: distDir });
	});

	afterEach(async () => {
		for (const cleanup of guestCleanups.splice(0).reverse()) cleanup();
		await teardownHarness(harness);
		harness = undefined;
		vi.restoreAllMocks();
		// The global registry is process-wide; every host subscribed to it
		// during start and unsubscribed during teardown above, so resetting
		// here leaves no listener dangling for the next test.
		AgentRegistry.resetGlobalForTests();
	});

	afterAll(() => {
		server.stop();
	});

	it("welcomes a full-control guest and lists the initial session with its link", async () => {
		harness = await setupHarness();
		const guest = await joinRoom(harness.controlHost.webLink, "writer", { ctrl: true });
		guestCleanups.push(() => guest.close());

		const welcome = await guest.nextFrame(f => f.t === "ctrl-welcome");
		if (welcome.t !== "ctrl-welcome") throw new Error(`expected ctrl-welcome, got ${welcome.t}`);
		expect(welcome.readOnly).toBeUndefined();

		guest.socket.send({ t: "ctrl-list" });
		const sessionsFrame = await guest.nextFrame(f => f.t === "ctrl-sessions");
		if (sessionsFrame.t !== "ctrl-sessions") throw new Error(`expected ctrl-sessions, got ${sessionsFrame.t}`);
		expect(sessionsFrame.sessions).toHaveLength(1);
		const initial = sessionsFrame.sessions[0]!;
		expect(initial.id).toBe(INITIAL_SESSION_ID);
		expect(initial.running).toBe(true);
		expect(initial.streaming).toBe(false);
		// Full-control peers see the live deep link of the initial session.
		expect(initial.link).toBe(harness.initialHost.webLink);
	});

	it("archives first, then permanently deletes OMP-owned media without touching referenced source files", async () => {
		harness = await setupHarness();
		const sessionId = "disk-only-delete";
		const sessionFile = path.join(harness.sessionDir, "disk-only.jsonl");
		const artifactsDirectory = path.join(harness.sessionDir, "disk-only");
		const blobHash = "a".repeat(64);
		const mediaHash = "b".repeat(64);
		const blob = path.join(getBlobsDir(harness.agentDir), blobHash);
		const blobSidecar = `${blob}.png`;
		const media = path.join(
			getManagedMediaDir(harness.agentDir),
			"2026",
			"2026-08",
			mediaHash.slice(0, 2),
			`${mediaHash}.png`,
		);
		const referencedSource = path.join(harness.sessionDir, "referenced-source.png");
		await fs.mkdir(path.dirname(blob), { recursive: true });
		await fs.mkdir(path.dirname(media), { recursive: true });
		await fs.writeFile(blob, "blob");
		await fs.writeFile(blobSidecar, "sidecar");
		await fs.writeFile(media, "media");
		await fs.writeFile(referencedSource, "external source must survive");
		const old = new Date(Date.now() - 60 * 60_000);
		await fs.utimes(blob, old, old);
		await fs.utimes(blobSidecar, old, old);
		await fs.utimes(media, old, old);
		await fs.writeFile(
			sessionFile,
			[
				JSON.stringify({
					type: "session",
					id: sessionId,
					title: "Delete this chat",
					timestamp: new Date().toISOString(),
					cwd: INITIAL_SESSION_CWD,
				}),
				JSON.stringify({
					type: "custom_message",
					content: `blob:sha256:${blobHash}`,
					details: {
						localFiles: [
							{ kind: "local-file", path: media, name: path.basename(media) },
							{ kind: "local-file", path: referencedSource, name: path.basename(referencedSource) },
						],
					},
				}),
				"",
			].join("\n"),
		);
		await fs.mkdir(artifactsDirectory);
		await fs.writeFile(path.join(artifactsDirectory, "attachment.txt"), "delete with transcript");

		const guest = await joinRoom(harness.controlHost.webLink, "deleter", { ctrl: true });
		guestCleanups.push(() => guest.close());
		await guest.nextFrame(frame => frame.t === "ctrl-welcome");
		guest.socket.send({ t: "ctrl-archive", reqId: 60, id: sessionId });
		const archived = await guest.nextFrame(frame => frame.t === "ctrl-archived" && frame.reqId === 60);
		expect(archived.t).toBe("ctrl-archived");
		expect(
			await fs.stat(sessionFile).then(
				() => true,
				() => false,
			),
		).toBe(false);
		expect(
			await fs.stat(artifactsDirectory).then(
				() => true,
				() => false,
			),
		).toBe(false);
		expect(await Bun.file(blob).exists()).toBe(true);
		expect(await Bun.file(blobSidecar).exists()).toBe(true);
		expect(await Bun.file(media).exists()).toBe(true);
		expect(await Bun.file(referencedSource).exists()).toBe(true);
		expect((await harness.registry.list()).map(session => session.id)).not.toContain(sessionId);
		expect((await harness.registry.listArchivedSessions()).map(session => session.id)).toContain(sessionId);

		guest.socket.send({ t: "ctrl-delete-archived", reqId: 66, id: sessionId });
		const deleted = await guest.nextFrame(frame => frame.t === "ctrl-archived-deleted" && frame.reqId === 66);
		expect(deleted.t).toBe("ctrl-archived-deleted");
		expect(await harness.registry.listArchivedSessions()).toEqual([]);
		expect(await Bun.file(blob).exists()).toBe(false);
		expect(await Bun.file(blobSidecar).exists()).toBe(false);
		expect(await Bun.file(media).exists()).toBe(false);
		expect(await Bun.file(referencedSource).exists()).toBe(true);
	});

	it("refuses permanent deletion until a live session has been archived", async () => {
		harness = await setupHarness();
		const sessionFile = path.join(harness.sessionDir, "initial.jsonl");
		const artifactsDirectory = path.join(harness.sessionDir, "initial");
		await fs.mkdir(artifactsDirectory);
		await fs.writeFile(path.join(artifactsDirectory, "attachment.txt"), "delete with live session");

		const guest = await joinRoom(harness.controlHost.webLink, "live-deleter", { ctrl: true });
		guestCleanups.push(() => guest.close());
		await guest.nextFrame(frame => frame.t === "ctrl-welcome");
		guest.socket.send({ t: "ctrl-delete-archived", reqId: 64, id: INITIAL_SESSION_ID });
		const error = await guest.nextFrame(frame => frame.t === "ctrl-request-error" && frame.reqId === 64);
		expect(error.t).toBe("ctrl-request-error");
		expect((await harness.registry.list()).map(session => session.id)).toContain(INITIAL_SESSION_ID);
		expect(await Bun.file(sessionFile).exists()).toBe(true);
		expect(await Bun.file(path.join(artifactsDirectory, "attachment.txt")).exists()).toBe(true);
	});

	it("keeps a permanent archived deletion successful when post-delete media GC cannot scan another journal", async () => {
		harness = await setupHarness();
		const sessionId = "delete-despite-gc-error";
		const sessionFile = path.join(harness.sessionDir, "delete-despite-gc-error.jsonl");
		const blobHash = "c".repeat(64);
		const blob = path.join(getBlobsDir(harness.agentDir), blobHash);
		await fs.mkdir(path.dirname(blob), { recursive: true });
		await fs.writeFile(blob, "candidate");
		const old = new Date(Date.now() - 60 * 60_000);
		await fs.utimes(blob, old, old);
		await fs.writeFile(
			sessionFile,
			`${JSON.stringify({
				type: "session",
				id: sessionId,
				timestamp: new Date().toISOString(),
				cwd: INITIAL_SESSION_CWD,
			})}\n${JSON.stringify({ ref: `blob:sha256:${blobHash}` })}\n`,
		);
		const corruptArchive = path.join(getSessionsDir(harness.agentDir), "project", "corrupt.jsonl.gz");
		await fs.mkdir(path.dirname(corruptArchive), { recursive: true });
		await fs.writeFile(corruptArchive, "not gzip data");

		const guest = await joinRoom(harness.controlHost.webLink, "gc-error-deleter", { ctrl: true });
		guestCleanups.push(() => guest.close());
		await guest.nextFrame(frame => frame.t === "ctrl-welcome");
		guest.socket.send({ t: "ctrl-archive", reqId: 65, id: sessionId });
		await guest.nextFrame(frame => frame.t === "ctrl-archived" && frame.reqId === 65);
		guest.socket.send({ t: "ctrl-delete-archived", reqId: 67, id: sessionId });
		const deleted = await guest.nextFrame(frame => frame.t === "ctrl-archived-deleted" && frame.reqId === 67);

		expect(deleted.t).toBe("ctrl-archived-deleted");
		expect(await Bun.file(sessionFile).exists()).toBe(false);
		expect(await harness.registry.listArchivedSessions()).toEqual([]);
		// GC is intentionally best-effort after the transcript is gone. A later
		// healthy/manual pass can reclaim this still-safe candidate.
		expect(await Bun.file(blob).exists()).toBe(true);
	});

	it("archives a persisted chat with its artifacts and restores it to the active list", async () => {
		harness = await setupHarness();
		const sourcePath = path.join(harness.sessionDir, "initial.jsonl");
		const sourceArtifacts = path.join(harness.sessionDir, "initial");
		await fs.mkdir(sourceArtifacts);
		await fs.writeFile(path.join(sourceArtifacts, "attachment.txt"), "kept with chat");

		const guest = await joinRoom(harness.controlHost.webLink, "archiver", { ctrl: true });
		guestCleanups.push(() => guest.close());
		await guest.nextFrame(frame => frame.t === "ctrl-welcome");

		guest.socket.send({ t: "ctrl-archive", reqId: 61, id: INITIAL_SESSION_ID });
		const archivedReply = await guest.nextFrame(frame => frame.t === "ctrl-archived" && frame.reqId === 61);
		if (archivedReply.t !== "ctrl-archived") throw new Error(`expected ctrl-archived, got ${archivedReply.t}`);
		expect(archivedReply.id).toBe(INITIAL_SESSION_ID);
		expect(
			await fs.stat(sourcePath).then(
				() => true,
				() => false,
			),
		).toBe(false);
		expect(
			await fs.stat(sourceArtifacts).then(
				() => true,
				() => false,
			),
		).toBe(false);

		guest.socket.send({ t: "ctrl-archived-list", reqId: 62 });
		const archivedList = await guest.nextFrame(frame => frame.t === "ctrl-archived-list" && frame.reqId === 62);
		if (archivedList.t !== "ctrl-archived-list" || !("sessions" in archivedList)) {
			throw new Error(`expected ctrl-archived-list, got ${archivedList.t}`);
		}
		expect(archivedList.sessions.map(session => session.id)).toEqual([INITIAL_SESSION_ID]);
		const archivedFiles = await Array.fromAsync(
			new Bun.Glob("*/*.jsonl").scan(path.join(harness.sessionDir, "agent", "archived_sessions")),
		);
		expect(archivedFiles).toHaveLength(1);
		const archivedPath = path.join(harness.sessionDir, "agent", "archived_sessions", archivedFiles[0]!);
		expect(await fs.readFile(path.join(archivedPath.slice(0, -6), "attachment.txt"), "utf8")).toBe("kept with chat");

		guest.socket.send({ t: "ctrl-restore", reqId: 63, id: INITIAL_SESSION_ID });
		const restored = await guest.nextFrame(frame => frame.t === "ctrl-restored" && frame.reqId === 63);
		if (restored.t !== "ctrl-restored") throw new Error(`expected ctrl-restored, got ${restored.t}`);
		expect(restored.session).toMatchObject({ id: INITIAL_SESSION_ID, running: false, streaming: false });
		expect(await harness.registry.listArchivedSessions()).toEqual([]);
		const active = await harness.registry.list();
		expect(active.map(session => session.id)).toContain(INITIAL_SESSION_ID);
		const restoredFiles = await Array.fromAsync(
			new Bun.Glob("*/*.jsonl").scan(path.join(harness.sessionDir, "agent", "sessions")),
		);
		const restoredPath = path.join(harness.sessionDir, "agent", "sessions", restoredFiles[0]!);
		expect(await fs.readFile(path.join(restoredPath.slice(0, -6), "attachment.txt"), "utf8")).toBe("kept with chat");
	});

	it("lists and imports a Codex conversation into its original project with a fresh OMP id", async () => {
		harness = await setupHarness();
		const { created } = spyOnCreateAgentSession();
		const sourceProject = await fs.mkdtemp(path.join(harness.sessionDir, "codex-project-"));
		const sourcePath = path.join(harness.sessionDir, "codex-rollout.jsonl");
		await fs.writeFile(sourcePath, "source stays untouched\n");
		const source: ForeignSessionInfo = {
			source: "codex",
			id: "codex-source-id",
			path: sourcePath,
			cwd: sourceProject,
			title: "Imported from Codex",
			description: "Inspect the project and preserve its context",
			archived: true,
			created: new Date("2026-08-01T00:00:00.000Z"),
			modified: new Date("2026-08-02T00:00:00.000Z"),
			firstMessage: "Inspect the project",
			messageCount: 1,
		};
		vi.spyOn(CodexSessionStore.prototype, "list").mockResolvedValue([source]);
		vi.spyOn(CodexSessionStore.prototype, "load").mockImplementation(async info => {
			const manager = SessionManager.inMemory(info.cwd);
			manager.ingestReplicatedEntry({
				type: "message",
				id: "codex-user-1",
				parentId: null,
				timestamp: "2026-08-01T00:00:00.000Z",
				message: { role: "user", content: "Inspect the project", timestamp: 1_754_006_400_000 },
			});
			await manager.setSessionName(info.title ?? "Imported from Codex");
			return manager;
		});

		const guest = await joinRoom(harness.controlHost.webLink, "importer", { ctrl: true });
		guestCleanups.push(() => guest.close());
		await guest.nextFrame(f => f.t === "ctrl-welcome");

		guest.socket.send({ t: "ctrl-import-list", reqId: 51, source: "codex", archived: true });
		const listed = await guest.nextFrame(f => f.t === "ctrl-import-list" && f.reqId === 51);
		if (listed.t !== "ctrl-import-list" || !("sessions" in listed)) {
			throw new Error(`expected ctrl-import-list response, got ${listed.t}`);
		}
		expect(listed.sessions).toEqual([
			{
				source: "codex",
				id: source.id,
				path: source.path,
				cwd: source.cwd,
				title: source.title,
				description: source.description,
				archived: true,
				createdAt: source.created.toISOString(),
				modifiedAt: source.modified.toISOString(),
				messageCount: 1,
				firstMessage: source.firstMessage,
			},
		]);

		guest.socket.send({
			t: "ctrl-import",
			reqId: 52,
			source: "codex",
			id: source.id,
			path: source.path,
			archived: true,
		});
		const imported = await guest.nextFrame(f => f.t === "ctrl-imported" && f.reqId === 52);
		if (imported.t !== "ctrl-imported") throw new Error(`expected ctrl-imported, got ${imported.t}`);
		expect(imported.session.id).not.toBe(source.id);
		expect(imported.session).toMatchObject({
			cwd: sourceProject,
			title: "Imported from Codex",
			requiresProjectSwitch: false,
		});
		expect(created).toHaveLength(1);
		expect(created[0]?.session.sessionManager.getCwd()).toBe(sourceProject);
		const targetDir = SessionManager.getDefaultSessionDir(sourceProject, path.join(harness.sessionDir, "agent"));
		let targetFiles = await fs.readdir(targetDir);
		expect(targetFiles.some(file => file.includes(imported.session.id) && file.endsWith(".jsonl"))).toBe(true);

		// Reproduce the old bug's on-disk state: the same Codex source was copied
		// under a second OMP id. A new import must retain the original id and move
		// the redundant copy out of the active sidebar instead of making a third.
		const duplicate = await created[0]!.session.sessionManager.persistCopy({
			sessionDir: targetDir,
			suppressBreadcrumb: true,
		});
		const duplicateId = duplicate.getSessionId();
		await duplicate.close();
		guest.socket.send({
			t: "ctrl-import",
			reqId: 53,
			source: "codex",
			id: source.id,
			path: source.path,
			archived: true,
		});
		const refreshed = await guest.nextFrame(f => f.t === "ctrl-imported" && f.reqId === 53);
		if (refreshed.t !== "ctrl-imported") throw new Error(`expected ctrl-imported, got ${refreshed.t}`);
		expect(refreshed.session.id).toBe(imported.session.id);
		targetFiles = await fs.readdir(targetDir);
		expect(targetFiles.filter(file => file.endsWith(".jsonl"))).toHaveLength(1);
		expect((await harness.registry.listArchivedSessions()).map(session => session.id)).toContain(duplicateId);
		expect(created).toHaveLength(2);
		expect(await fs.readFile(sourcePath, "utf8")).toBe("source stays untouched\n");

		guest.socket.send({ t: "ctrl-resume", id: imported.session.id });
		const resumed = await guest.nextFrame(
			frame => frame.t === "ctrl-session" && frame.op === "resumed" && frame.id === imported.session.id,
		);
		if (resumed.t !== "ctrl-session") throw new Error(`expected ctrl-session, got ${resumed.t}`);
		expect(resumed.link).toBeString();
	});

	it("requires confirmation before merging an OMP continuation and keeps one chronological chat", async () => {
		harness = await setupHarness();
		const { created } = spyOnCreateAgentSession();
		const sourceProject = await fs.mkdtemp(path.join(harness.sessionDir, "codex-merge-project-"));
		const sourcePath = path.join(harness.sessionDir, "codex-merge-rollout.jsonl");
		await fs.writeFile(sourcePath, "source stays untouched\n");
		const source: ForeignSessionInfo = {
			source: "codex",
			id: "codex-merge-source-id",
			path: sourcePath,
			cwd: sourceProject,
			title: "Merged Codex chat",
			archived: false,
			created: new Date("2026-08-01T00:00:00.000Z"),
			modified: new Date("2026-08-03T00:00:00.000Z"),
		};
		let sourceRevision = 1;
		vi.spyOn(CodexSessionStore.prototype, "list").mockResolvedValue([source]);
		vi.spyOn(CodexSessionStore.prototype, "load").mockImplementation(async info => {
			const manager = SessionManager.inMemory(info.cwd);
			manager.ingestReplicatedEntry({
				type: "message",
				id: "codex-user-1",
				parentId: null,
				timestamp: "2026-08-01T00:00:00.000Z",
				message: { role: "user", content: "Codex first", timestamp: Date.parse("2026-08-01T00:00:00.000Z") },
			});
			const branchTimestamp = sourceRevision >= 2 ? "2026-08-03T00:00:00.000Z" : "2026-08-01T12:00:00.000Z";
			manager.ingestReplicatedEntry({
				type: "message",
				// CodexSessionStore currently derives ids from converted ordinals.
				// After a rollback, the same id can legitimately identify a new
				// replacement entry; the merge must retain both branch histories.
				id: "codex-user-branch",
				parentId: "codex-user-1",
				timestamp: branchTimestamp,
				message: {
					role: "user",
					content: sourceRevision >= 2 ? "Codex replacement branch" : "Codex original branch",
					timestamp: Date.parse(branchTimestamp),
				},
			});
			await manager.setSessionName(info.title ?? "Merged Codex chat");
			return manager;
		});

		const first = await harness.registry.importForeignSession("codex", source.id, source.path, false);
		if ("kind" in first) throw new Error("first import unexpectedly conflicted");
		created.at(-1)!.session.sessionManager.ingestReplicatedEntry({
			type: "message",
			id: "omp-user-1",
			parentId: created.at(-1)!.session.sessionManager.getLeafId(),
			timestamp: "2026-08-02T00:00:00.000Z",
			message: { role: "user", content: "OMP continuation", timestamp: Date.parse("2026-08-02T00:00:00.000Z") },
		});
		sourceRevision = 2;

		const conflict = await harness.registry.importForeignSession("codex", source.id, source.path, false);
		expect(conflict).toMatchObject({
			kind: "conflict",
			existingSessionId: first.id,
			duplicateCount: 1,
			localMessageCount: 1,
		});

		const merged = await harness.registry.importForeignSession("codex", source.id, source.path, false, true);
		if ("kind" in merged) throw new Error("confirmed merge still conflicted");
		expect(merged.id).toBe(first.id);
		const messages = created
			.at(-1)!
			.session.sessionManager.getEntries()
			.filter(entry => entry.type === "message" && entry.message.role === "user")
			.map(entry => {
				if (entry.type !== "message" || entry.message.role !== "user") return "";
				return typeof entry.message.content === "string" ? entry.message.content : "";
			});
		expect(messages).toEqual([
			"Codex first",
			"Codex original branch",
			"OMP continuation",
			"Codex replacement branch",
		]);
		expect((await harness.registry.list()).filter(session => session.id === first.id)).toHaveLength(1);
	});

	it("re-resolves a Codex conversation that was archived while the picker was open", async () => {
		harness = await setupHarness();
		spyOnCreateAgentSession();
		const sourceProject = await fs.mkdtemp(path.join(harness.sessionDir, "codex-moved-project-"));
		const oldSourcePath = path.join(harness.sessionDir, "sessions", "codex-moved.jsonl");
		const archivedSourcePath = path.join(harness.sessionDir, "archived_sessions", "codex-moved.jsonl");
		await fs.mkdir(path.dirname(archivedSourcePath), { recursive: true });
		await fs.writeFile(archivedSourcePath, "source stays untouched\n");
		const source: ForeignSessionInfo = {
			source: "codex",
			id: "codex-moved-source-id",
			path: archivedSourcePath,
			cwd: sourceProject,
			title: "Moved to archive",
			archived: true,
			created: new Date("2026-08-01T00:00:00.000Z"),
			modified: new Date("2026-08-02T00:00:00.000Z"),
		};
		const listSpy = vi
			.spyOn(CodexSessionStore.prototype, "list")
			.mockImplementation(async options => (options?.archived ? [source] : []));
		vi.spyOn(CodexSessionStore.prototype, "load").mockImplementation(async info => {
			const manager = SessionManager.inMemory(info.cwd);
			manager.ingestReplicatedEntry({
				type: "message",
				id: "codex-user-moved",
				parentId: null,
				timestamp: "2026-08-01T00:00:00.000Z",
				message: { role: "user", content: "Archive this", timestamp: 1_754_006_400_000 },
			});
			await manager.setSessionName(info.title ?? "Moved to archive");
			return manager;
		});

		const imported = await harness.registry.importForeignSession("codex", source.id, oldSourcePath, false);

		expect(imported.title).toBe("Moved to archive");
		expect(listSpy).toHaveBeenCalledWith({ archived: false });
		expect(listSpy).toHaveBeenCalledWith({ archived: true });
	});

	it("serializes concurrent imports of the same Codex conversation under one OMP id", async () => {
		harness = await setupHarness();
		spyOnCreateAgentSession();
		const sourceProject = await fs.mkdtemp(path.join(harness.sessionDir, "codex-concurrent-project-"));
		const sourcePath = path.join(harness.sessionDir, "codex-concurrent-rollout.jsonl");
		await fs.writeFile(sourcePath, "source stays untouched\n");
		const source: ForeignSessionInfo = {
			source: "codex",
			id: "codex-concurrent-source-id",
			path: sourcePath,
			cwd: sourceProject,
			title: "Concurrent import",
			archived: false,
			created: new Date("2026-08-01T00:00:00.000Z"),
			modified: new Date("2026-08-02T00:00:00.000Z"),
		};
		vi.spyOn(CodexSessionStore.prototype, "list").mockResolvedValue([source]);
		vi.spyOn(CodexSessionStore.prototype, "load").mockImplementation(async info => {
			await Bun.sleep(25);
			return await importedCodexManager(info);
		});

		const [left, right] = await Promise.all([
			harness.registry.importForeignSession("codex", source.id, source.path, false),
			harness.registry.importForeignSession("codex", source.id, source.path, false),
		]);
		if ("kind" in left || "kind" in right) throw new Error("concurrent imports unexpectedly conflicted");

		expect(right.id).toBe(left.id);
		expect((await harness.registry.list()).filter(session => session.title === source.title)).toHaveLength(1);
		const targetDir = SessionManager.getDefaultSessionDir(sourceProject, harness.agentDir);
		expect((await fs.readdir(targetDir)).filter(file => file.endsWith(".jsonl"))).toHaveLength(1);
	});

	it("reactivates the original OMP chat when an archived import is imported again", async () => {
		harness = await setupHarness();
		spyOnCreateAgentSession();
		const sourceProject = await fs.mkdtemp(path.join(harness.sessionDir, "codex-omp-archived-project-"));
		const sourcePath = path.join(harness.sessionDir, "codex-omp-archived-rollout.jsonl");
		await fs.writeFile(sourcePath, "source stays untouched\n");
		const source: ForeignSessionInfo = {
			source: "codex",
			id: "codex-omp-archived-source-id",
			path: sourcePath,
			cwd: sourceProject,
			title: "Archived OMP import",
			archived: false,
			created: new Date("2026-08-01T00:00:00.000Z"),
			modified: new Date("2026-08-02T00:00:00.000Z"),
		};
		vi.spyOn(CodexSessionStore.prototype, "list").mockResolvedValue([source]);
		vi.spyOn(CodexSessionStore.prototype, "load").mockImplementation(info => importedCodexManager(info));

		const first = await harness.registry.importForeignSession("codex", source.id, source.path, false);
		if ("kind" in first) throw new Error("first import unexpectedly conflicted");
		await harness.registry.archiveSession(first.id);
		expect((await harness.registry.listArchivedSessions()).map(session => session.id)).toContain(first.id);

		const importedAgain = await harness.registry.importForeignSession("codex", source.id, source.path, false);
		if ("kind" in importedAgain) throw new Error("archived re-import unexpectedly conflicted");

		expect(importedAgain.id).toBe(first.id);
		expect((await harness.registry.listArchivedSessions()).map(session => session.id)).not.toContain(first.id);
		expect((await harness.registry.list()).filter(session => session.id === first.id)).toHaveLength(1);
	});

	it("keeps the existing imported chat live when refreshing the Codex rollout fails", async () => {
		harness = await setupHarness();
		spyOnCreateAgentSession();
		const sourceProject = await fs.mkdtemp(path.join(harness.sessionDir, "codex-refresh-failure-project-"));
		const sourcePath = path.join(harness.sessionDir, "codex-refresh-failure-rollout.jsonl");
		await fs.writeFile(sourcePath, "source stays untouched\n");
		const source: ForeignSessionInfo = {
			source: "codex",
			id: "codex-refresh-failure-source-id",
			path: sourcePath,
			cwd: sourceProject,
			title: "Refresh failure",
			archived: false,
			created: new Date("2026-08-01T00:00:00.000Z"),
			modified: new Date("2026-08-02T00:00:00.000Z"),
		};
		let failRefresh = false;
		vi.spyOn(CodexSessionStore.prototype, "list").mockResolvedValue([source]);
		vi.spyOn(CodexSessionStore.prototype, "load").mockImplementation(async info => {
			if (failRefresh) throw new Error("rollout became unreadable");
			return await importedCodexManager(info);
		});

		const first = await harness.registry.importForeignSession("codex", source.id, source.path, false);
		if ("kind" in first) throw new Error("first import unexpectedly conflicted");
		failRefresh = true;

		await expect(harness.registry.importForeignSession("codex", source.id, source.path, false)).rejects.toThrow(
			"rollout became unreadable",
		);
		expect((await harness.registry.list()).find(session => session.id === first.id)?.running).toBe(true);
	});

	it("rejects refresh when the original project disappeared without stopping the existing chat", async () => {
		harness = await setupHarness();
		spyOnCreateAgentSession();
		const sourceProject = await fs.mkdtemp(path.join(harness.sessionDir, "codex-missing-refresh-project-"));
		const sourcePath = path.join(harness.sessionDir, "codex-missing-refresh-rollout.jsonl");
		await fs.writeFile(sourcePath, "source stays untouched\n");
		const source: ForeignSessionInfo = {
			source: "codex",
			id: "codex-missing-refresh-source-id",
			path: sourcePath,
			cwd: sourceProject,
			title: "Missing project refresh",
			archived: false,
			created: new Date("2026-08-01T00:00:00.000Z"),
			modified: new Date("2026-08-02T00:00:00.000Z"),
		};
		vi.spyOn(CodexSessionStore.prototype, "list").mockResolvedValue([source]);
		vi.spyOn(CodexSessionStore.prototype, "load").mockImplementation(info => importedCodexManager(info));

		const first = await harness.registry.importForeignSession("codex", source.id, source.path, false);
		if ("kind" in first) throw new Error("first import unexpectedly conflicted");
		await fs.rm(sourceProject, { recursive: true, force: true });

		await expect(harness.registry.importForeignSession("codex", source.id, source.path, false)).rejects.toThrow(
			"original Codex project folder is no longer available",
		);
		expect((await harness.registry.list()).find(session => session.id === first.id)?.running).toBe(true);
	});

	it("uses the rollout header cwd when the Codex index still points at the previous project", async () => {
		harness = await setupHarness();
		spyOnCreateAgentSession();
		const indexedProject = await fs.mkdtemp(path.join(harness.sessionDir, "codex-indexed-project-"));
		const relocatedProject = await fs.mkdtemp(path.join(harness.sessionDir, "codex-relocated-project-"));
		const sourcePath = path.join(harness.sessionDir, "codex-relocated-rollout.jsonl");
		await fs.writeFile(sourcePath, "source stays untouched\n");
		const source: ForeignSessionInfo = {
			source: "codex",
			id: "codex-relocated-source-id",
			path: sourcePath,
			cwd: indexedProject,
			title: "Relocated project",
			archived: false,
			created: new Date("2026-08-01T00:00:00.000Z"),
			modified: new Date("2026-08-02T00:00:00.000Z"),
		};
		let rolloutCwd = indexedProject;
		vi.spyOn(CodexSessionStore.prototype, "list").mockResolvedValue([source]);
		vi.spyOn(CodexSessionStore.prototype, "load").mockImplementation(info =>
			importedCodexManager({ ...info, cwd: rolloutCwd }),
		);

		const first = await harness.registry.importForeignSession("codex", source.id, source.path, false);
		if ("kind" in first) throw new Error("first import unexpectedly conflicted");
		rolloutCwd = relocatedProject;

		const refreshed = await harness.registry.importForeignSession("codex", source.id, source.path, false);
		if ("kind" in refreshed) throw new Error("relocated refresh unexpectedly conflicted");
		expect(refreshed).toMatchObject({ id: first.id, cwd: relocatedProject });
		expect((await harness.registry.list()).find(session => session.id === first.id)?.cwd).toBe(relocatedProject);
	});

	it("removes the persisted copy when provisioning an imported chat fails", async () => {
		harness = await setupHarness();
		const sourceProject = await fs.mkdtemp(path.join(harness.sessionDir, "codex-failed-project-"));
		const sourcePath = path.join(harness.sessionDir, "codex-failed-rollout.jsonl");
		await fs.writeFile(sourcePath, "source stays untouched\n");
		const source: ForeignSessionInfo = {
			source: "codex",
			id: "codex-failed-source-id",
			path: sourcePath,
			cwd: sourceProject,
			title: "Provision failure",
			archived: false,
			created: new Date("2026-08-01T00:00:00.000Z"),
			modified: new Date("2026-08-02T00:00:00.000Z"),
		};
		vi.spyOn(CodexSessionStore.prototype, "list").mockResolvedValue([source]);
		vi.spyOn(CodexSessionStore.prototype, "load").mockImplementation(async info => {
			const manager = SessionManager.inMemory(info.cwd);
			manager.ingestReplicatedEntry({
				type: "message",
				id: "codex-user-failed",
				parentId: null,
				timestamp: "2026-08-01T00:00:00.000Z",
				message: { role: "user", content: "Import me", timestamp: 1_754_006_400_000 },
			});
			await manager.setSessionName(info.title ?? "Provision failure");
			return manager;
		});
		vi.spyOn(sdk, "createAgentSession").mockRejectedValue(new Error("provision failed"));

		await expect(harness.registry.importForeignSession("codex", source.id, source.path, false)).rejects.toThrow(
			"provision failed",
		);

		const targetDir = SessionManager.getDefaultSessionDir(sourceProject, path.join(harness.sessionDir, "agent"));
		const targetFiles = await fs.readdir(targetDir).catch(() => []);
		expect(targetFiles.filter(file => file.endsWith(".jsonl"))).toEqual([]);
		expect(await fs.readFile(sourcePath, "utf8")).toBe("source stays untouched\n");
	});

	it("lists and resumes a persisted session from another project without restarting the core", async () => {
		harness = await setupHarness();
		const { created } = spyOnCreateAgentSession();
		const otherProject = await fs.mkdtemp(path.join(harness.sessionDir, "existing-project-"));
		const otherSessionDir = SessionManager.getDefaultSessionDir(otherProject, path.join(harness.sessionDir, "agent"));
		const otherSessionId = "existing-cross-project-session";
		const otherSessionPath = path.join(otherSessionDir, `2026-08-16T00-00-00-000Z_${otherSessionId}.jsonl`);
		await fs.writeFile(
			otherSessionPath,
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: otherSessionId,
				timestamp: "2026-08-16T00:00:00.000Z",
				cwd: otherProject,
				title: "Existing imported chat",
			})}\n`,
		);

		const listed = await harness.registry.list();
		expect(listed.find(session => session.id === otherSessionId)).toMatchObject({
			cwd: otherProject,
			title: "Existing imported chat",
			running: false,
		});
		await harness.registry.renameSession(otherSessionId, "Renamed cross-project chat");
		expect((await harness.registry.list()).find(session => session.id === otherSessionId)?.title).toBe(
			"Renamed cross-project chat",
		);

		const resumed = await harness.registry.resumeSession(otherSessionId);
		expect(resumed.id).toBe(otherSessionId);
		expect(resumed.link).toBeString();
		expect(created).toHaveLength(1);
		expect(created[0]?.session.sessionManager.getCwd()).toBe(otherProject);
	});

	it("does not show a disk-only session whose project directory no longer exists", async () => {
		harness = await setupHarness();
		const removedProject = await fs.mkdtemp(path.join(harness.sessionDir, "removed-project-"));
		const removedSessionDir = SessionManager.getDefaultSessionDir(
			removedProject,
			path.join(harness.sessionDir, "agent"),
		);
		const removedSessionId = "removed-project-session";
		const removedSessionPath = path.join(removedSessionDir, `2026-08-16T00-00-00-000Z_${removedSessionId}.jsonl`);
		await fs.writeFile(
			removedSessionPath,
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: removedSessionId,
				timestamp: "2026-08-16T00:00:00.000Z",
				cwd: removedProject,
				title: "Stale temporary chat",
			})}\n`,
		);
		await fs.rm(removedProject, { recursive: true, force: true });

		const listed = await harness.registry.list();
		expect(listed.some(session => session.id === removedSessionId)).toBe(false);
	});

	it("keeps an untitled draft out of the sidebar until its first message persists", async () => {
		harness = await setupHarness(false);

		expect(await harness.registry.list()).toEqual([]);

		await harness.persistInitialMessage();
		const sessions = await harness.registry.list();
		expect(sessions).toHaveLength(1);
		expect(sessions[0]?.id).toBe(INITIAL_SESSION_ID);
		expect(sessions[0]?.messageCount).toBe(1);
	});

	it("creates a session through the control room and its link serves a live session room", async () => {
		harness = await setupHarness();
		const { created } = spyOnCreateAgentSession();

		const guest = await joinRoom(harness.controlHost.webLink, "creator", { ctrl: true });
		guestCleanups.push(() => guest.close());
		await guest.nextFrame(f => f.t === "ctrl-welcome");

		guest.socket.send({ t: "ctrl-create" });
		const createdFrame = await guest.nextFrame(f => f.t === "ctrl-session");
		if (createdFrame.t !== "ctrl-session") throw new Error(`expected ctrl-session, got ${createdFrame.t}`);
		expect(createdFrame.op).toBe("created");
		expect(created).toHaveLength(1);
		expect(createdFrame.id).toBe(created[0]!.id);
		expect(createdFrame.link).toContain("ws://");

		// The created link must hand a plain guest a real session room.
		const sessionGuest = await joinRoom(createdFrame.link, "joiner");
		guestCleanups.push(() => sessionGuest.close());
		const sessionWelcome = await sessionGuest.nextFrame(f => f.t === "welcome");
		if (sessionWelcome.t !== "welcome") throw new Error(`expected welcome, got ${sessionWelcome.t}`);
		expect(sessionWelcome.readOnly).toBeUndefined();
	});

	it("creates a session in the project selected by the control-room client", async () => {
		harness = await setupHarness();
		const { created } = spyOnCreateAgentSession();
		const selectedProject = await fs.mkdtemp(path.join(harness.sessionDir, "selected-project-"));

		const guest = await joinRoom(harness.controlHost.webLink, "project-creator", { ctrl: true });
		guestCleanups.push(() => guest.close());
		await guest.nextFrame(frame => frame.t === "ctrl-welcome");

		guest.socket.send({ t: "ctrl-create", cwd: selectedProject });
		const reply = await guest.nextFrame(frame => frame.t === "ctrl-session" && frame.op === "created");
		if (reply.t !== "ctrl-session") throw new Error(`expected ctrl-session, got ${reply.t}`);
		expect(created).toHaveLength(1);
		const manager = created[0]?.session.sessionManager;
		expect(manager?.getCwd()).toBe(path.resolve(selectedProject));
		expect(manager?.getSessionDir()).toBe(
			SessionManager.getDefaultSessionDir(path.resolve(selectedProject), path.join(harness.sessionDir, "agent")),
		);
	});

	it("rejects a create request for a missing project without leaking a live session", async () => {
		harness = await setupHarness();
		const { created } = spyOnCreateAgentSession();
		const missingProject = path.join(harness.sessionDir, "missing-project");

		const guest = await joinRoom(harness.controlHost.webLink, "missing-project-creator", { ctrl: true });
		guestCleanups.push(() => guest.close());
		await guest.nextFrame(frame => frame.t === "ctrl-welcome");

		guest.socket.send({ t: "ctrl-create", cwd: missingProject });
		const error = await guest.nextFrame(frame => frame.t === "ctrl-error");
		if (error.t !== "ctrl-error") throw new Error(`expected ctrl-error, got ${error.t}`);
		expect(error.message).toContain("project directory is not available");
		expect(created).toEqual([]);
		expect((await harness.registry.list()).map(session => session.id)).toEqual([INITIAL_SESSION_ID]);
	});

	it("resumes an active session with its live link and errors for unknown ids", async () => {
		harness = await setupHarness();
		const guest = await joinRoom(harness.controlHost.webLink, "resumer", { ctrl: true });
		guestCleanups.push(() => guest.close());
		await guest.nextFrame(f => f.t === "ctrl-welcome");
		// A fresh active session can be listed before its first JSONL append.
		// Removing the fixture proves resume checks the live registry before disk.
		await fs.rm(path.join(harness.sessionDir, "initial.jsonl"));

		// Active session: resume must hand back the live link, not reload the JSONL.
		guest.socket.send({ t: "ctrl-resume", id: INITIAL_SESSION_ID });
		const resumed = await guest.nextFrame(f => f.t === "ctrl-session");
		if (resumed.t !== "ctrl-session") throw new Error(`expected ctrl-session, got ${resumed.t}`);
		expect(resumed.op).toBe("resumed");
		expect(resumed.id).toBe(INITIAL_SESSION_ID);
		expect(resumed.link).toBe(harness.initialHost.webLink);

		guest.socket.send({ t: "ctrl-resume", id: "no-such-session" });
		const err = await guest.nextFrame(f => f.t === "ctrl-error");
		if (err.t !== "ctrl-error") throw new Error(`expected ctrl-error, got ${err.t}`);
		expect(err.message).toContain("no such session");
	});

	it("renames an active session through the control room and persists the JSONL title", async () => {
		harness = await setupHarness();
		const guest = await joinRoom(harness.controlHost.webLink, "renamer", { ctrl: true });
		guestCleanups.push(() => guest.close());
		await guest.nextFrame(f => f.t === "ctrl-welcome");

		guest.socket.send({ t: "ctrl-rename", id: INITIAL_SESSION_ID, title: "Renamed conversation" });
		const sessionsFrame = await guest.nextFrame(
			f => f.t === "ctrl-sessions" && f.sessions.some(session => session.title === "Renamed conversation"),
		);
		if (sessionsFrame.t !== "ctrl-sessions") throw new Error(`expected ctrl-sessions, got ${sessionsFrame.t}`);
		expect(sessionsFrame.sessions[0]?.title).toBe("Renamed conversation");
		const stored = await fs.readFile(path.join(harness.sessionDir, "initial.jsonl"), "utf8");
		expect(stored).toContain('"title":"Renamed conversation"');
	});

	it("treats guests without the write token as read-only and strips session links", async () => {
		harness = await setupHarness();
		const guest = await joinRoom(harness.controlHost.webLink, "viewer", { ctrl: true, writeToken: null });
		guestCleanups.push(() => guest.close());

		const welcome = await guest.nextFrame(f => f.t === "ctrl-welcome");
		if (welcome.t !== "ctrl-welcome") throw new Error(`expected ctrl-welcome, got ${welcome.t}`);
		expect(welcome.readOnly).toBe(true);

		guest.socket.send({ t: "ctrl-create" });
		const err = await guest.nextFrame(f => f.t === "ctrl-error");
		if (err.t !== "ctrl-error") throw new Error(`expected ctrl-error, got ${err.t}`);
		expect(err.message).toBe("read-only");

		guest.socket.send({ t: "ctrl-rename", id: INITIAL_SESSION_ID, title: "Forbidden rename" });
		const renameErr = await guest.nextFrame(f => f.t === "ctrl-error");
		if (renameErr.t !== "ctrl-error") throw new Error(`expected ctrl-error, got ${renameErr.t}`);
		expect(renameErr.message).toBe("read-only");

		guest.socket.send({ t: "ctrl-import-list", reqId: 41, source: "codex", archived: false });
		const importListErr = await guest.nextFrame(f => f.t === "ctrl-request-error" && f.reqId === 41);
		if (importListErr.t !== "ctrl-request-error") {
			throw new Error(`expected ctrl-request-error, got ${importListErr.t}`);
		}
		expect(importListErr.message).toBe("read-only");

		guest.socket.send({
			t: "ctrl-import",
			reqId: 42,
			source: "codex",
			id: "forbidden-session",
			path: "C:\\codex\\forbidden.jsonl",
			archived: false,
		});
		const importErr = await guest.nextFrame(f => f.t === "ctrl-request-error" && f.reqId === 42);
		if (importErr.t !== "ctrl-request-error") throw new Error(`expected ctrl-request-error, got ${importErr.t}`);
		expect(importErr.message).toBe("read-only");

		guest.socket.send({ t: "ctrl-list" });
		const sessionsFrame = await guest.nextFrame(f => f.t === "ctrl-sessions");
		if (sessionsFrame.t !== "ctrl-sessions") throw new Error(`expected ctrl-sessions, got ${sessionsFrame.t}`);
		expect(sessionsFrame.sessions).toHaveLength(1);
		// `link` never survives JSON serialization for read-only peers.
		expect(sessionsFrame.sessions[0]!.link).toBeUndefined();
	});

	it("does not expose or accept control over other sessions' agents", async () => {
		harness = await setupHarness();
		const guest = await joinRoom(harness.initialHost.link, "observer");
		guestCleanups.push(() => guest.close());
		const welcome = await guest.nextFrame(f => f.t === "welcome");
		if (welcome.t !== "welcome") throw new Error(`expected welcome, got ${welcome.t}`);

		// An agent registered under a different session scope (multi-session
		// core registers every session in the shared process-wide registry).
		const foreignSession = { abort: async () => {}, dispose: async () => {} } as unknown as AgentSession;
		const ref = AgentRegistry.global().register({
			id: OTHER_AGENT_ID,
			displayName: "other session agent",
			kind: "sub",
			scopeId: OTHER_SCOPE_ID,
			session: foreignSession,
			sessionFile: null,
			status: "idle",
		});
		try {
			guest.socket.send({ t: "agent-cmd", cmd: "chat", agentId: OTHER_AGENT_ID, text: "hi" });
			const cmdReply = await guest.nextFrame(f => f.t === "error");
			if (cmdReply.t !== "error") throw new Error(`expected error, got ${cmdReply.t}`);
			expect(cmdReply.message).toBe("agent not in this session");

			guest.socket.send({ t: "fetch-transcript", reqId: 7, agentId: OTHER_AGENT_ID, fromByte: 0 });
			const transcript = await guest.nextFrame(f => f.t === "transcript");
			if (transcript.t !== "transcript") throw new Error(`expected transcript, got ${transcript.t}`);
			expect(transcript.reqId).toBe(7);
			expect(transcript.text).toBe("");
			expect(transcript.newSize).toBe(0);
			expect(transcript.error).toBe("no transcript available");

			// The debounced agents broadcast never mirrors the foreign ref.
			const agents = await guest.nextFrame(f => f.t === "agents");
			if (agents.t !== "agents") throw new Error(`expected agents, got ${agents.t}`);
			expect(agents.agents.map(agent => agent.id)).not.toContain(OTHER_AGENT_ID);
		} finally {
			AgentRegistry.global().unregister(OTHER_AGENT_ID, ref);
		}
	});

	it("reports ctrl-error when session creation fails and leaks no entry", async () => {
		harness = await setupHarness();
		const failedIds: string[] = [];
		vi.spyOn(sdk, "createAgentSession").mockImplementation(async options => {
			if (!options) throw new Error("test spy: expected registry-injected options");
			const manager = options.sessionManager;
			if (!manager) throw new Error("test spy: expected a registry-injected sessionManager");
			failedIds.push(manager.getSessionId());
			throw new Error("provider unavailable");
		});

		const guest = await joinRoom(harness.controlHost.webLink, "creator", { ctrl: true });
		guestCleanups.push(() => guest.close());
		await guest.nextFrame(f => f.t === "ctrl-welcome");

		guest.socket.send({ t: "ctrl-create" });
		const err = await guest.nextFrame(f => f.t === "ctrl-error");
		if (err.t !== "ctrl-error") throw new Error(`expected ctrl-error, got ${err.t}`);
		expect(err.message).toContain("provider unavailable");
		expect(failedIds).toHaveLength(1);

		// No leaked entry: the failed session never registers and lazy
		// persistence means no JSONL was materialized for it either — the
		// list still shows only the initial session.
		const sessions = await harness.registry.list();
		expect(sessions.map(s => s.id)).toEqual([INITIAL_SESSION_ID]);
	});
});
