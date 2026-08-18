/**
 * Process-wide session registry for core mode.
 *
 * Owns every concurrent {@link ManagedSession} in the process — the initial
 * session adopted at startup plus sessions created or resumed through the
 * control room — and answers list/create/resume/drop queries from a single
 * in-memory table merged with the on-disk session directory. Concurrency is
 * deliberately unbounded (provider/rate limits are the natural backpressure);
 * the registry only guarantees one live writer per JSONL file.
 */

import * as path from "node:path";
import { directoryExists, getManagedMediaDir, getProjectDir, getSessionsDir, logger } from "@oh-my-pi/pi-utils";
import { AsyncJobManager } from "../async";
import { MCPManager } from "../mcp";
// Cyclic import with ../modes/core-mode (core-mode will import this registry
// to run it). Safe: the binding is only invoked at call time inside
// #provisionSession, long after both modules finished evaluating.
import { createHeadlessCollabContext } from "../modes/core-mode";
import { type CreateAgentSessionOptions, createAgentSession } from "../sdk";
import type { AgentSession, AgentSessionEvent } from "../session/agent-session";
import {
	appendForeignSessionImportMarker,
	createForeignSessionStore,
	inspectForeignSessionImport,
	persistForeignSession,
} from "../session/foreign-session-import";
import {
	collectSessionTreeMediaReferences,
	garbageCollectSessionMedia,
	type SessionMediaReferenceCounts,
} from "../session/media-gc";
import type { SessionEntry } from "../session/session-entries";
import { listAllSessions, listSessions, resolveResumableSession, type SessionInfo } from "../session/session-listing";
import { loadEntriesFromFile } from "../session/session-loader";
import { SessionManager } from "../session/session-manager";
import { FileSessionStorage, moveSessionWithArtifacts } from "../session/session-storage";
import { EventBus } from "../utils/event-bus";
import { CollabHost } from "./host";
import {
	type ForeignSessionImportConflict,
	type ForeignSessionSummary,
	type ImportedForeignSession,
	parseCollabLink,
	type SessionSummary,
} from "./protocol";

interface ExistingForeignImport {
	info: SessionInfo;
	path: string;
	managed?: ManagedSession;
	inspection: ReturnType<typeof inspectForeignSessionImport>;
}

function chronologicalMergeEntries(entryGroups: readonly (readonly SessionEntry[])[]): SessionEntry[] {
	const byId = new Map<string, { entry: SessionEntry; ordinal: number }>();
	let ordinal = 0;
	for (const entries of entryGroups) {
		for (const entry of entries) {
			if (!byId.has(entry.id)) byId.set(entry.id, { entry: structuredClone(entry), ordinal });
			ordinal++;
		}
	}
	const sorted = [...byId.values()].sort((left, right) => {
		const leftTime = Date.parse(left.entry.timestamp);
		const rightTime = Date.parse(right.entry.timestamp);
		const safeLeft = Number.isFinite(leftTime) ? leftTime : Number.MAX_SAFE_INTEGER;
		const safeRight = Number.isFinite(rightTime) ? rightTime : Number.MAX_SAFE_INTEGER;
		return safeLeft - safeRight || left.ordinal - right.ordinal;
	});
	let parentId: string | null = null;
	return sorted.map(({ entry }) => {
		entry.parentId = parentId;
		parentId = entry.id;
		return entry;
	});
}

function sameProjectPath(left: string, right: string): boolean {
	const resolvedLeft = path.resolve(left);
	const resolvedRight = path.resolve(right);
	return process.platform === "win32"
		? resolvedLeft.toLocaleLowerCase() === resolvedRight.toLocaleLowerCase()
		: resolvedLeft === resolvedRight;
}

function comparableFilePath(value: string): string {
	const resolved = path.resolve(value);
	return process.platform === "win32" ? resolved.toLocaleLowerCase() : resolved;
}

/** One live session tracked by the registry. */
export interface ManagedSession {
	/** SessionManager.getSessionId() — the session header id. */
	id: string;
	/** `session-${id}` — the agent-registry identity for this session. */
	agentId: string;
	/** Collab room id (parsed from the host link after start). */
	roomId: string;
	/** Registration time, ISO string; stands in for the disk `createdAt` before the first JSONL append. */
	createdAt: string;
	session: AgentSession;
	sessionManager: SessionManager;
	eventBus: EventBus;
	collabHost: CollabHost;
	/** Whether the session is currently streaming a response. */
	streaming: boolean;
	/** "dropping" marks a session mid-teardown; it rejects further operations. */
	state: "running" | "dropping";
}

