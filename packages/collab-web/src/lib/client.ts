/**
 * Guest-side session replica for the collab web client.
 *
 * Owns the relay socket, applies host frames in strict arrival order, and
 * exposes an immutable {@link GuestSnapshot} through a
 * `useSyncExternalStore`-compatible subscribe/getSnapshot pair. The snapshot
 * object (and every replaced collection inside it) gets a new reference per
 * applied frame, so React change detection is reference equality all the way.
 */

import type {
	AgentSnapshot,
	AssistantMessage,
	CollabUiRequest,
	CollabUiResponseValue,
	HostFrame,
	ImageVariant,
	LocalFileReference,
	ManagedImageReference,
	SessionEntry,
	SessionHeader,
	SessionState,
	SubagentLifecyclePayload,
	SubagentProgressPayload,
	WireModel,
} from "@oh-my-pi/pi-wire";
import { MANAGED_IMAGE_CHUNK_CHARS, MANAGED_IMAGE_MAX_BASE64_CHARS } from "@oh-my-pi/pi-wire";
import { importRoomKey } from "./codec";
import { COLLAB_PROTO, encodeBase64Url, parseCollabLink } from "./link";
import { CollabSocket } from "./socket";

export type ConnectionPhase = "connecting" | "waiting" | "live" | "reconnecting" | "ended";

export interface ActiveTool {
	toolCallId: string;
	toolName: string;
	args: unknown;
	intent?: string;
	partialResult?: unknown;
	startedAt: number;
}

export interface Notice {
	id: number;
	level: "info" | "warning" | "error";
	message: string;
	at: number;
}

export interface GuestSnapshot {
	phase: ConnectionPhase;
	endedReason: string | null;
	header: SessionHeader | null;
	entries: readonly SessionEntry[];
	state: SessionState | null;
	agents: readonly AgentSnapshot[];
	/** Keyed by `payload.progress.id`. */
	progress: ReadonlyMap<string, SubagentProgressPayload>;
	/** Keyed by `payload.id`. */
	lifecycle: ReadonlyMap<string, SubagentLifecyclePayload>;
	/** Streaming assistant ghost; held until the matching entry lands. */
	stream: AssistantMessage | null;
	streamDone: boolean;
	activeTools: ReadonlyMap<string, ActiveTool>;
	/** agent_start..agent_end, reconciled by state.isStreaming. */
	working: boolean;
	/** True when this guest joined through a read-only (view) link. */
	readOnly: boolean;
	/** Pending host-side UI request (`ask` select/editor) this guest can answer. */
	uiRequest: CollabUiRequest | null;
	/** Available models from the host's `model-list` reply; null until first loaded. */
	models: WireModel[] | null;
	/** Older session entries retained by a paging-capable host. */
	historyRemaining: number;
	/** True while one older-history page is in flight. */
	historyLoading: boolean;
	/** Capped at 50, newest last. */
	notices: readonly Notice[];
}

const MAX_NOTICES = 50;
const TRANSCRIPT_TIMEOUT_MS = 10_000;
const HISTORY_TIMEOUT_MS = 10_000;
const DEFAULT_HISTORY_PAGE = 200;
/** Mirrors the TUI guest's WELCOME_TIMEOUT_MS: a host that never answers hello ends the join. */
const WELCOME_TIMEOUT_MS = 30_000;
/** Mirrors the TUI guest's SNAPSHOT_PROGRESS_TIMEOUT_MS: every snapshot chunk must make progress. */
const SNAPSHOT_PROGRESS_TIMEOUT_MS = 30_000;

/**
 * One fetch-transcript round trip.
 * - `rows`: decoded JSONL from `fromByte`; `newSize` is the next offset base.
 * - `error`: terminal read failure reported by the host (unchanged cursor);
 *   callers must surface it and stop polling instead of hot retrying.
 * Transient failures (timeout, session end) resolve `null` and are retryable.
 */
export type TranscriptResult = { kind: "rows"; text: string; newSize: number } | { kind: "error"; message: string };

/** Decoded lazy-media payload returned to transcript image components. */
export interface RemoteImage {
	data: string;
	mimeType: string;
}

interface PendingTranscript {
	resolve: (result: TranscriptResult | null) => void;
	timer: Timer;
}

interface PendingImage {
	key: string;
	resolve: (result: RemoteImage | null) => void;
	timer: Timer;
}

interface PendingMediaImport {
	resolve: (result: ManagedImageReference) => void;
	reject: (error: Error) => void;
	timer: Timer;
}

