/**
 * Shared wire types for the omp collab live-session protocol.
 *
 * Dependency-free JSON shapes produced by `@oh-my-pi/pi-coding-agent`
 * (`src/collab/protocol.ts` and friends). Browser and test clients import this
 * package instead of depending on the coding-agent runtime; conformance is
 * asserted type-only in `packages/coding-agent/test/collab/web-wire.types.ts`.
 *
 * Unknown entry/event variants arrive over the wire as plain JSON. The unions
 * below cover only the variants this client renders; consumers cast at the
 * JSON boundary and every `switch` keeps a tolerant `default:` branch.
 */

// ═══════════════════════════════════════════════════════════════════════════
// Content blocks
// ═══════════════════════════════════════════════════════════════════════════

export interface TextContent {
	type: "text";
	text: string;
}

export interface ImageContent {
	type: "image";
	/**
	 * Base64-encoded image data. Empty when {@link imageId} identifies media
	 * that the guest must fetch lazily through `fetch-image`.
	 */
	data: string;
	/** e.g. "image/png". */
	mimeType: string;
	/** SHA-256 id of host-side media omitted from a replication frame. */
	imageId?: string;
}

export type ImageVariant = "thumbnail" | "original";

/**
 * Reference to a file that remains at its original path on the host machine.
 * The file bytes are deliberately not embedded in the collaboration frame or
 * copied into the session artifacts directory.
 */
export interface LocalFileReference {
	kind: "local-file";
	path: string;
	name: string;
}

/** Result of persisting a pathless clipboard/screenshot image on the host. */
export interface ManagedImageReference {
	file: LocalFileReference;
	/** SHA-256 content id; useful for diagnostics and future thumbnail caches. */
	imageId: string;
	mimeType: string;
	/** Small, ephemeral preview. It is never written into the session journal. */
	thumbnail?: ImageContent;
}

/** Managed clipboard/screenshot upload bounds shared by desktop guest and Core. */
export const MANAGED_IMAGE_MAX_BYTES = 24 * 1024 * 1024;
export const MANAGED_IMAGE_MAX_BASE64_CHARS = Math.ceil((MANAGED_IMAGE_MAX_BYTES * 4) / 3) + 4;
export const MANAGED_IMAGE_CHUNK_CHARS = 512 * 1024;

export interface ThinkingContent {
	type: "thinking";
	thinking: string;
}

export interface RedactedThinkingContent {
	type: "redactedThinking";
	data: string;
}

export interface ToolCallContent {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
	intent?: string;
}

export type AssistantContent = TextContent | ThinkingContent | RedactedThinkingContent | ToolCallContent;

export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

export interface WireUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: { total: number };
}

// ═══════════════════════════════════════════════════════════════════════════
// Messages
// ═══════════════════════════════════════════════════════════════════════════

export interface UserMessage {
	role: "user";
	content: string | (TextContent | ImageContent)[];
	/** True if the message was injected by the system (e.g. auto-continue). */
	synthetic?: boolean;
	/** Unix timestamp in milliseconds. */
	timestamp: number;
}

export interface DeveloperMessage {
	role: "developer";
	content: string | (TextContent | ImageContent)[];
	timestamp: number;
}

export interface AssistantMessage {
	role: "assistant";
	content: AssistantContent[];
	model: string;
	usage: WireUsage;
	stopReason: StopReason;
	errorMessage?: string;
	timestamp: number;
}

export interface ToolResultMessage {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: (TextContent | ImageContent)[];
	details?: unknown;
	isError: boolean;
	timestamp: number;
}

export type WireMessage = UserMessage | DeveloperMessage | AssistantMessage | ToolResultMessage;

// ═══════════════════════════════════════════════════════════════════════════
// Session entries (rendered subset; cast `as SessionEntry` at the JSON
// boundary and skip unknown `type`s in a tolerant `default:`)
// ═══════════════════════════════════════════════════════════════════════════

