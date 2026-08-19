/**
 * Host side of a collab live session.
 *
 * Taps the host session's event stream and SessionManager append chokepoint,
 * broadcasting entries/events/state to guests through the relay. Guests prompt
 * and abort through us; the host machine runs the agent and tools. The host's
 * subagent ecosystem is mirrored too: task EventBus traffic (observer HUD),
 * agent-registry snapshots (Agent Hub table), hub chat/kill/revive commands,
 * and incremental subagent-transcript reads.
 */

import { timingSafeEqual } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ImageContent, Model, TextContent } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import type {
	BusChannel,
	ChatSearchKind,
	ChatSearchRole,
	CollabUiRequest,
	CollabUiRequestDraft,
	CollabUiResponseValue,
	LocalFileReference,
	AgentEvent as WireAgentEvent,
	WireModel,
	SessionEntry as WireSessionEntry,
} from "@oh-my-pi/pi-wire";
import { MANAGED_IMAGE_CHUNK_CHARS, MANAGED_IMAGE_MAX_BASE64_CHARS } from "@oh-my-pi/pi-wire";
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { type AgentRef, AgentRegistry } from "../registry/agent-registry";
import type { AgentSessionEvent } from "../session/agent-session";
import { stripImagesFromMessage, USER_INTERRUPT_LABEL } from "../session/messages";
import type { SessionEntry as StoredSessionEntry } from "../session/session-entries";
import { STTController, type SttEditor, type SttState, type SttToggleOptions } from "../stt";
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL, TASK_SUBAGENT_PROGRESS_CHANNEL } from "../task/types";
import { AUTO_THINKING, type ConfiguredThinkingLevel, parseConfiguredThinkingLevel } from "../thinking";
import { resizeImage } from "../utils/image-resize";
import { searchChatEntries } from "./chat-search";
import { generateRoomKey, generateWriteToken, importRoomKey } from "./crypto";
import { collabDisplayName } from "./display-name";
import type { CollabHostContext } from "./host-context";
import { CollabImageStore, replaceImagesWithRefs } from "./image-replication";
import { ManagedMediaStore } from "./managed-media-store";
import {
	type AgentSnapshot,
	COLLAB_PROMPT_MESSAGE_TYPE,
	COLLAB_PROTO,
	type CollabFrame,
	type CollabParticipant,
	type CollabPromptDetails,
	type CollabSessionState,
	formatCollabLink,
	formatCollabWebLink,
	generateRoomId,
	parseCollabLink,
} from "./protocol";
import { CollabSocket } from "./relay-client";
import { shrinkForReplication } from "./replication-shrink";

/** Events that change the footer state guests render. */
const STATE_TRIGGER_EVENTS: Record<string, true> = {
	agent_start: true,
	agent_end: true,
	message_end: true,
	tool_execution_end: true,
	thinking_level_changed: true,
	model_changed: true,
	auto_compaction_end: true,
};

const STATE_DEBOUNCE_MS = 100;
const AGENTS_DEBOUNCE_MS = 100;
const STREAMING_STATE_INTERVAL_MS = 2000;
const WELCOME_IMAGE_STRIP_THRESHOLD = 24 * 1024 * 1024;
const INITIAL_HISTORY_ENTRIES = 200;
const MAX_HISTORY_PAGE_ENTRIES = 500;
const MAX_LOCAL_FILE_REFERENCES = 32;
const MAX_LOCAL_FILE_PATH_LENGTH = 32_767;
const MANAGED_IMAGE_THUMBNAIL_MAX_BYTES = 48 * 1024;
const MANAGED_IMAGE_CHUNK_MAX_COUNT = Math.ceil(MANAGED_IMAGE_MAX_BASE64_CHARS / MANAGED_IMAGE_CHUNK_CHARS);
const MANAGED_IMAGE_ASSEMBLY_TIMEOUT_MS = 30_000;
const MANAGED_IMAGE_MAX_PENDING_PER_PEER = 4;
const UNSAFE_LOCAL_FILE_PATH = /[\u0000-\u001f\u007f]/;
const WIRE_AGENT_EVENT_TYPES: Record<WireAgentEvent["type"], true> = {
	agent_start: true,
	agent_end: true,
	turn_start: true,
	turn_end: true,
	message_start: true,
	message_update: true,
	message_end: true,
	tool_execution_start: true,
	tool_execution_update: true,
	tool_execution_end: true,
	notice: true,
	auto_compaction_start: true,
	auto_compaction_end: true,
	auto_retry_start: true,
	auto_retry_end: true,
	thinking_level_changed: true,
};

interface NormalizedLocalFiles {
	files: LocalFileReference[];
	error?: string;
}

/** Validate untrusted guest metadata and derive display names from the path. */
function normalizeLocalFiles(localFiles: readonly LocalFileReference[] | undefined): NormalizedLocalFiles {
	if (!localFiles || localFiles.length === 0) return { files: [] };
	if (localFiles.length > MAX_LOCAL_FILE_REFERENCES) {
		return { files: [], error: `at most ${MAX_LOCAL_FILE_REFERENCES} local files may be referenced` };
	}
	const files: LocalFileReference[] = [];
	const seen = new Set<string>();
	for (const candidate of localFiles) {
		if (
			candidate === null ||
			typeof candidate !== "object" ||
			candidate.kind !== "local-file" ||
			typeof candidate.path !== "string"
		) {
			return { files: [], error: "invalid local file reference" };
		}
		const filePath = candidate.path;
		const windowsPath = path.win32.isAbsolute(filePath);
		if (
			filePath.length === 0 ||
			filePath.length > MAX_LOCAL_FILE_PATH_LENGTH ||
			UNSAFE_LOCAL_FILE_PATH.test(filePath) ||
			(!windowsPath && !path.posix.isAbsolute(filePath))
		) {
			return { files: [], error: "local file references must use valid absolute paths" };
		}
		const key = windowsPath ? filePath.toLocaleLowerCase() : filePath;
		if (seen.has(key)) continue;
		seen.add(key);
		const name = windowsPath ? path.win32.basename(filePath) : path.posix.basename(filePath);
		files.push({ kind: "local-file", path: filePath, name: name || filePath });
	}
	return { files };
}

/** Build model-visible path context without reading or copying the referenced files. */
function promptWithLocalFileReferences(text: string, localFiles: readonly LocalFileReference[]): string {
	if (localFiles.length === 0) return text;
	const paths = JSON.stringify(
		localFiles.map(file => file.path),
		null,
		2,
	);
	const prefix = text.length > 0 ? `${text}\n\n` : "";
	return `${prefix}<local_file_references>\n${paths}\n</local_file_references>\nThe files are referenced by their existing host paths and are not embedded. Use filesystem tools only if their contents are needed.`;
}