interface PendingHistory {
	reqId: number;
	timer: Timer;
}

const IMAGE_TIMEOUT_MS = 15_000;
const MEDIA_IMPORT_TIMEOUT_MS = 30_000;

export class GuestClient {
	readonly #socket: CollabSocket;
	readonly #name: string;
	/** base64url write token from a full link; absent when joined via a view link. */
	readonly #writeToken: string | undefined;
	readonly #listeners = new Set<() => void>();
	readonly #pendingTranscripts = new Map<number, PendingTranscript>();
	readonly #pendingImages = new Map<number, PendingImage>();
	readonly #pendingMediaImports = new Map<number, PendingMediaImport>();
	readonly #imageRequests = new Map<string, Promise<RemoteImage | null>>();
	readonly #imageCache = new Map<string, RemoteImage>();
	#reqSeq = 0;
	#noticeSeq = 0;
	#everConnected = false;
	#welcomed = false;
	#welcomeTimer: Timer | null = null;
	#snapshotProgressTimer: Timer | null = null;
	#pendingHistory: PendingHistory | null = null;

	#phase: ConnectionPhase = "connecting";
	#endedReason: string | null = null;
	#header: SessionHeader | null = null;
	#entries: readonly SessionEntry[] = [];
	/** Mutable only while a welcome snapshot train is loading; published once on final. */
	#snapshotEntries: SessionEntry[] | null = null;
	#state: SessionState | null = null;
	#agents: readonly AgentSnapshot[] = [];
	#progress: ReadonlyMap<string, SubagentProgressPayload> = new Map();
	#lifecycle: ReadonlyMap<string, SubagentLifecyclePayload> = new Map();
	#stream: AssistantMessage | null = null;
	#streamDone = false;
	#activeTools: ReadonlyMap<string, ActiveTool> = new Map();
	#working = false;
	#readOnly = false;
	#uiRequest: CollabUiRequest | null = null;
	#uiRequestQueue: CollabUiRequest[] = [];
	#models: WireModel[] | null = null;
	#modelListRequested = false;
	#historyRemaining = 0;
	#historyLoading = false;
	#notices: readonly Notice[] = [];
	#snapshot: GuestSnapshot;