export interface SessionHeader {
	type: "session";
	id: string;
	title?: string;
	timestamp: string;
	cwd: string;
}

export interface EntryBase {
	id: string;
	parentId: string | null;
	timestamp: string;
}

export interface MessageEntry extends EntryBase {
	type: "message";
	message: WireMessage;
}

export interface CustomMessageEntry extends EntryBase {
	type: "custom_message";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	details?: unknown;
	display: boolean;
}

export interface CompactionEntry extends EntryBase {
	type: "compaction";
	summary: string;
	shortSummary?: string;
	firstKeptEntryId: string;
	tokensBefore: number;
}

export interface BranchSummaryEntry extends EntryBase {
	type: "branch_summary";
	fromId: string;
	summary: string;
}

export interface ModelChangeEntry extends EntryBase {
	type: "model_change";
	/** Model in "provider/modelId" format. */
	model: string;
	role?: string;
}

export interface ThinkingLevelChangeEntry extends EntryBase {
	type: "thinking_level_change";
	thinkingLevel?: string | null;
}

export type SessionEntry =
	| MessageEntry
	| CustomMessageEntry
	| CompactionEntry
	| BranchSummaryEntry
	| ModelChangeEntry
	| ThinkingLevelChangeEntry;

/** customType of collab guest prompts injected on the host. */
export const COLLAB_PROMPT_MESSAGE_TYPE = "collab-prompt";

/** `details` shape of `custom_message` entries with `customType === "collab-prompt"`. */
export interface CollabPromptDetails {
	from?: string;
	/** Original composer text, without the model-only local-file reference block. */
	displayText?: string;
	/** Host-local paths shown as attachment chips in capable clients. */
	localFiles?: LocalFileReference[];
}

// ═══════════════════════════════════════════════════════════════════════════
// Events (handled subset)
// ═══════════════════════════════════════════════════════════════════════════