const WIRE_SESSION_ENTRY_TYPES: Record<WireSessionEntry["type"], true> = {
	message: true,
	custom_message: true,
	compaction: true,
	branch_summary: true,
	model_change: true,
	thinking_level_change: true,
};
const COLLAB_BUS_CHANNELS = [
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
] as const satisfies readonly BusChannel[];

function isWireAgentEvent(event: AgentSessionEvent): event is AgentSessionEvent & WireAgentEvent {
	return event.type in WIRE_AGENT_EVENT_TYPES;
}

export function isWireSessionEntry(entry: StoredSessionEntry): entry is StoredSessionEntry & WireSessionEntry {
	return entry.type in WIRE_SESSION_ENTRY_TYPES;
}

/** Wire-shaped descriptor for a session model (id/name/provider/contextWindow). */
function toWireModel(m: Model): WireModel {
	return { id: m.id, name: m.name, provider: m.provider, contextWindow: m.contextWindow ?? null };
}

const CONNECT_TIMEOUT_MS = 15_000;
/** Max bytes served per fetch-transcript reply (guest re-requests from `newSize`). */
export const TRANSCRIPT_READ_CAP = 4 * 1024 * 1024;
const TRANSCRIPT_ENTRY_TOO_LARGE_ERROR = `transcript entry exceeds transcript fetch cap (${TRANSCRIPT_READ_CAP} bytes)`;
/**
 * Soft byte cap per `snapshot-chunk` frame. The first MB of a snapshot takes
 * ~3s through the default relay, so a 512 KB chunk lands well under the
 * guest's 30 s per-chunk progress timeout; oversized single entries still
 * ship in a chunk of their own.
 */
const SNAPSHOT_CHUNK_BYTES = 512 * 1024;
/**
 * Outcome of {@link CollabHost.requestGuestUi}. `answered` carries the guest's
 * response (an `undefined` value is a genuine guest cancel); `unavailable`
 * means the collab channel went away (teardown, relay drop) or the request was
 * aborted before any guest answered — callers MUST NOT treat it as a cancel.
 */
export type CollabGuestUiResult = { kind: "answered"; value: CollabUiResponseValue } | { kind: "unavailable" };

export interface CollabHostOptions {
	/** Test seam and alternate durable-media root; production uses the agent media directory. */
	managedMediaStore?: ManagedMediaStore;
}

interface PendingManagedImage {
	mimeType: string;
	chunkCount: number;
	chunks: (string | undefined)[];
	receivedChars: number;
	timer: Timer;
}