export interface SessionRegistryOptions {
	relayUrl: string;
	webLinkBase: string;
	/**
	 * Options shared by every created session. The registry injects the
	 * per-session fields (sessionManager/eventBus/agentId/asyncJobManager/
	 * mcpManager) itself, so this MUST NOT carry session-bound values such as
	 * `preloadedExtensions` (Extension instances close over a parent's cwd and
	 * event bus; reusing them across sessions routes tools back to the parent).
	 */
	baseSessionOptions: CreateAgentSessionOptions;
	/** Session directory; falls back to the default for {@link cwd} when empty. */
	sessionDir: string;
	agentDir: string;
}

export class SessionRegistry {
	readonly #relayUrl: string;
	readonly #webLinkBase: string;
	readonly #baseSessionOptions: CreateAgentSessionOptions;
	readonly #sessionDir: string;
	readonly #agentDir: string;
	readonly #archivedSessionsRoot: string;
	readonly #cwd: string;
	/** Active sessions in registration order; entries stay until fully torn down. */
	readonly #active = new Map<string, ManagedSession>();
	/** Streaming subscriptions per session id, removed on drop/shutdown. */
	readonly #streamingUnsubs = new Map<string, () => void>();
	readonly #listeners = new Set<() => void>();

	constructor(options: SessionRegistryOptions) {
		this.#relayUrl = options.relayUrl;
		this.#webLinkBase = options.webLinkBase;
		this.#baseSessionOptions = options.baseSessionOptions;
		this.#cwd = options.baseSessionOptions.cwd ?? getProjectDir();
		this.#agentDir = options.agentDir;
		this.#sessionDir = options.sessionDir || SessionManager.getDefaultSessionDir(this.#cwd, options.agentDir);
		this.#archivedSessionsRoot = path.join(path.dirname(getSessionsDir(options.agentDir)), "archived_sessions");
	}

	/**
	 * Adopt the session core mode created at startup. The caller already built
	 * the AgentSession and started its CollabHost; this installs the same
	 * streaming tracking used for registry-created sessions.
	 */
	registerInitial(managed: ManagedSession): void {
		if (this.#active.has(managed.id)) {
			throw new Error(`session already registered: ${managed.id}`);
		}
		managed.createdAt = new Date().toISOString();
		managed.streaming = managed.session.isStreaming;
		managed.state = "running";
		this.#active.set(managed.id, managed);
		this.#streamingUnsubs.set(
			managed.id,
			managed.session.subscribe(event => this.#onSessionEventFor(managed, event)),
		);
		this.#emitChange();
	}