export type AgentEvent =
	| { type: "agent_start" }
	| { type: "agent_end" }
	| { type: "turn_start" }
	| { type: "turn_end" }
	| { type: "message_start"; message: WireMessage }
	/** Carries the FULL accumulating partial message — no delta tracking needed. */
	| { type: "message_update"; message: WireMessage }
	| { type: "message_end"; message: WireMessage }
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown; intent?: string }
	| { type: "tool_execution_update"; toolCallId: string; toolName: string; args: unknown; partialResult: unknown }
	| { type: "tool_execution_end"; toolCallId: string; toolName: string; result: unknown; isError?: boolean }
	| { type: "notice"; level: "info" | "warning" | "error"; message: string; source?: string }
	| { type: "auto_compaction_start"; reason: string; action: string }
	| { type: "auto_compaction_end"; aborted: boolean; willRetry: boolean; errorMessage?: string; skipped?: boolean }
	| { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
	| { type: "thinking_level_changed"; thinkingLevel?: string };

// ═══════════════════════════════════════════════════════════════════════════
// State & agents
// ═══════════════════════════════════════════════════════════════════════════

export interface WireModel {
	id: string;
	name: string;
	provider: string;
	contextWindow: number | null;
}

export interface ContextUsage {
	tokens: number | null;
	contextWindow: number | null;
	percent: number | null;
}

export interface Participant {
	name: string;
	role: "host" | "guest";
	/** True when the guest joined through a read-only (view) link. */
	readOnly?: boolean;
}

/** Debounced footer snapshot broadcast by the host. */
export interface SessionState {
	isStreaming: boolean;
	queuedMessageCount: number;
	sessionName?: string;
	/** Host cwd — display only; the guest never chdirs. */
	cwd: string;
	model?: WireModel;
	/** Effective concrete effort currently applied by the host. */
	thinkingLevel?: string;
	/** User-selected thinking mode; preserves `auto` while its concrete effort changes per turn. */
	configuredThinkingLevel?: string;
	/** Selectors accepted by `thinking-change`, in host display order. */
	availableThinkingLevels?: string[];
	contextUsage?: ContextUsage;
	participants: Participant[];
	isAborting?: boolean;
}

export interface AgentSnapshot {
	id: string;
	displayName: string;
	kind: "main" | "sub";
	parentId?: string;
	status: "running" | "idle" | "parked" | "aborted";
	/** Whether the host has a transcript file for this agent (gates remote transcript fetch). */
	hasSessionFile: boolean;
	createdAt: number;
	lastActivity: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// Bus payloads (task subagent lifecycle/progress channels)
// ═══════════════════════════════════════════════════════════════════════════

export interface AgentProgress {
	index: number;
	id: string;
	agent: string;
	status: "pending" | "running" | "completed" | "failed" | "aborted";
	task: string;
	description?: string;
	lastIntent?: string;
	currentTool?: string;
	currentToolArgs?: string;
	currentToolStartMs?: number;
	recentTools: { tool: string; args: string; endMs: number }[];
	recentOutput: string[];
	toolCount: number;
	requests: number;
	tokens: number;
	contextTokens?: number;
	contextWindow?: number;
	cost: number;
	durationMs: number;
	resolvedModel?: string;
}

export interface SubagentProgressPayload {
	index: number;
	agent: string;
	task: string;
	parentToolCallId?: string;
	assignment?: string;
	progress: AgentProgress;
	sessionFile?: string;
}

export interface SubagentLifecyclePayload {
	id: string;
	agent: string;
	description?: string;
	status: "started" | "completed" | "failed" | "aborted";
	sessionFile?: string;
	parentToolCallId?: string;
	index: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// Frames (JSON inside the AES-GCM seal)
// ═══════════════════════════════════════════════════════════════════════════

export type CollabUiSelectItem = string | { label: string; description?: string };

export type CollabUiResponseValue = string | undefined;

/** Filters supported by the chat-history search panel. */
export type ChatSearchKind = "all" | "text" | "image" | "file" | "link";
export type ChatSearchRole = "all" | "user" | "assistant";

/** One compact hit returned by the host without copying the full transcript entry. */
export interface ChatSearchResult {
	entryId: string;
	/** Native/Web transcript row that should be revealed when the result is activated. */
	rowId: string;
	kind: Exclude<ChatSearchKind, "all">;
	role: Exclude<ChatSearchRole, "all">;
	timestamp: string;
	snippet: string;
	/** Zero-based position in the durable session, used only for progress/diagnostics. */
	ordinal: number;
}

export type SpeechInputState = "idle" | "preparing" | "recording" | "transcribing";

/** Incremental host-side microphone/STT state for the desktop composer. */
export interface SpeechInputSnapshot {
	state: SpeechInputState;
	/** Full current utterance (committed segments plus the latest partial). */
	text: string;
	status?: string;
	error?: string;
	/** True only on the terminal frame whose text should remain in the composer. */
	final?: boolean;
}

export type CollabUiRequestDraft =
	| {
			kind: "select";
			title: string;
			options: CollabUiSelectItem[];
			initialIndex?: number;
			selectionMarker?: "radio" | "checkbox";
			checkedIndices?: number[];
			markableCount?: number;
			helpText?: string;
	  }
	| {
			kind: "editor";
			title: string;
			prefill?: string;
	  };

export type CollabUiRequest = CollabUiRequestDraft & { reqId: number };

export type GuestFrame =
	| {
			t: "hello";
			proto: number;
			name: string;
			/**
			 * base64url write token proving full-link possession; absent for
			 * read-only (view) links. The host marks peers without a valid token
			 * read-only and rejects their mutating frames.
			 */
			writeToken?: string;
			/**
			 * Advertises support for image references and lazy `fetch-image`
			 * replies. Hosts keep sending inline media to guests that omit it.
			 */
			mediaRefs?: boolean;
			/**
			 * Requests a bounded tail snapshot followed by explicit older-history
			 * pages. Hosts that do not understand this field keep sending the full
			 * snapshot, so protocol-v5 clients remain backwards compatible.
			 */
			historyPaging?: boolean;
	  }
	| { t: "prompt"; text: string; images?: ImageContent[]; localFiles?: LocalFileReference[] }
	| { t: "ui-response"; reqId: number; value?: CollabUiResponseValue }
	| { t: "abort" }
	| { t: "agent-cmd"; cmd: "chat" | "kill" | "revive"; agentId: string; text?: string }
	| { t: "fetch-transcript"; reqId: number; agentId: string; fromByte: number }
	/** Fetch entries immediately preceding the stable first visible entry id. */
	| { t: "fetch-history"; reqId: number; beforeId: string; limit: number }
	/** Fetch one image exposed through an `ImageContent.imageId`. */
	| { t: "fetch-image"; reqId: number; imageId: string; variant: ImageVariant }
	/** Search the durable current-session transcript without loading all history into the WebView. */
	| {
			t: "chat-search";
			reqId: number;
			query: string;
			kind: ChatSearchKind;
			role: ChatSearchRole;
			/** Local calendar date (`YYYY-MM-DD`), or omitted for all dates. */
			date?: string;
			limit: number;
	  }
	/** Start/stop/cancel host-side local microphone transcription. */
	| { t: "speech-input"; action: "start" | "stop" | "cancel" }
	/** Persist a pathless clipboard/screenshot image in the host media library. */
	| {
			t: "media-import";
			reqId: number;
			data: string;
			mimeType: string;
			name?: string;
			/** Zero-based chunk position; each frame stays well below relay limits. */
			chunkIndex: number;
			chunkCount: number;
	  }
	/** Request the available models for the session room (targeted reply: `model-list` host frame). */
	| { t: "model-list" }
	/** Switch the session model; success is broadcast to all guests through the regular `state` frame. */
	| { t: "model-change"; provider: string; id: string }
	/** Switch the session thinking selector; success is broadcast through the regular `state` frame. */
	| { t: "thinking-change"; level: string };

/** EventBus channels mirrored to guests (task subagent traffic only). */
export type BusChannel = "task:subagent:progress" | "task:subagent:lifecycle";

export type HostFrame =
	| {
			t: "welcome";
			proto: number;
			header: SessionHeader;
			state: SessionState;
			agents: AgentSnapshot[];
			/**
			 * Total number of `SessionEntry` items the host will deliver in the
			 * `snapshot-chunk` frames that follow. Guests stay in the loading
			 * phase until they have accumulated all of them (or a chunk arrives
			 * with `final: true`).
			 */
			entryCount: number;
			/** Older entries omitted from the initial snapshot for paging-capable guests. */
			historyRemaining?: number;
			/** True when this peer joined through a read-only (view) link. */
			readOnly?: boolean;
	  }
	/**
	 * Targeted snapshot fragment delivered after `welcome`. Hosts split the
	 * transcript into chunks bounded by byte size so a multi-MB session is not
	 * forced through one giant frame the relay may stall on. The last chunk
	 * carries `final: true`; guests finalize the replica on that frame.
	 */
	| { t: "snapshot-chunk"; entries: SessionEntry[]; final: boolean }
	| { t: "entry"; entry: SessionEntry }
	| { t: "event"; event: AgentEvent }
	| { t: "state"; state: SessionState }
	/** Mirrored EventBus traffic (task subagent lifecycle/progress channels only). */
	| { t: "bus"; channel: BusChannel; data: unknown }
	| { t: "agents"; agents: AgentSnapshot[] }
	| { t: "ui-request"; request: CollabUiRequest }
	| { t: "ui-request-end"; reqId: number }
	/** Targeted reply to fetch-transcript; `text` is decoded JSONL from `fromByte`, `newSize` the next offset base. */
	| { t: "transcript"; reqId: number; text: string; newSize: number; error?: string }
	/** Targeted page of session entries ordered oldest-to-newest. */
	| { t: "history"; reqId: number; entries: SessionEntry[]; remaining: number; error?: string }
	/** Targeted compact chat-search reply. */
	| {
			t: "chat-search-results";
			reqId: number;
			results: ChatSearchResult[];
			total: number;
			truncated: boolean;
			error?: string;
	  }
	/** Targeted microphone/STT lifecycle and incremental transcript. */
	| ({ t: "speech-input-state" } & SpeechInputSnapshot)
	/** Targeted lazy-media reply. `error` replies omit `data` and `mimeType`. */
	| {
			t: "image";
			reqId: number;
			imageId: string;
			variant: ImageVariant;
			data?: string;
			mimeType?: string;
			error?: string;
	  }
	/** Targeted result of a `media-import` request. */
	| { t: "media-imported"; reqId: number; media?: ManagedImageReference; error?: string }
	/** Targeted reply to `model-list`. */
	| { t: "model-list"; models: WireModel[] }
	| { t: "bye"; reason: string }
	| { t: "error"; message: string };

export type WireFrame = GuestFrame | HostFrame;

// ═══════════════════════════════════════════════════════════════════════════
// Control room frames (session registry / multi-session control room)
// ═══════════════════════════════════════════════════════════════════════════

export type ControlGuestFrame =
	| { t: "ctrl-hello"; proto: number; name: string; writeToken?: string }
	| { t: "ctrl-list" }
	| { t: "ctrl-create"; cwd?: string }
	| { t: "ctrl-resume"; id: string }
	| { t: "ctrl-rename"; id: string; title: string }
	| { t: "ctrl-archive"; reqId: number; id: string }
	| { t: "ctrl-archived-list"; reqId: number }
	| { t: "ctrl-delete-archived"; reqId: number; id: string }
	| { t: "ctrl-restore"; reqId: number; id: string }
	| { t: "ctrl-import-list"; reqId: number; source: "codex"; archived: boolean }
	| {
			t: "ctrl-import";
			reqId: number;
			source: "codex";
			id: string;
			path: string;
			archived: boolean;
			/** Explicit confirmation that a diverged OMP continuation may be merged chronologically. */
			merge?: boolean;
	  };

export type ControlHostFrame =
	| { t: "ctrl-welcome"; proto: number; readOnly?: true }
	| { t: "ctrl-sessions"; sessions: SessionSummary[] }
	| { t: "ctrl-session"; op: "created" | "resumed"; id: string; link: string; title?: string }
	| { t: "ctrl-archived"; reqId: number; id: string }
	| { t: "ctrl-archived-list"; reqId: number; sessions: SessionSummary[] }
	| { t: "ctrl-archived-deleted"; reqId: number; id: string }
	| { t: "ctrl-restored"; reqId: number; session: SessionSummary }
	| { t: "ctrl-import-list"; reqId: number; source: "codex"; sessions: ForeignSessionSummary[] }
	| { t: "ctrl-import-conflict"; reqId: number; source: "codex"; conflict: ForeignSessionImportConflict }
	| { t: "ctrl-imported"; reqId: number; source: "codex"; session: ImportedForeignSession }
	| { t: "ctrl-request-error"; reqId: number; message: string }
	| { t: "ctrl-error"; message: string }
	| { t: "ctrl-bye"; reason: string };

/** Read-only metadata shown before importing a locally stored foreign transcript. */
export interface ForeignSessionSummary {
	source: "codex";
	id: string;
	path: string;
	cwd: string;
	title?: string;
	description?: string;
	archived: boolean;
	createdAt: string;
	modifiedAt: string;
	messageCount?: number;
	firstMessage?: string;
}

/** Fresh OMP identity produced after a foreign transcript has been persisted. */
export interface ImportedForeignSession {
	id: string;
	cwd: string;
	title?: string;
	requiresProjectSwitch: boolean;
}

/** Existing OMP continuation that requires an explicit chronological merge. */
export interface ForeignSessionImportConflict {
	kind: "conflict";
	existingSessionId: string;
	cwd: string;
	title?: string;
	/** Number of OMP chats created from the same Codex source id. */
	duplicateCount: number;
	/** User/assistant messages added on the OMP side after import. */
	localMessageCount: number;
}

export interface SessionSummary {
	id: string;
	title?: string;
	cwd: string;
	createdAt: string;
	modifiedAt: string;
	messageCount: number;
	status?: SessionStatus;
	running: boolean;
	streaming: boolean;
	link?: string; // 仅全权(read-write)控制端可见
}

export type SessionStatus = "complete" | "interrupted" | "aborted" | "error" | "pending" | "unknown";

/**
 * Wire protocol version carried in `hello`; the host rejects mismatches.
 *
 * - `1` (legacy): `welcome` carried the full `entries` array inline.
 * - `2`: `welcome` carries only metadata (header/state/agents/entryCount);
 *   transcript entries follow in `snapshot-chunk` frames, so multi-MB
 *   sessions are not gated on a single welcome frame fitting under the
 *   guest's first-welcome timeout.
 * - `3`: host asks guests through `ui-request`/`ui-request-end` host frames
 *   answered by the `ui-response` guest frame. Guests that predate the
 *   grammar would silently drop `ui-request` (asks hang forever on the
 *   host), so they must be rejected at hello.
 * - `4`: guests can request the session model list (`model-list`), switch the
 *   session model (`model-change`), and select a host-advertised thinking
 *   effort (`thinking-change`); the host broadcasts authoritative model and
 *   thinking state through the regular `state` frame.
 * - `5`: capability-negotiated desktop optimizations: media-reference-capable
 *   guests receive content-addressed image ids and fetch thumbnails/originals
 *   lazily; history-paging guests receive a bounded tail snapshot and request
 *   older entries by stable id. Guests omitting either capability retain the
 *   full legacy snapshot behavior.
 * - `6`: writable guests can persist pathless clipboard/screenshot images in
 *   the host media library and keep only the returned path reference in chat.
 */
export const COLLAB_PROTO = 6;

/** Parameter key used for intent tracing (e.g. prompt explanation/reasoning) */
export const INTENT_FIELD = "i";

// ═══════════════════════════════════════════════════════════════════════════
// Envelope & link constants
// ═══════════════════════════════════════════════════════════════════════════

/** Plaintext envelope prefix: `[4B uint32 BE peerId][sealed payload]`. */
export const ENVELOPE_HEADER_LENGTH = 4;

export const ROOM_ID_BYTES = 16;

/** AES-256-GCM room key; the seal key for every collab frame. */
export const ROOM_KEY_BYTES = 32;

/**
 * Random write token appended to the room key in full links
 * (`base64url(key ∥ token)`); view links carry the bare key. Possession
 * proves prompt/abort/agent-cmd capability to the host.
 */
export const WRITE_TOKEN_BYTES = 16;

/** Default public relay; bare `<roomId>.<key>` links resolve against it. */
export const DEFAULT_RELAY_URL = "wss://my.omp.sh";

/** Default share viewer/upload base; `/share` links resolve against `<base>/<id>#<key>`. */
export const DEFAULT_SHARE_URL = "https://my.omp.sh/s";

export interface ParsedCollabLink {
	/** wss://host[:port]/r/<roomId> — no query, no fragment. */
	wsUrl: string;
	roomId: string;
	key: Uint8Array;
	/** Write token from a full link; absent for read-only (view) links. */
	writeToken?: Uint8Array;
}

// ═══════════════════════════════════════════════════════════════════════════
// Relay control messages (TEXT JSON, unencrypted, no session data)
// ═══════════════════════════════════════════════════════════════════════════

/** Relay → host control message. */
export type RelayControlToHost = { t: "peer-joined" | "peer-left"; peer: number };
/** Relay → guest control message. */
export type RelayControlToGuest = { t: "room-closed" };
export type RelayControlMessage = RelayControlToHost | RelayControlToGuest;