export class CollabHost {
	#ctx: CollabHostContext;
	#socket: CollabSocket | null = null;
	#link = "";
	#webLink = "";
	#viewLink = "";
	#webViewLink = "";
	#writeToken: Uint8Array | null = null;
	#sessionId = "";
	#unsubscribe?: () => void;
	#peers = new Map<number, { name: string; canWrite: boolean; mediaRefs: boolean; historyPaging: boolean }>();
	readonly #images = new CollabImageStore();
	readonly #managedMedia: ManagedMediaStore;
	readonly #pendingManagedImages = new Map<string, PendingManagedImage>();
	#uiReqSeq = 0;
	#pendingUi = new Map<number, { request: CollabUiRequest; settle(result: CollabGuestUiResult): void }>();
	#lastStateJson = "";
	#stateDebounce: Timer | null = null;
	#streamingInterval: Timer | null = null;
	#agentsDebounce: Timer | null = null;
	#busUnsubscribers: (() => void)[] = [];
	#registryUnsubscribe?: () => void;
	#stopped = false;
	readonly #speechController = new STTController();
	#speechPeer: number | null = null;
	#speechCommitted = "";
	#speechVolatile = "";
	#speechStatus = "";
	readonly #speechEditor: SttEditor = {
		insertText: text => {
			this.#speechCommitted += text;
		},
		setVolatileText: text => {
			this.#speechVolatile = text;
		},
		clearVolatileText: () => {
			this.#speechVolatile = "";
		},
		commitVolatileText: text => {
			this.#speechCommitted += text;
			this.#speechVolatile = "";
		},
		submit: () => {},
		deleteBeforeCursor: count => {
			this.#speechCommitted = this.#speechCommitted.slice(0, Math.max(0, this.#speechCommitted.length - count));
		},
	};

	constructor(ctx: CollabHostContext, options: CollabHostOptions = {}) {
		this.#ctx = ctx;
		this.#managedMedia = options.managedMediaStore ?? new ManagedMediaStore();
	}

	get link(): string {
		return this.#link;
	}

	/** Browser deep link for the configured collab web UI. */
	get webLink(): string {
		return this.#webLink;
	}

	/** Read-only variant of {@link link}: bare room key, no write token. */
	get viewLink(): string {
		return this.#viewLink;
	}

	/** Read-only variant of {@link webLink}. */
	get webViewLink(): string {
		return this.#webViewLink;
	}

	get participants(): CollabParticipant[] {
		const list: CollabParticipant[] = [{ name: collabDisplayName(this.#ctx), role: "host" }];
		for (const peer of this.#peers.values()) {
			list.push({ name: peer.name, role: "guest", readOnly: peer.canWrite ? undefined : true });
		}
		return list;
	}

	requestGuestUi(request: CollabUiRequestDraft, signal?: AbortSignal): Promise<CollabGuestUiResult> | null {
		if (!this.#socket || !this.#hasWritablePeers()) return null;
		const reqId = ++this.#uiReqSeq;
		const fullRequest: CollabUiRequest = { ...request, reqId };
		const { promise, resolve } = Promise.withResolvers<CollabGuestUiResult>();
		let settled = false;
		const settle = (result: CollabGuestUiResult): void => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", onAbort);
			this.#pendingUi.delete(reqId);
			this.#sendWritablePeers({ t: "ui-request-end", reqId });
			resolve(result);
		};
		const onAbort = (): void => settle({ kind: "unavailable" });
		if (signal?.aborted) return Promise.resolve({ kind: "unavailable" });
		signal?.addEventListener("abort", onAbort, { once: true });
		this.#pendingUi.set(reqId, { request: fullRequest, settle });
		this.#sendWritablePeers({ t: "ui-request", request: fullRequest });
		return promise;
	}

	#hasWritablePeers(): boolean {
		for (const peer of this.#peers.values()) {
			if (peer.canWrite) return true;
		}
		return false;
	}

	#sendWritablePeers(frame: CollabFrame): void {
		const socket = this.#socket;
		if (!socket) return;
		for (const [peerId, peer] of this.#peers) {
			if (peer.canWrite) socket.send(shrinkForReplication(frame), peerId);
		}
	}

	async start(relayUrl: string, webUrl = ""): Promise<void> {
		const rawKey = generateRoomKey();
		const writeToken = generateWriteToken();
		const roomId = generateRoomId();
		this.#writeToken = writeToken;
		this.#link = formatCollabLink(relayUrl, roomId, rawKey, writeToken);
		this.#webLink = formatCollabWebLink(relayUrl, roomId, rawKey, writeToken, webUrl);
		this.#viewLink = formatCollabLink(relayUrl, roomId, rawKey);
		this.#webViewLink = formatCollabWebLink(relayUrl, roomId, rawKey, undefined, webUrl);
		const parsed = parseCollabLink(this.#link);
		if ("error" in parsed) throw new Error(parsed.error);
		const key = await importRoomKey(rawKey);

		const socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "host", key });
		this.#socket = socket;
		this.#sessionId = this.#ctx.sessionManager.getSessionId();

		const firstOpen = Promise.withResolvers<void>();
		let opened = false;
		socket.onOpen = () => {
			if (!opened) {
				opened = true;
				firstOpen.resolve();
			}
		};
		socket.onFrame = (frame, fromPeer) => this.#handleFrame(frame, fromPeer);
		socket.onControl = msg => {
			if (msg.t === "peer-left") this.#handlePeerLeft(msg.peer);
		};
		socket.onClose = (reason, willReconnect) => {
			if (this.#stopped) return;
			if (!opened) {
				firstOpen.reject(new Error(reason));
				return;
			}
			if (willReconnect) {
				this.#ctx.showStatus(`Collab relay connection lost (${reason}), reconnecting…`, { dim: true });
			} else {
				void this.#teardown();
				this.#ctx.session.emitNotice("warning", `Collab ended: ${reason}`, "collab");
			}
		};
		socket.connect();

		const timeout = setTimeout(
			() => firstOpen.reject(new Error("timed out connecting to relay")),
			CONNECT_TIMEOUT_MS,
		);
		try {
			await firstOpen.promise;
		} catch (err) {
			this.#stopped = true;
			socket.close();
			this.#socket = null;
			throw err;
		} finally {
			clearTimeout(timeout);
		}

		this.#unsubscribe = this.#ctx.session.subscribe(event => {
			if (isWireAgentEvent(event)) this.#broadcast({ t: "event", event });
			this.#onEventForState(event);
		});
		const bus = this.#ctx.eventBus;
		if (bus) {
			for (const channel of COLLAB_BUS_CHANNELS) {
				this.#busUnsubscribers.push(bus.on(channel, data => this.#broadcast({ t: "bus", channel, data })));
			}
		}
		this.#registryUnsubscribe = AgentRegistry.global().onChange(() => this.#scheduleAgentsBroadcast());
		this.#ctx.sessionManager.onEntryAppended = entry => {
			if (isWireSessionEntry(entry)) this.#broadcast({ t: "entry", entry });
			// Model/thinking/title changes land as entries while idle; refresh
			// guest state promptly (debounce + JSON diff dedupe).
			this.#scheduleStateBroadcast();
		};
		this.#updateStatusSegment();
	}

	/** Broadcast a goodbye, detach all taps, and close the socket. */
	async stop(reason: string): Promise<void> {
		if (this.#stopped) return;
		this.#socket?.send({ t: "bye", reason });
		await this.#teardown();
	}

	async #teardown(): Promise<void> {
		if (this.#stopped) return;
		this.#stopped = true;
		this.#ctx.sessionManager.onEntryAppended = undefined;
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		for (const unsubscribe of this.#busUnsubscribers) unsubscribe();
		this.#busUnsubscribers = [];
		this.#registryUnsubscribe?.();
		this.#registryUnsubscribe = undefined;
		clearTimeout(this.#stateDebounce ?? undefined);
		this.#stateDebounce = null;
		clearTimeout(this.#agentsDebounce ?? undefined);
		this.#agentsDebounce = null;
		clearInterval(this.#streamingInterval ?? undefined);
		this.#streamingInterval = null;
		for (const pending of this.#pendingUi.values()) pending.settle({ kind: "unavailable" });
		this.#pendingUi.clear();
		for (const pending of this.#pendingManagedImages.values()) clearTimeout(pending.timer);
		this.#pendingManagedImages.clear();
		this.#speechController.dispose();
		this.#speechPeer = null;
		this.#peers.clear();
		this.#socket?.close();
		this.#socket = null;
		this.#ctx.collabHost = undefined;
		this.#ctx.statusLine.setCollabStatus(null);
		this.#ctx.ui.requestRender();
	}

	#broadcast(frame: CollabFrame): void {
		if (this.#stopped || !this.#socket) return;
		if (this.#ctx.sessionManager.getSessionId() !== this.#sessionId) {
			void this.stop("session switched");
			this.#ctx.session.emitNotice("warning", "Collab ended: session switched", "collab");
			return;
		}
		for (const [peerId, peer] of this.#peers) {
			const prepared = peer.mediaRefs ? replaceImagesWithRefs(frame, this.#images) : frame;
			this.#socket.send(shrinkForReplication(prepared), peerId);
		}
	}

	#handleFrame(frame: CollabFrame, fromPeer: number): void {
		switch (frame.t) {
			case "hello":
				this.#handleHello(
					frame.name,
					frame.proto,
					frame.writeToken,
					frame.mediaRefs === true,
					frame.historyPaging === true,
					fromPeer,
				);
				break;
			case "prompt":
				this.#handlePrompt(frame.text, frame.images, frame.localFiles, fromPeer);
				break;
			case "abort":
				this.#handleAbort(fromPeer);
				break;
			case "agent-cmd":
				this.#handleAgentCmd(frame.cmd, frame.agentId, frame.text, fromPeer);
				break;
			case "ui-response":
				this.#handleUiResponse(frame.reqId, frame.value, fromPeer);
				break;
			case "fetch-transcript":
				void this.#handleFetchTranscript(frame.reqId, frame.agentId, frame.fromByte, fromPeer);
				break;
			case "fetch-history":
				this.#handleFetchHistory(frame.reqId, frame.beforeId, frame.limit, fromPeer);
				break;
			case "chat-search":
				this.#handleChatSearch(frame.reqId, frame.query, frame.kind, frame.role, frame.date, frame.limit, fromPeer);
				break;
			case "speech-input":
				void this.#handleSpeechInput(frame.action, fromPeer);
				break;
			case "fetch-image":
				void this.#handleFetchImage(frame.reqId, frame.imageId, frame.variant, fromPeer);
				break;
			case "media-import":
				this.#handleMediaImportChunk(
					frame.reqId,
					frame.data,
					frame.mimeType,
					frame.chunkIndex,
					frame.chunkCount,
					fromPeer,
				);
				break;
			case "model-list":
				void this.#handleModelList(fromPeer);
				break;
			case "model-change":
				void this.#handleModelChange(frame.provider, frame.id, fromPeer);
				break;
			case "thinking-change":
				this.#handleThinkingChange(frame.level, fromPeer);
				break;
			default:
				logger.debug("collab host ignoring unexpected frame", { type: frame.t, fromPeer });
		}
	}

	/** Timing-safe write-token check; peers without a valid token are read-only. */
	#verifyWriteToken(token: string | undefined): boolean {
		const expected = this.#writeToken;
		if (!expected || !token) return false;
		const bytes = Buffer.from(token, "base64url");
		return bytes.byteLength === expected.byteLength && timingSafeEqual(bytes, expected);
	}

	/** Reject a mutating frame from a read-only peer with a targeted error. */
	#rejectReadOnly(action: string, fromPeer: number): void {
		this.#socket?.send({ t: "error", message: `${action} is disabled on a read-only link` }, fromPeer);
	}

	#handleHello(
		name: string,
		proto: number,
		writeToken: string | undefined,
		mediaRefs: boolean,
		historyPaging: boolean,
		fromPeer: number,
	): void {
		if (proto !== COLLAB_PROTO) {
			this.#socket?.send(
				{ t: "error", message: `protocol mismatch: host speaks v${COLLAB_PROTO}, guest sent v${proto}` },
				fromPeer,
			);
			return;
		}
		const cleanName = name.trim().slice(0, 64) || `guest-${fromPeer}`;
		const canWrite = this.#verifyWriteToken(writeToken);
		const useHistoryPaging = historyPaging && mediaRefs;
		this.#peers.set(fromPeer, { name: cleanName, canWrite, mediaRefs, historyPaging: useHistoryPaging });

		// Snapshot and send synchronously: no awaits between snapshot, welcome,
		// and chunk sends, so subsequent broadcast frames (entry/event/state/bus)
		// queue behind the snapshot on the same socket and the guest can't
		// observe a gap between the snapshot fragment and live traffic.
		const snapshot = this.#ctx.sessionManager.snapshotForReplication();
		if (!mediaRefs && JSON.stringify(snapshot).length > WELCOME_IMAGE_STRIP_THRESHOLD) {
			let stripped = 0;
			for (const entry of snapshot.entries) {
				if (entry.type === "message") stripped += stripImagesFromMessage(entry.message);
			}
			logger.info("collab welcome exceeded size threshold; stripped images", { stripped });
		}
		const allEntries = snapshot.entries.filter(isWireSessionEntry);
		const historyRemaining = useHistoryPaging ? Math.max(0, allEntries.length - INITIAL_HISTORY_ENTRIES) : 0;
		const initialEntries = useHistoryPaging ? allEntries.slice(historyRemaining) : allEntries;
		const entries = initialEntries.map(entry => (mediaRefs ? replaceImagesWithRefs(entry, this.#images) : entry));
		const socket = this.#socket;
		if (!socket) return;
		socket.send(
			{
				t: "welcome",
				proto: COLLAB_PROTO,
				header: snapshot.header,
				state: this.#buildState(),
				agents: this.#snapshotAgents(),
				entryCount: entries.length,
				historyRemaining: useHistoryPaging ? historyRemaining : undefined,
				readOnly: canWrite ? undefined : true,
			},
			fromPeer,
		);
		this.#sendSnapshotChunks(entries, fromPeer);
		if (canWrite) {
			for (const pending of this.#pendingUi.values()) {
				socket.send({ t: "ui-request", request: pending.request }, fromPeer);
			}
		}
		this.#ctx.session.emitNotice(
			"info",
			`${cleanName} joined the collab session${canWrite ? "" : " (read-only)"}`,
			"collab",
		);
		this.#updateStatusSegment();
		this.#scheduleStateBroadcast();
	}

	/**
	 * Slice {@link entries} into byte-bounded `snapshot-chunk` frames targeted
	 * at {@link fromPeer}. Each entry is first run through
	 * {@link shrinkForReplication} so a single oversized tool-result entry
	 * cannot ship as an oversized chunk that trips the relay's per-frame
	 * `maxPayloadLength` (issue #3739). Every batch carries at least one
	 * entry, and the last batch is tagged `final: true` so the guest can
	 * finalize the replica. An empty snapshot still emits one `final` chunk
	 * so the guest never blocks on a missing terminator.
	 */
	#sendSnapshotChunks(entries: (StoredSessionEntry & WireSessionEntry)[], fromPeer: number): void {
		const socket = this.#socket;
		if (!socket) return;
		if (entries.length === 0) {
			socket.send({ t: "snapshot-chunk", entries: [], final: true }, fromPeer);
			return;
		}
		let i = 0;
		while (i < entries.length) {
			const batch: (StoredSessionEntry & WireSessionEntry)[] = [];
			let batchBytes = 0;
			while (i < entries.length) {
				const entry = entries[i];
				if (!entry) break;
				const shrunk = shrinkForReplication(entry);
				const entryBytes = JSON.stringify(shrunk).length;
				if (batch.length > 0 && batchBytes + entryBytes > SNAPSHOT_CHUNK_BYTES) break;
				batch.push(shrunk);
				batchBytes += entryBytes;
				i++;
			}
			socket.send({ t: "snapshot-chunk", entries: batch, final: i >= entries.length }, fromPeer);
		}
	}

	#handleUiResponse(reqId: number, value: CollabUiResponseValue, fromPeer: number): void {
		const peer = this.#peers.get(fromPeer);
		if (!peer?.canWrite) {
			this.#rejectReadOnly("responding to ask", fromPeer);
			return;
		}
		this.#pendingUi.get(reqId)?.settle({ kind: "answered", value });
	}

	#handlePrompt(
		text: string,
		images: ImageContent[] | undefined,
		localFiles: LocalFileReference[] | undefined,
		fromPeer: number,
	): void {
		const peer = this.#peers.get(fromPeer);
		if (!peer?.canWrite) {
			this.#rejectReadOnly("prompting", fromPeer);
			return;
		}
		const normalized = normalizeLocalFiles(localFiles);
		if (normalized.error) {
			this.#socket?.send({ t: "error", message: normalized.error }, fromPeer);
			return;
		}
		const name = peer.name;
		const promptText = promptWithLocalFileReferences(text, normalized.files);
		const content: string | (TextContent | ImageContent)[] =
			images && images.length > 0 ? [{ type: "text", text: promptText }, ...images] : promptText;
		const details: CollabPromptDetails = { from: name };
		if (normalized.files.length > 0) {
			details.displayText = text;
			details.localFiles = normalized.files;
		}
		const queueChipText =
			text.trim().length > 0
				? text
				: normalized.files.length === 1
					? normalized.files[0]?.name
					: `${normalized.files.length} local files`;
		if (this.#ctx.session.isStreaming) {
			this.#ctx.updatePendingMessagesDisplay();
			this.#ctx.ui.requestRender();
			this.#scheduleStateBroadcast();
		}
		this.#ctx.session
			.promptCustomMessage(
				{
					customType: COLLAB_PROMPT_MESSAGE_TYPE,
					content,
					display: true,
					details,
					attribution: "user",
				},
				{ streamingBehavior: "steer", queueChipText },
			)
			.catch(err => {
				logger.warn("collab guest prompt failed", { error: String(err) });
				this.#socket?.send({ t: "error", message: `prompt failed: ${String(err)}` }, fromPeer);
			});
	}

	#handleAbort(fromPeer: number): void {
		const peer = this.#peers.get(fromPeer);
		if (!peer?.canWrite) {
			this.#rejectReadOnly("interrupting", fromPeer);
			return;
		}
		const name = peer.name;
		void this.#ctx.session
			.abort({ reason: USER_INTERRUPT_LABEL })
			.then(() => this.#ctx.session.emitNotice("info", `${name} interrupted`, "collab"))
			.catch(err => logger.warn("collab guest abort failed", { error: String(err) }));
	}

	/** Reply immediately from the local registry, then refresh the menu if background discovery adds models. */
	async #handleModelList(fromPeer: number): Promise<void> {
		const initial = this.#ctx.session.getAvailableModels().map(toWireModel);
		this.#socket?.send({ t: "model-list", models: initial }, fromPeer);
		await this.#ctx.session.modelRegistry.awaitBackgroundRefresh();
		const refreshed = this.#ctx.session.getAvailableModels().map(toWireModel);
		if (JSON.stringify(refreshed) !== JSON.stringify(initial)) {
			this.#socket?.send({ t: "model-list", models: refreshed }, fromPeer);
		}
	}

	/**
	 * Switch the session model. Mirrors the RPC `set_model` semantics: the
	 * model must exist in the current catalog, with one background-discovery
	 * refresh allowed for cold-start providers. Success is not answered with a
	 * dedicated frame — `model_changed` is in {@link STATE_TRIGGER_EVENTS}, so
	 * the regular debounced state broadcast carries the new model to every
	 * guest.
	 */
	async #handleModelChange(provider: string, id: string, fromPeer: number): Promise<void> {
		if (!this.#peers.get(fromPeer)?.canWrite) {
			this.#rejectReadOnly("changing the model", fromPeer);
			return;
		}
		let model = this.#ctx.session.getAvailableModels().find(m => m.provider === provider && m.id === id);
		if (!model) {
			await this.#ctx.session.modelRegistry.awaitBackgroundRefresh();
			model = this.#ctx.session.getAvailableModels().find(m => m.provider === provider && m.id === id);
		}
		if (!model) {
			this.#socket?.send({ t: "error", message: `Model not found: ${provider}/${id}` }, fromPeer);
			return;
		}
		try {
			await this.#ctx.session.setModel(model);
		} catch (err) {
			logger.warn("collab guest model change failed", { provider, id, error: String(err) });
			this.#socket?.send({ t: "error", message: String(err) }, fromPeer);
		}
	}

	/** Apply only a selector advertised for the active model, preserving `auto`. */
	#handleThinkingChange(level: string, fromPeer: number): void {
		if (!this.#peers.get(fromPeer)?.canWrite) {
			this.#rejectReadOnly("changing thinking", fromPeer);
			return;
		}
		const parsed = parseConfiguredThinkingLevel(level);
		const available = this.#availableThinkingLevels();
		if (!parsed || !available.includes(parsed)) {
			this.#socket?.send(
				{ t: "error", message: `Thinking level not supported by the current model: ${level}` },
				fromPeer,
			);
			return;
		}
		this.#ctx.session.setThinkingLevel(parsed);
		this.#scheduleStateBroadcast();
	}

	#availableThinkingLevels(): ConfiguredThinkingLevel[] {
		if (!this.#ctx.session.model?.reasoning) return [];
		return ["off", AUTO_THINKING, ...this.#ctx.session.getAvailableThinkingLevels()];
	}

	#handlePeerLeft(peer: number): void {
		const name = this.#peers.get(peer)?.name;
		if (this.#speechPeer === peer) {
			this.#speechCommitted = "";
			this.#speechVolatile = "";
			this.#speechController.cancel(this.#speechOptions(peer));
		}
		this.#peers.delete(peer);
		const prefix = `${peer}:`;
		for (const [key, pending] of this.#pendingManagedImages) {
			if (!key.startsWith(prefix)) continue;
			clearTimeout(pending.timer);
			this.#pendingManagedImages.delete(key);
		}
		if (name) this.#ctx.session.emitNotice("info", `${name} left the collab session`, "collab");
		this.#updateStatusSegment();
		this.#scheduleStateBroadcast();
	}

	#buildState(): CollabSessionState {
		const session = this.#ctx.session;
		// Context numbers come from the status line's memoized breakdown so guests
		// render exactly the same anchored, provider-real count the host's own
		// status line shows.
		const breakdown = this.#ctx.statusLine.getCachedContextBreakdown();
		const tokens = breakdown.usedTokens ?? 0;
		return {
			isStreaming: session.isStreaming,
			isAborting: session.isAborting,
			queuedMessageCount: session.queuedMessageCount,
			sessionName: session.sessionName,
			cwd: this.#ctx.sessionManager.getCwd(),
			model: session.model,
			thinkingLevel: session.thinkingLevel,
			configuredThinkingLevel: session.configuredThinkingLevel(),
			availableThinkingLevels: this.#availableThinkingLevels(),
			contextUsage: {
				tokens,
				contextWindow: breakdown.contextWindow,
				percent: breakdown.contextWindow > 0 ? (tokens / breakdown.contextWindow) * 100 : 0,
			},
			participants: this.participants,
		};
	}

	#onEventForState(event: AgentSessionEvent): void {
		if (!STATE_TRIGGER_EVENTS[event.type]) return;
		this.#scheduleStateBroadcast();
		if (event.type === "agent_start" && !this.#streamingInterval) {
			this.#streamingInterval = setInterval(() => this.#scheduleStateBroadcast(), STREAMING_STATE_INTERVAL_MS);
		} else if (event.type === "agent_end" && this.#streamingInterval) {
			clearInterval(this.#streamingInterval);
			this.#streamingInterval = null;
		}
	}

	#snapshotAgents(): AgentSnapshot[] {
		return (
			AgentRegistry.global()
				.list()
				// Advisor transcripts are local observability only; never mirror them to
				// guests (the wire AgentSnapshot kind has no `advisor`, and guests must not
				// be able to chat/kill/revive them).
				.filter((ref): ref is AgentRef & { kind: "main" | "sub" } => ref.kind !== "advisor")
				// Multi-session core mode registers every session's agents in the same
				// process-wide AgentRegistry; each CollabHost must only mirror its own
				// session's tree. Scope key: AgentRef.scopeId is set to
				// `options.agentScopeId ?? sessionManager.getSessionId()` at registration
				// (sdk.ts), AgentSession.getAgentScopeId() returns that same value, and
				// subagents inherit it via executor's agentScopeId — so equality with the
				// host session's scope id selects exactly this session's agents.
				.filter(ref => ref.scopeId === this.#ctx.session.getAgentScopeId())
				.map(ref => ({
					id: ref.id,
					displayName: ref.displayName,
					kind: ref.kind,
					parentId: ref.parentId,
					status: ref.status,
					hasSessionFile: !!ref.sessionFile,
					createdAt: ref.createdAt,
					lastActivity: ref.lastActivity,
				}))
		);
	}

	#scheduleAgentsBroadcast(): void {
		if (this.#stopped || this.#agentsDebounce) return;
		this.#agentsDebounce = setTimeout(() => {
			this.#agentsDebounce = null;
			this.#broadcast({ t: "agents", agents: this.#snapshotAgents() });
		}, AGENTS_DEBOUNCE_MS);
	}

	#handleAgentCmd(cmd: "chat" | "kill" | "revive", agentId: string, text: string | undefined, fromPeer: number): void {
		if (!this.#peers.get(fromPeer)?.canWrite) {
			this.#rejectReadOnly("agent control", fromPeer);
			return;
		}
		// Advisor refs are excluded from snapshots, but reject control by id defensively:
		// a stale/malicious client must never chat/kill/revive a read-only advisor transcript.
		if (AgentRegistry.global().get(agentId)?.kind === "advisor") {
			this.#socket?.send({ t: "error", message: `agent ${agentId}: advisor transcripts are read-only` }, fromPeer);
			return;
		}
		// Multi-session scope gate: agents registered under another session's scope
		// must not be controllable from here (scope key as in #snapshotAgents).
		// Unknown ids are intentionally left alone so the ensureLive path below
		// reports the canonical error for them.
		const ref = AgentRegistry.global().get(agentId);
		if (ref && ref.scopeId !== this.#ctx.session.getAgentScopeId()) {
			this.#socket?.send({ t: "error", message: "agent not in this session" }, fromPeer);
			return;
		}
		const fail = (err: unknown) => {
			logger.warn("collab agent-cmd failed", { cmd, agentId, error: String(err) });
			this.#socket?.send({ t: "error", message: `agent ${agentId}: ${String(err)}` }, fromPeer);
		};
		switch (cmd) {
			case "chat": {
				const trimmed = text?.trim();
				if (!trimmed) {
					this.#socket?.send({ t: "error", message: `agent ${agentId}: empty chat message` }, fromPeer);
					return;
				}
				// Mirrors the hub's #submitChatMessage: revive if parked, steer if mid-turn.
				AgentLifecycleManager.global()
					.ensureLive(agentId)
					.then(session => session.prompt(trimmed, { streamingBehavior: "steer" }))
					.catch(fail);
				break;
			}
			case "kill": {
				const kill = async () => {
					if (!ref) return;
					if (ref.status === "running" && ref.session) {
						await ref.session.abort({ reason: USER_INTERRUPT_LABEL });
					}
					await AgentLifecycleManager.global().release(agentId, ref, { tombstone: true });
				};
				kill().catch(fail);
				break;
			}
			case "revive":
				AgentLifecycleManager.global().ensureLive(agentId).catch(fail);
				break;
		}
	}

	/** Incremental transcript read mirroring the hub's readFileIncremental contract. */
	#handleFetchHistory(reqId: number, beforeId: string, limit: number, fromPeer: number): void {
		const peer = this.#peers.get(fromPeer);
		const socket = this.#socket;
		if (!socket || !peer?.historyPaging) {
			socket?.send(
				{ t: "history", reqId, entries: [], remaining: 0, error: "history paging not enabled" },
				fromPeer,
			);
			return;
		}
		if (this.#ctx.sessionManager.getSessionId() !== this.#sessionId) {
			socket.send({ t: "history", reqId, entries: [], remaining: 0, error: "session changed" }, fromPeer);
			return;
		}
		const snapshot = this.#ctx.sessionManager.snapshotForReplication();
		const entries = snapshot.entries.filter(isWireSessionEntry);
		const beforeIndex = entries.findIndex(entry => entry.id === beforeId);
		if (beforeIndex < 0) {
			socket.send(
				{ t: "history", reqId, entries: [], remaining: 0, error: "history cursor is no longer available" },
				fromPeer,
			);
			return;
		}
		const pageLimit = Number.isSafeInteger(limit)
			? Math.max(1, Math.min(limit, MAX_HISTORY_PAGE_ENTRIES))
			: INITIAL_HISTORY_ENTRIES;
		const requestedStart = Math.max(0, beforeIndex - pageLimit);
		const page: (StoredSessionEntry & WireSessionEntry)[] = [];
		let pageBytes = 0;
		let start = beforeIndex;
		while (start > requestedStart) {
			const source = entries[start - 1];
			if (!source) break;
			const referenced = peer.mediaRefs ? replaceImagesWithRefs(source, this.#images) : source;
			const prepared = shrinkForReplication(referenced);
			const entryBytes = JSON.stringify(prepared).length;
			if (page.length > 0 && pageBytes + entryBytes > SNAPSHOT_CHUNK_BYTES) break;
			page.unshift(prepared);
			pageBytes += entryBytes;
			start--;
		}
		socket.send({ t: "history", reqId, entries: page, remaining: start }, fromPeer);
	}

	#handleChatSearch(
		reqId: number,
		query: unknown,
		kind: unknown,
		role: unknown,
		date: unknown,
		limit: unknown,
		fromPeer: number,
	): void {
		const socket = this.#socket;
		if (!socket || !this.#peers.has(fromPeer)) return;
		if (this.#ctx.sessionManager.getSessionId() !== this.#sessionId) {
			socket.send(
				{ t: "chat-search-results", reqId, results: [], total: 0, truncated: false, error: "session changed" },
				fromPeer,
			);
			return;
		}
		const validKind = kind === "all" || kind === "text" || kind === "image" || kind === "file" || kind === "link";
		const validRole = role === "all" || role === "user" || role === "assistant";
		const validDate = date === undefined || (typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date));
		if (
			typeof query !== "string" ||
			!validKind ||
			!validRole ||
			!validDate ||
			typeof limit !== "number" ||
			!Number.isSafeInteger(limit)
		) {
			socket.send(
				{
					t: "chat-search-results",
					reqId,
					results: [],
					total: 0,
					truncated: false,
					error: "invalid search request",
				},
				fromPeer,
			);
			return;
		}
		const response = searchChatEntries(this.#ctx.sessionManager.getEntries(), {
			query,
			kind: kind as ChatSearchKind,
			role: role as ChatSearchRole,
			date: date as string | undefined,
			limit,
		});
		socket.send({ t: "chat-search-results", reqId, ...response }, fromPeer);
	}

	#speechText(): string {
		return `${this.#speechCommitted}${this.#speechVolatile}`;
	}

	#localizedSpeechStatus(message: string): string {
		if (message === "No speech detected.") return "未检测到语音。";
		if (message === "Transcription in progress...") return "正在整理识别结果…";
		const progress = /\((\d{1,3})%\)$/.exec(message);
		if (message.startsWith("Downloading speech model")) {
			return progress ? `正在下载中文语音识别模型… ${progress[1]}%` : "正在下载中文语音识别模型…";
		}
		return message;
	}

	#localizedSpeechError(message: string): string {
		if (/0x80070490|GetDefaultAudioEndpoint.*failed/iu.test(message)) {
			return "未检测到可用的麦克风，请连接或启用麦克风后重试。";
		}
		if (/0x80070005|access denied|permission denied/iu.test(message)) {
			return "无法访问麦克风，请在 Windows 设置中允许 Grimoire Router App 使用麦克风。";
		}
		if (/0x8889000a|device.*in use/iu.test(message)) {
			return "麦克风正被其他应用占用，请关闭占用麦克风的应用后重试。";
		}
		if (/0x88890004|device.*invalidated/iu.test(message)) {
			return "麦克风已断开或不可用，请重新连接后重试。";
		}
		return message;
	}

	#sendSpeechState(
		peer: number,
		state: "idle" | "preparing" | SttState,
		options: { final?: boolean; error?: string } = {},
	): void {
		this.#socket?.send(
			{
				t: "speech-input-state",
				state,
				text: this.#speechText(),
				status: this.#speechStatus || undefined,
				final: options.final,
				error: options.error,
			},
			peer,
		);
	}

	#speechOptions(peer: number): SttToggleOptions {
		return {
			// The desktop first release intentionally uses multilingual Whisper small
			// in Chinese mode and never auto-sends recognized text.
			modelName: "balanced",
			language: "zh",
			submitTrigger: "never",
			showWarning: message => {
				this.#speechStatus = "";
				this.#sendSpeechState(peer, "idle", { final: true, error: this.#localizedSpeechError(message) });
				if (this.#speechPeer === peer) this.#speechPeer = null;
			},
			showStatus: message => {
				this.#speechStatus = this.#localizedSpeechStatus(message);
				const state = this.#speechController.state === "idle" ? "preparing" : this.#speechController.state;
				this.#sendSpeechState(peer, state);
			},
			onStateChange: state => {
				if (state === "recording") this.#speechStatus = "正在听…";
				if (state === "transcribing") this.#speechStatus = "正在整理识别结果…";
				if (state === "idle") this.#speechStatus = "";
				this.#sendSpeechState(peer, state, { final: state === "idle" });
				if (state === "idle" && this.#speechPeer === peer) this.#speechPeer = null;
			},
			requestRender: () => {
				const state = this.#speechController.state === "idle" ? "preparing" : this.#speechController.state;
				this.#sendSpeechState(peer, state);
			},
		};
	}

	async #handleSpeechInput(action: "start" | "stop" | "cancel", fromPeer: number): Promise<void> {
		const peer = this.#peers.get(fromPeer);
		if (!peer?.canWrite) {
			this.#socket?.send(
				{
					t: "speech-input-state",
					state: "idle",
					text: "",
					final: true,
					error: "当前会话为只读，无法使用语音录入。",
				},
				fromPeer,
			);
			return;
		}
		if (action === "start") {
			if (this.#speechPeer !== null) {
				if (this.#speechPeer === fromPeer) {
					const state = this.#speechController.state === "idle" ? "preparing" : this.#speechController.state;
					this.#sendSpeechState(fromPeer, state);
					return;
				}
				this.#socket?.send(
					{
						t: "speech-input-state",
						state: "idle",
						text: "",
						final: true,
						error: "麦克风正被另一个窗口使用。",
					},
					fromPeer,
				);
				return;
			}
			if (this.#speechController.state !== "idle") {
				this.#socket?.send(
					{
						t: "speech-input-state",
						state: "idle",
						text: "",
						final: true,
						error: "麦克风正在结束上一次录入，请稍后重试。",
					},
					fromPeer,
				);
				return;
			}
			this.#speechPeer = fromPeer;
			this.#speechCommitted = "";
			this.#speechVolatile = "";
			this.#speechStatus = "正在准备中文语音识别…";
			this.#sendSpeechState(fromPeer, "preparing");
			await this.#speechController.toggle(this.#speechEditor, this.#speechOptions(fromPeer));
			return;
		}
		if (this.#speechPeer !== fromPeer) return;
		if (action === "cancel") {
			this.#speechCommitted = "";
			this.#speechVolatile = "";
			this.#speechController.cancel(this.#speechOptions(fromPeer));
			return;
		}
		await this.#speechController.toggle(this.#speechEditor, this.#speechOptions(fromPeer));
	}

	async #handleFetchTranscript(reqId: number, agentId: string, fromByte: number, fromPeer: number): Promise<void> {
		const reply = (text: string, newSize: number, error?: string) =>
			this.#socket?.send({ t: "transcript", reqId, text, newSize, error }, fromPeer);
		// Multi-session scope gate: transcripts are only readable for this session's
		// own agent tree (scope key as in #snapshotAgents); out-of-scope ids are
		// reported exactly like unknown ones so no existence is leaked.
		const ref = AgentRegistry.global().get(agentId);
		if (ref && ref.scopeId !== this.#ctx.session.getAgentScopeId()) {
			reply("", 0, "no transcript available");
			return;
		}
		const file = ref?.sessionFile;
		if (!file) {
			reply("", fromByte, "no transcript available");
			return;
		}
		try {
			const stat = await fs.stat(file);
			if (stat.size <= fromByte) {
				reply("", stat.size);
				return;
			}
			const want = Math.min(stat.size - fromByte, TRANSCRIPT_READ_CAP);
			const handle = await fs.open(file, "r");
			let bytesRead: number;
			const buf = Buffer.allocUnsafe(want);
			try {
				({ bytesRead } = await handle.read(buf, 0, want, fromByte));
			} finally {
				await handle.close();
			}
			let slice = buf.subarray(0, bytesRead);
			const reachedEof = fromByte + bytesRead >= stat.size;
			if (!reachedEof) {
				// Trim to the last complete JSONL line so no line or UTF-8 char is split.
				const lastNewline = slice.lastIndexOf(0x0a);
				if (lastNewline < 0) {
					reply("", fromByte, TRANSCRIPT_ENTRY_TOO_LARGE_ERROR);
					return;
				}
				slice = slice.subarray(0, lastNewline + 1);
			}
			reply(slice.toString("utf-8"), reachedEof ? stat.size : fromByte + slice.byteLength);
		} catch (err) {
			logger.debug("collab transcript read failed", { agentId, error: String(err) });
			reply("", fromByte, String(err));
		}
	}

	/** Serve one registered image to a media-reference-capable peer. */
	async #handleFetchImage(
		reqId: number,
		imageId: string,
		variant: "thumbnail" | "original",
		fromPeer: number,
	): Promise<void> {
		const peer = this.#peers.get(fromPeer);
		if (!peer?.mediaRefs) {
			this.#socket?.send({ t: "image", reqId, imageId, variant, error: "media references not enabled" }, fromPeer);
			return;
		}
		try {
			const payload = await this.#images.fetch(imageId, variant);
			if (!payload) {
				this.#socket?.send({ t: "image", reqId, imageId, variant, error: "image unavailable" }, fromPeer);
				return;
			}
			this.#socket?.send({ t: "image", reqId, imageId, variant, ...payload }, fromPeer);
		} catch (error) {
			logger.debug("collab image fetch failed", { imageId, variant, error: String(error) });
			this.#socket?.send({ t: "image", reqId, imageId, variant, error: "image unavailable" }, fromPeer);
		}
	}

	#handleMediaImportChunk(
		reqId: number,
		data: string,
		mimeType: string,
		chunkIndex: number,
		chunkCount: number,
		fromPeer: number,
	): void {
		const socket = this.#socket;
		const peer = this.#peers.get(fromPeer);
		if (!socket) return;
		if (!peer?.canWrite) {
			socket.send({ t: "media-imported", reqId, error: "read-only guests cannot import media" }, fromPeer);
			return;
		}
		const key = `${fromPeer}:${reqId}`;
		const reject = (message: string): void => {
			const pending = this.#pendingManagedImages.get(key);
			if (pending) clearTimeout(pending.timer);
			this.#pendingManagedImages.delete(key);
			socket.send({ t: "media-imported", reqId, error: message }, fromPeer);
		};
		if (
			!Number.isSafeInteger(chunkIndex) ||
			!Number.isSafeInteger(chunkCount) ||
			chunkIndex < 0 ||
			chunkCount < 1 ||
			chunkIndex >= chunkCount ||
			chunkCount > MANAGED_IMAGE_CHUNK_MAX_COUNT ||
			data.length > MANAGED_IMAGE_CHUNK_CHARS
		) {
			reject("invalid managed image chunk");
			return;
		}

		let pending = this.#pendingManagedImages.get(key);
		if (!pending) {
			let peerPending = 0;
			for (const pendingKey of this.#pendingManagedImages.keys()) {
				if (pendingKey.startsWith(`${fromPeer}:`)) ++peerPending;
			}
			if (peerPending >= MANAGED_IMAGE_MAX_PENDING_PER_PEER) {
				reject("too many image imports are pending");
				return;
			}
			const timer = setTimeout(() => {
				this.#pendingManagedImages.delete(key);
				this.#socket?.send({ t: "media-imported", reqId, error: "image import timed out" }, fromPeer);
			}, MANAGED_IMAGE_ASSEMBLY_TIMEOUT_MS);
			pending = {
				mimeType,
				chunkCount,
				chunks: Array<string | undefined>(chunkCount).fill(undefined),
				receivedChars: 0,
				timer,
			};
			this.#pendingManagedImages.set(key, pending);
		} else if (pending.mimeType !== mimeType || pending.chunkCount !== chunkCount) {
			reject("managed image chunks do not agree");
			return;
		}

		const previous = pending.chunks[chunkIndex];
		if (previous !== undefined) {
			if (previous !== data) reject("managed image chunk changed during upload");
			return;
		}
		pending.chunks[chunkIndex] = data;
		pending.receivedChars += data.length;
		if (pending.receivedChars > MANAGED_IMAGE_MAX_BASE64_CHARS) {
			reject("managed image is too large");
			return;
		}
		if (pending.chunks.some(chunk => chunk === undefined)) return;

		clearTimeout(pending.timer);
		this.#pendingManagedImages.delete(key);
		void this.#persistManagedImage(reqId, pending.chunks.join(""), mimeType, fromPeer);
	}

	async #persistManagedImage(reqId: number, data: string, mimeType: string, fromPeer: number): Promise<void> {
		const socket = this.#socket;
		if (!socket) return;
		try {
			const imported = await this.#managedMedia.importImage(data, mimeType);
			let thumbnail: ImageContent | undefined;
			try {
				const resized = await resizeImage(
					{ type: "image", data, mimeType: imported.mimeType },
					{
						maxWidth: 320,
						maxHeight: 240,
						minDimension: 1,
						maxBytes: MANAGED_IMAGE_THUMBNAIL_MAX_BYTES,
						jpegQuality: 68,
					},
				);
				thumbnail = { type: "image", data: resized.data, mimeType: resized.mimeType };
			} catch (error) {
				logger.debug("Managed media thumbnail creation failed", {
					imageId: imported.imageId,
					error: String(error),
				});
			}
			if (!this.#peers.get(fromPeer)?.canWrite) return;
			socket.send(
				{
					t: "media-imported",
					reqId,
					media: {
						file: imported.file,
						imageId: imported.imageId,
						mimeType: imported.mimeType,
						thumbnail,
					},
				},
				fromPeer,
			);
		} catch (error) {
			logger.debug("Managed media import failed", { fromPeer, error: String(error) });
			if (!this.#peers.get(fromPeer)?.canWrite) return;
			socket.send(
				{
					t: "media-imported",
					reqId,
					error: error instanceof Error ? error.message : "media import failed",
				},
				fromPeer,
			);
		}
	}

	#scheduleStateBroadcast(): void {
		if (this.#stopped || this.#stateDebounce) return;
		this.#stateDebounce = setTimeout(() => {
			this.#stateDebounce = null;
			const state = this.#buildState();
			const json = JSON.stringify(state);
			if (json === this.#lastStateJson) return;
			this.#lastStateJson = json;
			this.#broadcast({ t: "state", state });
		}, STATE_DEBOUNCE_MS);
	}

	#updateStatusSegment(): void {
		this.#ctx.statusLine.setCollabStatus({ role: "host", participantCount: this.#peers.size + 1 });
		this.#ctx.statusLine.invalidate();
		this.#ctx.ui.requestRender();
	}
}