	/** Create a brand-new persisted session in the requested project and start its collab host. */
	async createSession(cwd = this.#cwd): Promise<{ id: string; link: string }> {
		const targetCwd = path.resolve(cwd);
		if (!(await directoryExists(targetCwd))) {
			throw new Error(`the new session project directory is not available: ${cwd}`);
		}
		const targetSessionDir = sameProjectPath(targetCwd, this.#cwd)
			? this.#sessionDir
			: SessionManager.getDefaultSessionDir(targetCwd, this.#agentDir);
		const sessionManager = SessionManager.create(targetCwd, targetSessionDir);
		return await this.#provisionSession(sessionManager);
	}

	/** List locally stored foreign sessions without reading their transcript bodies. */
	async listForeignSessions(source: "codex", archived = false): Promise<ForeignSessionSummary[]> {
		const store = createForeignSessionStore(source);
		const sessions = await store.list({ archived });
		return sessions.map(session => ({
			source: "codex",
			id: session.id,
			path: session.path,
			cwd: session.cwd,
			title: session.title,
			description: session.description,
			archived: session.archived === true,
			createdAt: session.created.toISOString(),
			modifiedAt: session.modified.toISOString(),
			messageCount: session.messageCount,
			firstMessage: session.firstMessage,
		}));
	}

	async #findExistingForeignImports(source: "codex", sourceId: string): Promise<ExistingForeignImport[]> {
		const storage = new FileSessionStorage();
		const infos = await listAllSessions(storage, getSessionsDir(this.#agentDir));
		const matches: ExistingForeignImport[] = [];
		const seenPaths = new Set<string>();
		for (const info of infos) {
			const sessionPath = path.resolve(info.path);
			const pathKey = comparableFilePath(sessionPath);
			if (seenPaths.has(pathKey)) continue;
			seenPaths.add(pathKey);
			const managed = this.#active.get(info.id);
			const entries = managed
				? managed.sessionManager.getEntries()
				: ((await loadEntriesFromFile(sessionPath, storage)).slice(1) as SessionEntry[]);
			const inspection = inspectForeignSessionImport(entries, source, sourceId);
			if (inspection.matched) matches.push({ info, path: sessionPath, managed, inspection });
		}
		matches.sort((left, right) => left.info.created.getTime() - right.info.created.getTime());
		return matches;
	}

	async #deactivateImportedSession(candidate: ExistingForeignImport): Promise<void> {
		const managed = candidate.managed;
		if (!managed) return;
		managed.state = "dropping";
		this.#emitChange();
		try {
			await managed.collabHost.stop("Codex conversation refreshed");
		} catch (error) {
			logger.warn("failed to stop collab host while refreshing Codex import", {
				id: managed.id,
				error: String(error),
			});
		}
		try {
			await managed.session.dispose();
		} catch (error) {
			logger.warn("failed to dispose session while refreshing Codex import", {
				id: managed.id,
				error: String(error),
			});
		}
		this.#streamingUnsubs.get(managed.id)?.();
		this.#streamingUnsubs.delete(managed.id);
		this.#active.delete(managed.id);
	}

	async #archiveSupersededImport(candidate: ExistingForeignImport): Promise<void> {
		const projectDirectory = path.basename(path.dirname(candidate.path));
		const targetPath = path.join(this.#archivedSessionsRoot, projectDirectory, path.basename(candidate.path));
		await moveSessionWithArtifacts(candidate.path, targetPath);
	}

	async #refreshForeignImport(
		store: ReturnType<typeof createForeignSessionStore>,
		selected: Awaited<ReturnType<typeof store.list>>[number],
		candidates: ExistingForeignImport[],
		merge: boolean,
	): Promise<ImportedForeignSession> {
		for (const candidate of candidates) {
			if (candidate.managed?.streaming) {
				throw new Error("wait for the current response to finish before updating this imported conversation");
			}
		}
		for (const candidate of candidates) await this.#deactivateImportedSession(candidate);

		const primary = candidates[0]!;
		const primaryManager = await SessionManager.open(primary.path, undefined, undefined, {
			initialCwd: selected.cwd,
			suppressBreadcrumb: true,
		});
		let provisioned = false;
		let refreshed: SessionManager | undefined;
		try {
			refreshed = await store.load(selected);
			appendForeignSessionImportMarker(refreshed, selected);
			const refreshedInspection = inspectForeignSessionImport(refreshed.getEntries(), selected.source, selected.id);
			const resolvedInspections: ReturnType<typeof inspectForeignSessionImport>[] = [];
			for (const candidate of candidates) {
				if (candidate === primary) {
					resolvedInspections.push(
						inspectForeignSessionImport(primaryManager.getEntries(), selected.source, selected.id),
					);
					continue;
				}
				const manager = await SessionManager.open(candidate.path, undefined, undefined, {
					initialCwd: selected.cwd,
					suppressBreadcrumb: true,
				});
				try {
					resolvedInspections.push(
						inspectForeignSessionImport(manager.getEntries(), selected.source, selected.id),
					);
				} finally {
					await manager.close();
				}
			}

			const localEntries = (merge ? resolvedInspections : resolvedInspections.slice(0, 1)).flatMap(
				inspection => inspection.localEntries,
			);
			const oldSourceEntries = merge
				? resolvedInspections.flatMap(inspection =>
						inspection.sourceEntries.filter(entry => entry.id.startsWith("codex-")),
					)
				: [];
			const mergedEntries =
				merge || localEntries.length > 0
					? chronologicalMergeEntries([refreshedInspection.sourceEntries, oldSourceEntries, localEntries])
					: structuredClone(refreshedInspection.sourceEntries);
			const marker = refreshed
				.getEntries()
				.findLast(
					entry =>
						entry.type === "custom" &&
						entry.customType === "foreign_session_import" &&
						(entry.data as { sourceId?: unknown } | undefined)?.sourceId === selected.id,
				);
			if (!marker) throw new Error("the refreshed Codex conversation is missing its import marker");
			const markerCopy = structuredClone(marker);
			markerCopy.parentId = mergedEntries.at(-1)?.id ?? null;
			markerCopy.timestamp = new Date().toISOString();
			mergedEntries.push(markerCopy);

			const currentState = primaryManager.captureState();
			const sourceState = refreshed.captureState();
			const keepUserTitle = currentState.titleSource === "user";
			const sessionName = keepUserTitle
				? currentState.sessionName
				: (sourceState.sessionName ?? currentState.sessionName);
			const titleSource = keepUserTitle ? currentState.titleSource : sourceState.titleSource;
			primaryManager.restoreState({
				...currentState,
				cwd: selected.cwd,
				sessionName,
				titleSource,
				titleUpdatedAt: keepUserTitle ? currentState.titleUpdatedAt : sourceState.titleUpdatedAt,
				header: {
					...currentState.header,
					cwd: selected.cwd,
					title: sessionName,
					titleSource,
				},
				entries: mergedEntries,
				onDisk: true,
				needsRewrite: true,
			});
			await primaryManager.rewriteEntries();

			for (const duplicate of candidates.slice(1)) await this.#archiveSupersededImport(duplicate);
			await this.#provisionSession(primaryManager);
			provisioned = true;
			this.#emitChange();
			return {
				id: primaryManager.getSessionId(),
				cwd: primaryManager.getCwd(),
				title: primaryManager.getSessionName(),
				requiresProjectSwitch: false,
			};
		} finally {
			await refreshed?.close();
			if (!provisioned) await primaryManager.close();
		}
	}

	/** Convert and persist one foreign transcript under its original project directory. */
	async importForeignSession(
		source: "codex",
		sourceId: string,
		sourcePath: string,
		archived = false,
		merge = false,
	): Promise<ImportedForeignSession | ForeignSessionImportConflict> {
		const store = createForeignSessionStore(source);
		const requestedCollection = await store.list({ archived });
		let selected = requestedCollection.find(
			session => session.id === sourceId && path.resolve(session.path) === path.resolve(sourcePath),
		);
		if (!selected) {
			const sameId = requestedCollection.filter(session => session.id === sourceId);
			if (sameId.length === 1) selected = sameId[0];
		}
		if (!selected) {
			// Codex can archive/unarchive a thread while the picker is open. That
			// moves the rollout and flips its collection, so the path sent by the
			// already-open dialog is stale even though the stable thread id remains
			// valid. Re-resolve the id from the opposite authoritative collection.
			const oppositeCollection = await store.list({ archived: !archived });
			const sameId = oppositeCollection.filter(session => session.id === sourceId);
			if (sameId.length === 1) selected = sameId[0];
		}
		if (!selected) throw new Error("selected Codex session is no longer available");

		const existing = await this.#findExistingForeignImports(source, sourceId);
		if (existing.length > 0) {
			const localMessageCount = existing.reduce(
				(total, candidate) => total + candidate.inspection.localMessageCount,
				0,
			);
			if (!merge && existing.some(candidate => candidate.inspection.hasLocalConversation)) {
				const primary = existing[0]!;
				return {
					kind: "conflict",
					existingSessionId: primary.info.id,
					cwd: primary.info.cwd,
					title: primary.info.title,
					duplicateCount: existing.length,
					localMessageCount,
				};
			}
			return await this.#refreshForeignImport(store, selected, existing, merge);
		}
		const imported = await persistForeignSession(store, selected, {
			sessionDirForCwd: cwd =>
				sameProjectPath(cwd, this.#cwd)
					? this.#sessionDir
					: SessionManager.getDefaultSessionDir(cwd, this.#agentDir),
			validateCwd: async cwd => {
				if (!(await directoryExists(cwd))) {
					throw new Error(`the original Codex project folder is no longer available: ${cwd}`);
				}
			},
			suppressBreadcrumb: true,
		});
		let managed = false;
		try {
			await this.#provisionSession(imported);
			managed = true;
			const result: ImportedForeignSession = {
				id: imported.getSessionId(),
				cwd: imported.getCwd(),
				title: imported.getSessionName(),
				requiresProjectSwitch: false,
			};
			return result;
		} catch (error) {
			// persistForeignSession has already published the fresh OMP copy. If
			// AgentSession/CollabHost provisioning fails, roll that copy back so an
			// operation reported as failed cannot reappear later as a ghost chat.
			const sessionFile = imported.getSessionFile();
			if (sessionFile) {
				try {
					await imported.dropSession(sessionFile);
				} catch (cleanupError) {
					logger.warn("failed to remove Codex import after provisioning error", {
						sessionFile,
						error: String(cleanupError),
					});
				}
			}
			throw error;
		} finally {
			if (!managed) await imported.close();
		}
	}

	/**
	 * Resume a persisted session by id, filename prefix, or JSONL path.
	 *
	 * Refuses to load a JSONL an active session already owns (a second writer
	 * would race the live one); a matching active session returns its live
	 * link instead.
	 */
	async resumeSession(idOrPath: string): Promise<{ id: string; link: string }> {
		const activeById = this.#active.get(idOrPath);
		if (activeById) {
			if (activeById.state === "dropping") throw new Error("no such session");
			return { id: activeById.id, link: activeById.collabHost.webLink };
		}

		let resolvedPath: string;
		let resolvedFromLocalDirectory = false;
		if (idOrPath.includes("/") || idOrPath.includes("\\") || idOrPath.endsWith(".jsonl")) {
			// Direct path argument (mirrors main.ts resume handling).
			resolvedPath = path.resolve(idOrPath);
		} else {
			const match = await resolveResumableSession(idOrPath, this.#cwd, this.#sessionDir, {
				allowGlobalFallback: true,
				sessionsRoot: getSessionsDir(this.#agentDir),
			});
			if (!match) throw new Error("no such session");
			resolvedPath = path.resolve(match.session.path);
			resolvedFromLocalDirectory = match.scope === "local";
		}

		// File equality is the dedupe key: it also covers id-style arguments,
		// since resolveResumableSession maps ids onto paths above.
		for (const entry of this.#active.values()) {
			const file = entry.sessionManager.getSessionFile();
			if (!file || path.resolve(file) !== resolvedPath) continue;
			if (entry.state === "dropping") throw new Error("no such session");
			return { id: entry.id, link: entry.collabHost.webLink };
		}

		const sessionManager = await SessionManager.open(
			resolvedPath,
			resolvedFromLocalDirectory ? this.#sessionDir : undefined,
			undefined,
			{ initialCwd: this.#cwd },
		);
		return await this.#provisionSession(sessionManager);
	}

	/** Rename a live or persisted session through the canonical JSONL title path. */
	async renameSession(idOrPath: string, title: string): Promise<void> {
		if (title.trim().length === 0) throw new Error("session title cannot be empty");
		const active = this.#active.get(idOrPath);
		if (active) {
			if (active.state === "dropping") throw new Error("no such session");
			const renamed = await active.sessionManager.setSessionName(title, "user", "control-rename");
			if (!renamed) throw new Error("session could not be renamed");
			this.#emitChange();
			return;
		}

		let resolvedPath: string;
		let resolvedFromLocalDirectory = false;
		if (idOrPath.includes("/") || idOrPath.includes("\\") || idOrPath.endsWith(".jsonl")) {
			resolvedPath = path.resolve(idOrPath);
		} else {
			const match = await resolveResumableSession(idOrPath, this.#cwd, this.#sessionDir, {
				allowGlobalFallback: true,
				sessionsRoot: getSessionsDir(this.#agentDir),
			});
			if (!match) throw new Error("no such session");
			resolvedPath = path.resolve(match.session.path);
			resolvedFromLocalDirectory = match.scope === "local";
		}
		const sessionManager = await SessionManager.open(
			resolvedPath,
			resolvedFromLocalDirectory ? this.#sessionDir : undefined,
			undefined,
			{ initialCwd: this.#cwd },
		);
		try {
			const renamed = await sessionManager.setSessionName(title, "user", "control-rename");
			if (!renamed) throw new Error("session could not be renamed");
			this.#emitChange();
		} finally {
			await sessionManager.close();
		}
	}

	async #deleteSessionFileAndOwnedMedia(id: string, sessionFile: string): Promise<void> {
		let deletedMediaReferences: SessionMediaReferenceCounts | undefined;
		try {
			deletedMediaReferences = await collectSessionTreeMediaReferences(
				sessionFile,
				getManagedMediaDir(this.#agentDir),
			);
		} catch (error) {
			// Reference discovery is cleanup bookkeeping, never a reason to keep
			// a chat the user explicitly deleted.
			logger.warn("failed to inspect deleted session media references", { id, error: String(error) });
		}

		await new FileSessionStorage().deleteSessionWithArtifacts(sessionFile);
		if (
			!deletedMediaReferences ||
			(deletedMediaReferences.blobs.size === 0 && deletedMediaReferences.managedMedia.size === 0)
		) {
			return;
		}

		try {
			const gc = await garbageCollectSessionMedia({
				agentDir: this.#agentDir,
				apply: true,
				additionalSessionRoots: [this.#sessionDir],
				blobHashes: new Set(deletedMediaReferences.blobs.keys()),
				managedMediaHashes: new Set(deletedMediaReferences.managedMedia.keys()),
			});
			const errors = [...gc.blobs.errors, ...gc.managedMedia.errors];
			if (errors.length > 0) logger.warn("post-delete media GC completed with errors", { id, errors });
		} catch (error) {
			// The transcript is already gone. Report cleanup diagnostics without
			// turning a successful user-visible deletion into a false failure.
			logger.warn("post-delete media GC failed", { id, error: String(error) });
		}
	}

	/** Move a stored chat out of the active session tree and tear down its live room if needed. */
	async archiveSession(id: string): Promise<void> {
		const storage = new FileSessionStorage();
		const active = this.#active.get(id);
		let sourcePath: string;
		if (active) {
			if (active.state === "dropping") throw new Error("no such session");
			if (active.streaming) throw new Error("wait for the current response to finish before archiving this chat");
			const sessionFile = active.sessionManager.getSessionFile();
			if (!sessionFile || !(await storage.exists(sessionFile))) {
				throw new Error("an empty draft cannot be archived");
			}
			sourcePath = path.resolve(sessionFile);
			active.state = "dropping";
			this.#emitChange();
			try {
				await active.collabHost.stop("session archived");
			} catch (err) {
				logger.warn("failed to stop collab host while archiving session", { id, error: String(err) });
			}
			try {
				await active.session.dispose();
			} catch (err) {
				logger.warn("failed to dispose session while archiving", { id, error: String(err) });
			}
			this.#streamingUnsubs.get(id)?.();
			this.#streamingUnsubs.delete(id);
		} else {
			const match = await resolveResumableSession(id, this.#cwd, this.#sessionDir, {
				allowGlobalFallback: true,
				sessionsRoot: getSessionsDir(this.#agentDir),
			});
			if (!match) throw new Error("no such session");
			sourcePath = path.resolve(match.session.path);
		}

		const projectDirectory = path.basename(path.dirname(sourcePath));
		const targetPath = path.join(this.#archivedSessionsRoot, projectDirectory, path.basename(sourcePath));
		try {
			await moveSessionWithArtifacts(sourcePath, targetPath);
		} finally {
			if (active) this.#active.delete(id);
			this.#emitChange();
		}
	}

	/** List user-archived chats across projects, newest first. */
	async listArchivedSessions(): Promise<SessionSummary[]> {
		const infos = await listAllSessions(new FileSessionStorage(), this.#archivedSessionsRoot);
		return infos.map(info => this.#summaryFromInfo(info));
	}

	/** Permanently delete one archived chat and OMP-owned media no other chat references. */
	async deleteArchivedSession(id: string): Promise<void> {
		const archived = await listAllSessions(new FileSessionStorage(), this.#archivedSessionsRoot);
		const matches = archived.filter(info => info.id === id);
		if (matches.length === 0) throw new Error("no such archived session");
		if (matches.length > 1) throw new Error("more than one archived session has this id");
		await this.#deleteSessionFileAndOwnedMedia(id, matches[0]!.path);
		this.#emitChange();
	}

	/** Restore one archived chat to the active session tree without opening it. */
	async restoreArchivedSession(id: string): Promise<SessionSummary> {
		if (this.#active.has(id)) throw new Error("this session is already active");
		const archived = await listAllSessions(new FileSessionStorage(), this.#archivedSessionsRoot);
		const matches = archived.filter(info => info.id === id);
		if (matches.length === 0) throw new Error("no such archived session");
		if (matches.length > 1) throw new Error("more than one archived session has this id");
		const info = matches[0]!;
		const targetDirectory =
			!info.cwd || sameProjectPath(info.cwd, this.#cwd)
				? this.#sessionDir
				: SessionManager.getDefaultSessionDir(info.cwd, this.#agentDir);
		const targetPath = path.join(targetDirectory, path.basename(info.path));
		await moveSessionWithArtifacts(info.path, targetPath);
		this.#emitChange();
		return this.#summaryFromInfo({ ...info, path: targetPath });
	}

	/** List all sessions (disk + live), newest first by modification time. */
	async list(): Promise<SessionSummary[]> {
		const storage = new FileSessionStorage();
		const [localInfos, globalInfos] = await Promise.all([
			listSessions(this.#sessionDir, storage),
			listAllSessions(storage, getSessionsDir(this.#agentDir)),
		]);
		const seenPaths = new Set<string>();
		const infos = [...localInfos, ...globalInfos].filter(info => {
			const key = comparableFilePath(info.path);
			if (seenPaths.has(key)) return false;
			seenPaths.add(key);
			return true;
		});
		infos.sort((left, right) => right.modified.getTime() - left.modified.getTime());

		// Global scans can retain transcripts for projects that no longer exist,
		// especially short-lived test/scratch workspaces under the OS temp folder.
		// Keep those transcripts resumable by id/path, but do not turn an unavailable
		// cwd into a phantom project in the desktop sidebar. Resolve each unique cwd
		// once and in parallel so a project with many sessions pays for a single stat.
		const projectAvailability = new Map<string, boolean>();
		const projectPaths = new Map<string, string>();
		for (const info of infos) {
			if (!info.cwd || this.#active.has(info.id)) continue;
			projectPaths.set(comparableFilePath(info.cwd), info.cwd);
		}
		await Promise.all(
			Array.from(projectPaths, async ([key, projectPath]) => {
				projectAvailability.set(key, await directoryExists(projectPath));
			}),
		);

		const summaries: SessionSummary[] = [];
		const seen = new Set<string>();
		for (const info of infos) {
			const active = this.#active.get(info.id);
			// A live session remains visible even if its recorded project disappeared;
			// SessionManager may already have adopted the current launch directory.
			if (!active && info.cwd && projectAvailability.get(comparableFilePath(info.cwd)) === false) continue;
			// Dropping sessions are invisible until the drop completes.
			if (active && active.state === "dropping") continue;
			seen.add(info.id);
			const summary: SessionSummary = {
				id: info.id,
				title: info.title,
				cwd: active?.sessionManager.getCwd() ?? info.cwd,
				createdAt: info.created.toISOString(),
				modifiedAt: info.modified.toISOString(),
				messageCount: info.messageCount,
				status: info.status,
				running: active !== undefined && active.state === "running",
				streaming: active?.streaming ?? false,
			};
			// The link is only exposed for live sessions; disk-only sessions
			// must be resumed through the control room first.
			if (active) summary.link = active.collabHost.webLink;
			summaries.push(summary);
		}
		// A fresh session is a Codex-style draft until its first entry persists:
		// keep the editor/live room usable, but do not put an untitled, zero-message
		// placeholder in the sidebar. Named sessions remain visible even before
		// persistence so an explicit rename is never hidden.
		for (const entry of this.#active.values()) {
			if (entry.state === "dropping" || seen.has(entry.id)) continue;
			const title = entry.sessionManager.getSessionName();
			const sessionFile = entry.sessionManager.getSessionFile();
			const persisted = sessionFile !== undefined && (await storage.exists(sessionFile));
			if (!persisted && !title?.trim()) continue;
			summaries.push({
				id: entry.id,
				title,
				cwd: entry.sessionManager.getCwd(),
				createdAt: entry.createdAt,
				modifiedAt: entry.createdAt,
				messageCount: 0,
				status: undefined,
				running: true,
				streaming: entry.streaming,
				link: entry.collabHost.webLink,
			});
		}
		summaries.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
		return summaries;
	}

	#summaryFromInfo(info: SessionInfo): SessionSummary {
		return {
			id: info.id,
			title: info.title,
			cwd: info.cwd,
			createdAt: info.created.toISOString(),
			modifiedAt: info.modified.toISOString(),
			messageCount: info.messageCount,
			status: info.status,
			running: false,
			streaming: false,
		};
	}

	/** Tear down every session in reverse registration order. Never throws. */
	async stopAll(): Promise<void> {
		const entries = [...this.#active.values()].reverse();
		for (const entry of entries) {
			try {
				await entry.collabHost.stop("core shutdown");
			} catch (err) {
				logger.warn("failed to stop collab host during shutdown", { id: entry.id, error: String(err) });
			}
			try {
				await entry.session.dispose();
			} catch (err) {
				logger.warn("failed to dispose session during shutdown", { id: entry.id, error: String(err) });
			}
		}
		for (const unsubscribe of this.#streamingUnsubs.values()) {
			try {
				unsubscribe();
			} catch (err) {
				logger.warn("failed to remove streaming listener during shutdown", { error: String(err) });
			}
		}
		this.#streamingUnsubs.clear();
		this.#active.clear();
	}

	/** Subscribe to list changes and streaming flips. Returns an unsubscribe. */
	onSessionEvent(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/**
	 * Create the AgentSession + CollabHost for a (fresh or reopened) session
	 * manager, start the host, and register the entry.
	 */
	async #provisionSession(sessionManager: SessionManager): Promise<{ id: string; link: string }> {
		const id = sessionManager.getSessionId();
		const agentId = `session-${id}`;
		const eventBus = new EventBus();
		let host: CollabHost | undefined;
		let session: AgentSession | undefined;
		try {
			const result = await createAgentSession({
				...this.#baseSessionOptions,
				cwd: sessionManager.getCwd(),
				sessionManager,
				eventBus,
				agentId,
				// Shared process singletons: every core session talks to the same
				// async-job manager and MCP manager. When the MCP instance is
				// undefined the sdk's setInstance gate guarantees only the first
				// top-level session becomes the global instance.
				asyncJobManager: AsyncJobManager.instance(),
				mcpManager: MCPManager.instance() ?? undefined,
			});
			session = result.session;
			host = new CollabHost(createHeadlessCollabContext(session, eventBus));
			await host.start(this.#relayUrl, this.#webLinkBase);
		} catch (err) {
			await this.#cleanupFailedProvision(host, session);
			throw err;
		}

		const parsed = parseCollabLink(host.link);
		if ("error" in parsed) {
			// Unreachable in practice: host.start() already parsed the same link.
			await this.#cleanupFailedProvision(host, session);
			throw new Error(parsed.error);
		}

		const entry: ManagedSession = {
			id,
			agentId,
			roomId: parsed.roomId,
			createdAt: new Date().toISOString(),
			session,
			sessionManager,
			eventBus,
			collabHost: host,
			streaming: session.isStreaming,
			state: "running",
		};
		this.#active.set(id, entry);
		this.#streamingUnsubs.set(
			id,
			session.subscribe(event => this.#onSessionEventFor(entry, event)),
		);
		this.#emitChange();
		return { id, link: host.webLink };
	}

	/** Idempotent best-effort teardown after a failed provision; never throws. */
	async #cleanupFailedProvision(host: CollabHost | undefined, session: AgentSession | undefined): Promise<void> {
		try {
			await host?.stop("create failed");
		} catch (err) {
			logger.warn("failed to stop collab host after session creation error", { error: String(err) });
		}
		try {
			await session?.dispose();
		} catch (err) {
			logger.warn("failed to dispose session after creation error", { error: String(err) });
		}
	}

	/** Flip an entry's streaming flag on agent_start/agent_end and notify. */
	#onSessionEventFor(entry: ManagedSession, event: AgentSessionEvent): void {
		if (event.type !== "agent_start" && event.type !== "agent_end") return;
		const streaming = event.type === "agent_start";
		if (entry.streaming === streaming) return;
		entry.streaming = streaming;
		this.#emitChange();
	}

	#emitChange(): void {
		for (const listener of this.#listeners) {
			try {
				listener();
			} catch (err) {
				logger.warn("session registry change listener error", { error: String(err) });
			}
		}
	}
}