	/** @throws Error when the link does not parse. */
	constructor(link: string, displayName: string) {
		const parsed = parseCollabLink(link);
		if ("error" in parsed) throw new Error(parsed.error);
		this.#name = displayName;
		this.#writeToken = parsed.writeToken ? encodeBase64Url(parsed.writeToken) : undefined;
		this.#socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key: importRoomKey(parsed.key) });
		this.#socket.onOpen = () => this.#handleOpen();
		// Session rooms only ever receive HostFrame payloads; control-room
		// frames arrive on a separate socket (ControlClient).
		this.#socket.onFrame = frame => this.#applyFrameSafe(frame as HostFrame);
		this.#socket.onControl = msg => {
			if (msg.t === "room-closed") this.#end("room closed");
		};
		this.#socket.onClose = (reason, willReconnect) => this.#handleClose(reason, willReconnect);
		this.#snapshot = this.#buildSnapshot();
	}

	connect(): void {
		if (this.#phase === "ended") {
			this.#phase = "connecting";
			this.#endedReason = null;
			this.#commit();
		}
		this.#socket.connect();
		if (!this.#welcomed && this.#welcomeTimer === null) {
			this.#welcomeTimer = setTimeout(() => {
				this.#welcomeTimer = null;
				if (!this.#welcomed) this.#end("timed out waiting for the host's welcome");
			}, WELCOME_TIMEOUT_MS);
		}
	}

	close(): void {
		this.#clearWelcomeTimer();
		this.#clearSnapshotProgressTimer();
		this.#clearPendingHistory();
		this.#socket.close();
	}

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	/** Cached stable reference; replaced (with fresh collection refs) per applied frame. */
	getSnapshot(): GuestSnapshot {
		return this.#snapshot;
	}

	sendPrompt(text: string, localFiles?: readonly LocalFileReference[]): void {
		this.#socket.send({ t: "prompt", text, localFiles: localFiles ? [...localFiles] : undefined });
	}

	sendUiResponse(reqId: number, value?: CollabUiResponseValue): void {
		this.#socket.send({ t: "ui-response", reqId, value });
		if (this.#uiRequest?.reqId === reqId) {
			this.#showNextUiRequest();
			this.#commit();
		}
	}

	sendAbort(): void {
		this.#socket.send({ t: "abort" });
	}

	sendModelList(): void {
		if (this.#models !== null || this.#modelListRequested) return;
		this.#modelListRequested = true;
		this.#socket.send({ t: "model-list" });
	}

	sendModelChange(provider: string, id: string): void {
		this.#socket.send({ t: "model-change", provider, id });
	}

	sendThinkingChange(level: string): void {
		this.#socket.send({ t: "thinking-change", level });
	}

	/** Request one page immediately before the oldest entry currently held. */
	loadEarlierHistory(limit = DEFAULT_HISTORY_PAGE): void {
		const beforeId = this.#entries[0]?.id;
		if (this.#phase !== "live" || this.#historyLoading || this.#historyRemaining <= 0 || beforeId === undefined)
			return;
		const reqId = ++this.#reqSeq;
		this.#historyLoading = true;
		const timer = setTimeout(() => {
			if (this.#pendingHistory?.reqId !== reqId) return;
			this.#pendingHistory = null;
			this.#historyLoading = false;
			this.#pushNotice("warning", "older history request timed out");
			this.#commit();
		}, HISTORY_TIMEOUT_MS);
		this.#pendingHistory = { reqId, timer };
		this.#socket.send({ t: "fetch-history", reqId, beforeId, limit });
		this.#commit();
	}

	sendAgentCmd(cmd: "chat" | "kill" | "revive", agentId: string, text?: string): void {
		this.#socket.send({ t: "agent-cmd", cmd, agentId, text });
	}

	/**
	 * Incremental subagent-transcript read. Resolves a {@link TranscriptResult}
	 * (`rows` or terminal `error`), or `null` on transient failure (10s timeout,
	 * session end) where re-polling from the same cursor is correct.
	 */
	fetchTranscript(agentId: string, fromByte: number): Promise<TranscriptResult | null> {
		const reqId = ++this.#reqSeq;
		const { promise, resolve } = Promise.withResolvers<TranscriptResult | null>();
		const timer = setTimeout(() => {
			this.#pendingTranscripts.delete(reqId);
			resolve(null);
		}, TRANSCRIPT_TIMEOUT_MS);
		this.#pendingTranscripts.set(reqId, { resolve, timer });
		this.#socket.send({ t: "fetch-transcript", reqId, agentId, fromByte });
		return promise;
	}

	/** Fetch and deduplicate one thumbnail/original exposed by an image reference. */
	fetchImage(imageId: string, variant: ImageVariant): Promise<RemoteImage | null> {
		const key = `${variant}:${imageId}`;
		const cached = this.#imageCache.get(key);
		if (cached) return Promise.resolve(cached);
		const existing = this.#imageRequests.get(key);
		if (existing) return existing;

		const reqId = ++this.#reqSeq;
		const { promise, resolve } = Promise.withResolvers<RemoteImage | null>();
		const timer = setTimeout(() => {
			this.#pendingImages.delete(reqId);
			resolve(null);
		}, IMAGE_TIMEOUT_MS);
		this.#pendingImages.set(reqId, { key, resolve, timer });
		const request = promise.finally(() => {
			this.#imageRequests.delete(key);
		});
		this.#imageRequests.set(key, request);
		this.#socket.send({ t: "fetch-image", reqId, imageId, variant });
		return request;
	}

	/** Persist a pathless clipboard/screenshot image on the host and return its stable path reference. */
	importManagedImage(data: string, mimeType: string, name?: string): Promise<ManagedImageReference> {
		if (data.length === 0 || data.length > MANAGED_IMAGE_MAX_BASE64_CHARS) {
			return Promise.reject(new Error("clipboard image is too large"));
		}
		const reqId = ++this.#reqSeq;
		const { promise, resolve, reject } = Promise.withResolvers<ManagedImageReference>();
		const timer = setTimeout(() => {
			this.#pendingMediaImports.delete(reqId);
			reject(new Error("image import timed out"));
		}, MEDIA_IMPORT_TIMEOUT_MS);
		this.#pendingMediaImports.set(reqId, { resolve, reject, timer });
		const chunkCount = Math.max(1, Math.ceil(data.length / MANAGED_IMAGE_CHUNK_CHARS));
		for (let chunkIndex = 0; chunkIndex < chunkCount; ++chunkIndex) {
			this.#socket.send({
				t: "media-import",
				reqId,
				data: data.slice(chunkIndex * MANAGED_IMAGE_CHUNK_CHARS, (chunkIndex + 1) * MANAGED_IMAGE_CHUNK_CHARS),
				mimeType,
				name,
				chunkIndex,
				chunkCount,
			});
		}
		return promise;
	}

	/** Test seam: apply a synthetic host frame through the real apply path. */
	applyFrameForTest(frame: HostFrame): void {
		this.#applyFrameSafe(frame);
	}

	#handleOpen(): void {
		this.#socket.send({
			t: "hello",
			proto: COLLAB_PROTO,
			name: this.#name,
			writeToken: this.#writeToken,
			mediaRefs: true,
			historyPaging: true,
		});
		this.#phase = this.#everConnected ? "reconnecting" : "waiting";
		this.#everConnected = true;
		this.#commit();
	}

	#handleClose(reason: string, willReconnect: boolean): void {
		this.#clearSnapshotProgressTimer();
		if (this.#phase === "ended") return;
		if (willReconnect) {
			this.#phase = "reconnecting";
			this.#commit();
			return;
		}
		this.#end(reason);
	}

	#end(reason: string): void {
		if (this.#phase === "ended") return;
		this.#clearWelcomeTimer();
		this.#clearSnapshotProgressTimer();
		this.#clearPendingHistory();
		this.#snapshotEntries = null;
		this.#phase = "ended";
		this.#endedReason = reason;
		for (const [, pending] of this.#pendingTranscripts) {
			clearTimeout(pending.timer);
			pending.resolve(null);
		}
		this.#pendingTranscripts.clear();
		for (const [, pending] of this.#pendingImages) {
			clearTimeout(pending.timer);
			pending.resolve(null);
		}
		this.#pendingImages.clear();
		for (const [, pending] of this.#pendingMediaImports) {
			clearTimeout(pending.timer);
			pending.reject(new Error("session ended before the image was imported"));
		}
		this.#pendingMediaImports.clear();
		this.#imageRequests.clear();
		this.#imageCache.clear();
		this.#clearUiRequests();
		this.#commit();
		this.#socket.close();
	}

	#clearWelcomeTimer(): void {
		if (this.#welcomeTimer !== null) {
			clearTimeout(this.#welcomeTimer);
			this.#welcomeTimer = null;
		}
	}

	#armSnapshotProgressTimer(): void {
		this.#clearSnapshotProgressTimer();
		this.#snapshotProgressTimer = setTimeout(() => {
			this.#snapshotProgressTimer = null;
			this.#end("timed out waiting for the host's session snapshot");
		}, SNAPSHOT_PROGRESS_TIMEOUT_MS);
	}

	#clearSnapshotProgressTimer(): void {
		if (this.#snapshotProgressTimer !== null) {
			clearTimeout(this.#snapshotProgressTimer);
			this.#snapshotProgressTimer = null;
		}
	}

	#clearPendingHistory(): void {
		if (this.#pendingHistory !== null) {
			clearTimeout(this.#pendingHistory.timer);
			this.#pendingHistory = null;
		}
		this.#historyLoading = false;
	}

	/** Surfaces apply failures instead of letting the socket's recv chain swallow them. */
	#applyFrameSafe(frame: HostFrame): void {
		try {
			this.#applyFrame(frame);
		} catch (err) {
			console.warn("collab: failed to apply frame", frame.t, err);
			if (frame.t === "welcome" && !this.#welcomed) {
				this.#end(`failed to apply session snapshot: ${err instanceof Error ? err.message : String(err)}`);
				return;
			}
			this.#pushNotice("error", `failed to apply ${frame.t} frame`);
			this.#commit();
		}
	}

	#applyFrame(frame: HostFrame): void {
		switch (frame.t) {
			case "welcome":
				// Reset accumulator: a fresh welcome arriving mid-load (reconnect)
				// supersedes any partially-streamed snapshot from the prior session.
				this.#header = frame.header;
				this.#entries = [];
				this.#snapshotEntries = frame.entryCount === 0 ? null : [];
				this.#state = frame.state;
				this.#agents = [...frame.agents];
				this.#stream = null;
				this.#streamDone = false;
				this.#activeTools = new Map();
				this.#progress = new Map();
				this.#lifecycle = new Map();
				this.#working = frame.state.isStreaming;
				this.#readOnly = frame.readOnly === true;
				this.#clearPendingHistory();
				this.#historyRemaining = Math.max(0, frame.historyRemaining ?? 0);
				this.#clearUiRequests();
				this.#welcomed = true;
				this.#clearWelcomeTimer();
				if (frame.entryCount === 0) {
					this.#clearSnapshotProgressTimer();
					this.#phase = "live";
				} else {
					this.#armSnapshotProgressTimer();
				}
				this.#endedReason = null;
				break;
			case "snapshot-chunk": {
				// Accumulate privately and publish once. Rebuilding the public array
				// and React transcript after every 512 KiB frame made large histories
				// quadratic and repeatedly decoded their images while still loading.
				const accumulator = this.#snapshotEntries ?? [];
				accumulator.push(...frame.entries);
				this.#snapshotEntries = accumulator;
				if (frame.final) {
					this.#entries = accumulator;
					this.#snapshotEntries = null;
					this.#clearSnapshotProgressTimer();
					this.#phase = "live";
				} else {
					this.#armSnapshotProgressTimer();
				}
				break;
			}
			case "entry":
				if (this.#snapshotEntries !== null) this.#snapshotEntries.push(frame.entry);
				else this.#entries = [...this.#entries, frame.entry];
				if (this.#streamDone && frame.entry.type === "message" && frame.entry.message.role === "assistant") {
					this.#stream = null;
					this.#streamDone = false;
				}
				break;
			case "event":
				this.#applyEvent(frame.event);
				break;
			case "state":
				this.#state = frame.state;
				// Host state is authoritative for liveness in both directions: the
				// payload is built at fire time, so `isStreaming` is never stale.
				// This covers a connected guest that misses the discrete `agent_start`
				// without receiving a new `welcome` (for example, mid-stream).
				this.#working = frame.state.isStreaming;
				if (!frame.state.isStreaming) {
					// Host idle implies no tool can be running, so clear any card
					// pinned by a dropped `tool_execution_end` off this signal.
					this.#activeTools = new Map();
					if (this.#streamDone) {
						this.#stream = null;
						this.#streamDone = false;
					}
				}
				break;
			case "agents":
				this.#agents = [...frame.agents];
				break;
			case "bus":
				if (frame.channel === "task:subagent:progress") {
					const payload = frame.data as SubagentProgressPayload;
					this.#progress = new Map(this.#progress).set(payload.progress.id, payload);
				} else if (frame.channel === "task:subagent:lifecycle") {
					const payload = frame.data as SubagentLifecyclePayload;
					this.#lifecycle = new Map(this.#lifecycle).set(payload.id, payload);
				}
				break;
			case "ui-request":
				if (this.#uiRequest) this.#uiRequestQueue = [...this.#uiRequestQueue, frame.request];
				else this.#uiRequest = frame.request;
				break;
			case "ui-request-end":
				if (this.#uiRequest?.reqId === frame.reqId) this.#showNextUiRequest();
				else this.#uiRequestQueue = this.#uiRequestQueue.filter(request => request.reqId !== frame.reqId);
				break;
			case "model-list":
				this.#modelListRequested = false;
				this.#models = frame.models;
				break;
			case "transcript": {
				const pending = this.#pendingTranscripts.get(frame.reqId);
				if (pending) {
					this.#pendingTranscripts.delete(frame.reqId);
					clearTimeout(pending.timer);
					pending.resolve(
						frame.error !== undefined
							? { kind: "error", message: frame.error }
							: { kind: "rows", text: frame.text, newSize: frame.newSize },
					);
				}
				break;
			}
			case "history": {
				if (this.#pendingHistory?.reqId !== frame.reqId) return;
				this.#clearPendingHistory();
				if (frame.error !== undefined) {
					this.#pushNotice("error", frame.error);
					break;
				}
				const existingIds = new Set(this.#entries.map(entry => entry.id));
				const older = frame.entries.filter(entry => !existingIds.has(entry.id));
				this.#entries = [...older, ...this.#entries];
				this.#historyRemaining = Math.max(0, frame.remaining);
				break;
			}
			case "image": {
				const pending = this.#pendingImages.get(frame.reqId);
				if (!pending) return;
				this.#pendingImages.delete(frame.reqId);
				clearTimeout(pending.timer);
				const expectedKey = `${frame.variant}:${frame.imageId}`;
				if (
					pending.key !== expectedKey ||
					frame.error !== undefined ||
					frame.data === undefined ||
					frame.mimeType === undefined
				) {
					pending.resolve(null);
					return;
				}
				const image = { data: frame.data, mimeType: frame.mimeType };
				this.#imageCache.set(pending.key, image);
				pending.resolve(image);
				return;
			}
			case "media-imported": {
				const pending = this.#pendingMediaImports.get(frame.reqId);
				if (!pending) return;
				this.#pendingMediaImports.delete(frame.reqId);
				clearTimeout(pending.timer);
				if (frame.error !== undefined || frame.media === undefined) {
					pending.reject(new Error(frame.error ?? "image import failed"));
					return;
				}
				pending.resolve(frame.media);
				return;
			}
			case "bye":
				this.#end(frame.reason);
				return; // #end already committed
			case "error":
				if (!this.#welcomed) {
					// Pre-welcome errors are the host's targeted reply to our
					// hello (e.g. protocol mismatch): no welcome will follow.
					// End with the host's reason instead of waiting out the
					// welcome timeout.
					this.#end(frame.message);
					return; // #end already committed
				}
				this.#pushNotice("error", frame.message);
				break;
			default:
				// unknown frame type from a newer host — ignore
				break;
		}
		this.#commit();
	}

	#applyEvent(event: Extract<HostFrame, { t: "event" }>["event"]): void {
		switch (event.type) {
			case "message_start":
			case "message_update":
				if (event.message.role === "assistant") {
					this.#stream = event.message;
					this.#streamDone = false;
				}
				break;
			case "message_end":
				if (event.message.role === "assistant") {
					this.#stream = event.message;
					this.#streamDone = true;
				}
				break;
			case "tool_execution_start": {
				const tool: ActiveTool = {
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					args: event.args,
					intent: event.intent,
					startedAt: Date.now(),
				};
				this.#activeTools = new Map(this.#activeTools).set(event.toolCallId, tool);
				break;
			}
			case "tool_execution_update": {
				const existing = this.#activeTools.get(event.toolCallId);
				const tool: ActiveTool = existing
					? { ...existing, partialResult: event.partialResult }
					: {
							toolCallId: event.toolCallId,
							toolName: event.toolName,
							args: event.args,
							partialResult: event.partialResult,
							startedAt: Date.now(),
						};
				this.#activeTools = new Map(this.#activeTools).set(event.toolCallId, tool);
				break;
			}
			case "tool_execution_end": {
				const next = new Map(this.#activeTools);
				next.delete(event.toolCallId);
				this.#activeTools = next;
				break;
			}
			case "agent_start":
				this.#working = true;
				break;
			case "agent_end":
				this.#working = false;
				break;
			case "notice":
				this.#pushNotice(event.level, event.message);
				break;
			case "auto_retry_start":
				this.#pushNotice("info", `retry ${event.attempt}/${event.maxAttempts}: ${event.errorMessage}`);
				break;
			case "auto_retry_end":
				if (!event.success) this.#pushNotice("error", event.finalError ?? "retry failed");
				break;
			case "auto_compaction_start":
				this.#pushNotice("info", `compacting context (${event.reason})`);
				break;
			case "auto_compaction_end":
				if (!event.skipped) {
					this.#pushNotice(
						"info",
						event.aborted
							? "compaction aborted"
							: event.errorMessage
								? `compaction failed: ${event.errorMessage}`
								: "context compacted",
					);
				}
				break;
			default:
				// turn_start/turn_end/thinking_level_changed/unknown — ignore
				break;
		}
	}

	#pushNotice(level: Notice["level"], message: string): void {
		const notice: Notice = { id: ++this.#noticeSeq, level, message, at: Date.now() };
		const next = [...this.#notices, notice];
		if (next.length > MAX_NOTICES) next.splice(0, next.length - MAX_NOTICES);
		this.#notices = next;
	}

	#clearUiRequests(): void {
		this.#uiRequest = null;
		this.#uiRequestQueue = [];
	}

	#showNextUiRequest(): void {
		const [next, ...rest] = this.#uiRequestQueue;
		this.#uiRequest = next ?? null;
		this.#uiRequestQueue = rest;
	}

	#buildSnapshot(): GuestSnapshot {
		return {
			phase: this.#phase,
			endedReason: this.#endedReason,
			header: this.#header,
			entries: this.#entries,
			state: this.#state,
			agents: this.#agents,
			progress: this.#progress,
			lifecycle: this.#lifecycle,
			stream: this.#stream,
			streamDone: this.#streamDone,
			activeTools: this.#activeTools,
			working: this.#working,
			readOnly: this.#readOnly,
			uiRequest: this.#uiRequest,
			models: this.#models,
			historyRemaining: this.#historyRemaining,
			historyLoading: this.#historyLoading,
			notices: this.#notices,
		};
	}

	#commit(): void {
		this.#snapshot = this.#buildSnapshot();
		for (const listener of this.#listeners) listener();
	}
}
