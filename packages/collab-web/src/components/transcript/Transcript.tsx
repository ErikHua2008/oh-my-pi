import {
	type AssistantMessage,
	COLLAB_PROMPT_MESSAGE_TYPE,
	type ImageContent,
	type LocalFileReference,
	type SessionEntry,
	type TextContent,
	type ToolResultMessage,
} from "@oh-my-pi/pi-wire";
import { Check, ChevronRight, Copy, File, Pencil } from "lucide-react";
import type { ReactNode } from "react";
import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ActiveTool } from "../../lib/client";
import {
	copyText,
	type DesktopBridge,
	type DesktopNativeTranscriptEvent,
	desktopBridge as defaultDesktopBridge,
} from "../../lib/desktop-bridge";
import { fmtTokens } from "../../lib/format";
import { nativeSurfacesBlocked, subscribeNativeSurfaceVisibility } from "../../lib/native-surface-visibility";
import { nativeStreamRowId, projectNativeStream, projectNativeTranscript } from "../../lib/native-transcript";
import {
	INITIAL_STREAM_BATCH_DELAY_MS,
	STREAM_BATCH_MAX_DELAY_MS,
	shouldFlushAssistantStreamBatch,
} from "../../lib/stream-presentation";
import { useSystemTheme } from "../../lib/theme";
import { isSystemReminder, transcriptToolPresentation } from "../../lib/transcript-presentation";
import {
	type AssistantEntry,
	isTranscriptUserPrompt,
	projectTranscriptItems,
	type TranscriptAssistantTurn,
} from "../../lib/transcript-turns";
import type { ToolRenderHost } from "../../tool-render";
import { Markdown } from "./Markdown";
import { ToolCard } from "./ToolCard";
import "./transcript.css";

export interface TranscriptProps {
	entries: readonly SessionEntry[];
	stream: AssistantMessage | null;
	streamDone: boolean;
	activeTools: ReadonlyMap<string, ActiveTool>;
	working: boolean;
	compact?: boolean; // dense variant for the agent drawer
	/** Sub-session drill-down capabilities forwarded to tool renderers. */
	host?: ToolRenderHost;
	/** Opens the composer with the final user prompt for editing and re-sending. */
	onEditLastUserMessage?: (text: string) => void;
	/** Injectable native bridge used for one batched status check per visible page. */
	desktop?: DesktopBridge;
	/** Stable identity used to reset the local render window only when the session changes. */
	sessionId?: string | null;
	/** Entries still retained by a paging-capable host rather than this WebView. */
	historyRemaining?: number;
	historyLoading?: boolean;
	onLoadEarlier?: () => void;
}

function Row({
	kind,
	speaker,
	title,
	children,
}: {
	kind: "user" | "assistant" | "custom" | "marker";
	speaker: string;
	title?: string;
	children: ReactNode;
}): ReactNode {
	return (
		<div className={`tr-row tr-row--${kind}`} title={title}>
			<span className="tr-speaker">{speaker}</span>
			<div className="tr-body">{children}</div>
		</div>
	);
}

function formatWorkDuration(durationMs: number): string {
	const roundedSeconds = Math.max(1, Math.round(durationMs / 1_000));
	const hours = Math.floor(roundedSeconds / 3_600);
	const minutes = Math.floor((roundedSeconds % 3_600) / 60);
	const seconds = roundedSeconds % 60;
	const parts: string[] = [];
	if (hours > 0) parts.push(`${hours}小时`);
	if (minutes > 0) parts.push(`${minutes}分钟`);
	if (seconds > 0 || parts.length === 0) parts.push(`${seconds}秒`);
	return parts.join("");
}

function WorkDisclosure({
	pending,
	durationMs,
	children,
}: {
	pending: boolean;
	durationMs?: number;
	children: ReactNode;
}): ReactNode {
	const [open, setOpen] = useState(pending);
	const contentId = useId();
	const label = pending
		? "正在思考并工作…"
		: durationMs === undefined
			? "思考并工作"
			: `思考并工作了 ${formatWorkDuration(durationMs)}`;
	useEffect(() => {
		setOpen(pending);
	}, [pending]);
	return (
		<div className="tr-think">
			<button
				type="button"
				className="tr-think-head"
				aria-expanded={open}
				aria-controls={contentId}
				onClick={() => setOpen(v => !v)}
			>
				{label}
				<ChevronRight aria-hidden size={12} className={`tr-chev${open ? " tr-chev--open" : ""}`} />
			</button>
			{open && (
				<div id={contentId} className="tr-think-body">
					{children}
				</div>
			)}
		</div>
	);
}

function usePresentedAssistantStream(
	stream: AssistantMessage | null,
	streamDone: boolean,
	sessionId?: string | null,
): AssistantMessage | null {
	const [presented, setPresented] = useState(stream);
	const presentedRef = useRef(stream);
	const latestRef = useRef(stream);
	const timerRef = useRef<number | undefined>(undefined);
	const lastFlushRef = useRef(0);
	const sessionRef = useRef(sessionId);

	useEffect(() => {
		const clearTimer = (): void => {
			if (timerRef.current === undefined) return;
			window.clearTimeout(timerRef.current);
			timerRef.current = undefined;
		};
		const flush = (): void => {
			clearTimer();
			const latest = latestRef.current;
			presentedRef.current = latest;
			lastFlushRef.current = performance.now();
			setPresented(latest);
		};

		latestRef.current = stream;
		if (sessionRef.current !== sessionId) {
			sessionRef.current = sessionId;
			flush();
			return;
		}
		if (stream === null || streamDone) {
			flush();
			return;
		}

		const now = performance.now();
		const current = presentedRef.current;
		if (current !== null && shouldFlushAssistantStreamBatch(current, stream, now - lastFlushRef.current)) {
			flush();
			return;
		}

		if (timerRef.current === undefined) {
			const delay =
				current === null
					? INITIAL_STREAM_BATCH_DELAY_MS
					: Math.max(0, STREAM_BATCH_MAX_DELAY_MS - (now - lastFlushRef.current));
			timerRef.current = window.setTimeout(flush, delay);
		}
	}, [sessionId, stream, streamDone]);

	useEffect(
		() => () => {
			if (timerRef.current !== undefined) window.clearTimeout(timerRef.current);
		},
		[],
	);

	return streamDone ? stream : presented;
}

function StreamStatus({ label }: { label: string }): ReactNode {
	return (
		<div className="tr-stream-status" role="status" aria-live="polite">
			<span className="tr-stream-dot" aria-hidden />
			<span>{label}</span>
		</div>
	);
}

function imageSource(mimeType: string, data: string): string {
	return `data:${mimeType};base64,${data}`;
}

function MessageImage({ image, host }: { image: ImageContent; host?: ToolRenderHost }): ReactNode {
	const inlineSource = image.data.length > 0 ? imageSource(image.mimeType, image.data) : null;
	const [source, setSource] = useState<string | null>(inlineSource);
	const [nearViewport, setNearViewport] = useState(inlineSource !== null);
	const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">(
		inlineSource === null ? "idle" : "ready",
	);
	const [original, setOriginal] = useState(false);
	const rootRef = useRef<HTMLDivElement | null>(null);
	const imageId = image.imageId;

	useEffect(() => {
		if (inlineSource !== null || !imageId || !host?.loadImage) return;
		const element = rootRef.current;
		if (!element || typeof IntersectionObserver === "undefined") {
			setNearViewport(true);
			return;
		}
		const observer = new IntersectionObserver(
			entries => {
				if (!entries.some(entry => entry.isIntersecting)) return;
				setNearViewport(true);
				observer.disconnect();
			},
			{ rootMargin: "800px 0px" },
		);
		observer.observe(element);
		return () => observer.disconnect();
	}, [host, imageId, inlineSource]);

	useEffect(() => {
		if (!nearViewport || source !== null || !imageId || !host?.loadImage) return;
		let disposed = false;
		setStatus("loading");
		void host.loadImage(imageId, "thumbnail").then(payload => {
			if (disposed) return;
			if (!payload) {
				setStatus("error");
				return;
			}
			setSource(imageSource(payload.mimeType, payload.data));
			setStatus("ready");
		});
		return () => {
			disposed = true;
		};
	}, [host, imageId, nearViewport, source]);

	const loadOriginal = (): void => {
		if (original || !imageId || !host?.loadImage) return;
		setStatus("loading");
		void host.loadImage(imageId, "original").then(payload => {
			if (!payload) {
				setStatus(source === null ? "error" : "ready");
				return;
			}
			setSource(imageSource(payload.mimeType, payload.data));
			setOriginal(true);
			setStatus("ready");
		});
	};

	return (
		<div ref={rootRef} className={`tr-msg-media tr-msg-media--${status}`} aria-busy={status === "loading"}>
			{source !== null ? (
				<button
					type="button"
					className="tr-msg-image-button"
					onClick={loadOriginal}
					disabled={original || !imageId || !host?.loadImage}
					title={imageId && !original ? "Load original image" : undefined}
				>
					<img
						className="tr-msg-img"
						src={source}
						alt="attachment"
						loading="lazy"
						decoding="async"
						fetchPriority="low"
					/>
				</button>
			) : (
				<div className="tr-msg-image-placeholder" role="status">
					{status === "error" ? "image unavailable" : "loading imageâ€¦"}
				</div>
			)}
		</div>
	);
}

/** Markdown + lazily resolved image thumbnails for user / custom message content. */
function MsgContent({
	content,
	host,
}: {
	content: string | readonly (TextContent | ImageContent)[];
	host?: ToolRenderHost;
}): ReactNode {
	if (typeof content === "string") return <Markdown text={content} />;
	return (
		<>
			{content.map((block, i) => {
				switch (block.type) {
					case "text":
						return <Markdown key={i} text={block.text} />;
					case "image":
						return <MessageImage key={block.imageId ?? i} image={block} host={host} />;
					default:
						return null;
				}
			})}
		</>
	);
}

function messageText(content: string | readonly (TextContent | ImageContent)[]): string {
	if (typeof content === "string") return content;
	return content
		.filter((block): block is TextContent => block.type === "text")
		.map(block => block.text)
		.join("\n");
}

interface RenderedCollabPromptDetails {
	from: string;
	displayText?: string;
	localFiles: LocalFileReference[];
}

function parseCollabPromptDetails(value: unknown): RenderedCollabPromptDetails {
	if (value === null || typeof value !== "object") return { from: "guest", localFiles: [] };
	const record = value as Record<string, unknown>;
	const localFiles: LocalFileReference[] = [];
	if (Array.isArray(record.localFiles)) {
		for (const candidate of record.localFiles) {
			if (candidate === null || typeof candidate !== "object") continue;
			const file = candidate as Record<string, unknown>;
			if (file.kind !== "local-file" || typeof file.path !== "string" || typeof file.name !== "string") continue;
			localFiles.push({ kind: "local-file", path: file.path, name: file.name });
		}
	}
	return {
		from: typeof record.from === "string" ? record.from : "guest",
		displayText: typeof record.displayText === "string" ? record.displayText : undefined,
		localFiles,
	};
}

function LocalFileChips({
	files,
	availability,
}: {
	files: readonly LocalFileReference[];
	availability: ReadonlyMap<string, boolean>;
}): ReactNode {
	if (files.length === 0) return null;
	return (
		<div className="tr-local-files" aria-label="local file references">
			{files.map(file => {
				const available = availability.get(file.path);
				return (
					<div
						key={file.path}
						className={`tr-local-file${available === false ? " tr-local-file-missing" : ""}`}
						title={file.path}
					>
						<File size={13} aria-hidden="true" />
						<span className="tr-local-file-name">{file.name}</span>
						{available === false && <span className="tr-local-file-status">unavailable</span>}
					</div>
				);
			})}
		</div>
	);
}

function copyablePromptText(text: string, localFiles: readonly LocalFileReference[]): string {
	if (localFiles.length === 0) return text;
	const paths = localFiles.map(file => file.path).join("\n");
	return text.length > 0 ? `${text}\n\n${paths}` : paths;
}

function messageTime(timestamp: string): string {
	const parsed = Date.parse(timestamp);
	if (Number.isNaN(parsed)) return timestamp;
	return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hour12: false }).format(parsed);
}

function MessageActions({
	timestamp,
	text,
	canEdit,
	onEdit,
}: {
	timestamp: string;
	text: string;
	canEdit: boolean;
	onEdit?: () => void;
}): ReactNode {
	const [copied, setCopied] = useState(false);
	const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

	useEffect(() => {
		return () => {
			if (timerRef.current !== undefined) clearTimeout(timerRef.current);
		};
	}, []);

	if (text.length === 0) return <span className="tr-message-time">{messageTime(timestamp)}</span>;

	const copy = (): void => {
		void copyText(text)
			.then(() => {
				setCopied(true);
				timerRef.current = setTimeout(() => setCopied(false), 1200);
			})
			.catch(() => {
				// Clipboard permissions are best-effort; keep the transcript usable.
			});
	};

	return (
		<div className="tr-message-actions">
			<span className="tr-message-time">{messageTime(timestamp)}</span>
			<button
				type="button"
				className="tr-message-action"
				onClick={copy}
				title="copy message"
				aria-label="copy message"
			>
				{copied ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
			</button>
			{canEdit && onEdit !== undefined && (
				<button
					type="button"
					className="tr-message-action"
					onClick={onEdit}
					title="edit and resend"
					aria-label="edit and resend"
				>
					<Pencil size={15} aria-hidden="true" />
				</button>
			)}
		</div>
	);
}

function UserMessage({
	content,
	localFiles = [],
	localFileAvailability,
	timestamp,
	canEdit,
	onEdit,
	host,
}: {
	content: string | readonly (TextContent | ImageContent)[];
	localFiles?: readonly LocalFileReference[];
	localFileAvailability: ReadonlyMap<string, boolean>;
	timestamp: string;
	canEdit: boolean;
	onEdit?: () => void;
	host?: ToolRenderHost;
}): ReactNode {
	const text = messageText(content);
	return (
		<div className="tr-user-message">
			<div className="tr-user-bubble">
				<MsgContent content={content} host={host} />
				<LocalFileChips files={localFiles} availability={localFileAvailability} />
			</div>
			<MessageActions
				timestamp={timestamp}
				text={copyablePromptText(text, localFiles)}
				canEdit={canEdit}
				onEdit={onEdit}
			/>
		</div>
	);
}

function ProcessAssistantBlocks({
	entry,
	includeText,
	results,
	active,
	pending,
	host,
}: {
	entry: AssistantEntry;
	includeText: boolean;
	results: ReadonlyMap<string, ToolResultMessage>;
	active: ReadonlyMap<string, ActiveTool>;
	pending: boolean;
	host?: ToolRenderHost;
}): ReactNode {
	const { message } = entry;
	const blocks: ReactNode[] = [];
	for (let index = 0; index < message.content.length; index++) {
		const block = message.content[index];
		if (block.type === "thinking" || block.type === "redactedThinking") {
			const reasoning: string[] = [];
			let next = index;
			for (; next < message.content.length; next++) {
				const reasoningBlock = message.content[next];
				if (reasoningBlock.type === "thinking") {
					if (reasoningBlock.thinking.length > 0) reasoning.push(reasoningBlock.thinking);
				} else if (reasoningBlock.type === "redactedThinking") {
					reasoning.push("[思考内容已由模型隐藏]");
				} else {
					break;
				}
			}
			if (reasoning.length > 0) {
				blocks.push(
					<div key={`thinking-${index}`} className="tr-work-reasoning">
						{reasoning.join("\n\n")}
					</div>,
				);
			}
			index = next - 1;
			continue;
		}
		switch (block.type) {
			case "text":
				if (includeText && block.text.length > 0) {
					blocks.push(
						<div key={index} className="tr-work-note">
							<Markdown text={block.text} />
						</div>,
					);
				}
				break;
			case "toolCall": {
				if (transcriptToolPresentation(block.name) === "hidden") break;
				const act = active.get(block.id);
				const result = results.get(block.id);
				const args = act?.args ?? block.arguments;
				blocks.push(
					<ToolCard
						key={block.id}
						toolCallId={block.id}
						name={block.name}
						intent={block.intent ?? act?.intent}
						args={args}
						result={result}
						host={host}
						running={!result && (act !== undefined || pending)}
						partialResult={act?.partialResult}
					/>,
				);
				break;
			}
			default:
				break;
		}
	}
	const failed = message.stopReason === "error" || message.stopReason === "aborted";
	if (includeText && failed) {
		blocks.push(
			<div key="process-error" className="tr-stop">
				<span className={`tr-chip ${message.stopReason === "error" ? "tr-chip--err" : "tr-chip--warn"}`}>
					{message.stopReason}
				</span>
				{message.errorMessage !== undefined && message.errorMessage.length > 0 && (
					<span className="tr-stop-msg">{message.errorMessage}</span>
				)}
			</div>,
		);
	}
	return blocks;
}

function FinalAssistantBody({ message }: { message: AssistantMessage }): ReactNode {
	const failed = message.stopReason === "error" || message.stopReason === "aborted";
	return (
		<>
			{message.content.map((block, index) =>
				block.type === "text" && block.text.length > 0 ? (
					<div key={index} className="tr-assistant-bubble">
						<Markdown text={block.text} />
					</div>
				) : null,
			)}
			{failed && (
				<div className="tr-stop">
					<span className={`tr-chip ${message.stopReason === "error" ? "tr-chip--err" : "tr-chip--warn"}`}>
						{message.stopReason}
					</span>
					{message.errorMessage !== undefined && message.errorMessage.length > 0 && (
						<span className="tr-stop-msg">{message.errorMessage}</span>
					)}
				</div>
			)}
		</>
	);
}

function streamIsFinal(message: AssistantMessage): boolean {
	return (
		message.stopReason !== "toolUse" &&
		!message.content.some(block => block.type === "toolCall") &&
		(message.content.some(block => block.type === "text" && block.text.length > 0) ||
			Boolean(message.errorMessage) ||
			message.stopReason === "error" ||
			message.stopReason === "aborted")
	);
}

function streamHasProcess(message: AssistantMessage): boolean {
	const final = streamIsFinal(message);
	return message.content.some(block => {
		switch (block.type) {
			case "thinking":
				return block.thinking.length > 0;
			case "redactedThinking":
				return true;
			case "toolCall":
				return transcriptToolPresentation(block.name) !== "hidden";
			case "text":
				return !final && block.text.length > 0;
			default:
				return false;
		}
	});
}

function AssistantTurnBody({
	turn,
	results,
	active,
	pending,
	stream,
	streamDone,
	host,
}: {
	turn?: TranscriptAssistantTurn;
	results: ReadonlyMap<string, ToolResultMessage>;
	active: ReadonlyMap<string, ActiveTool>;
	pending: boolean;
	stream: AssistantMessage | null;
	streamDone: boolean;
	host?: ToolRenderHost;
}): ReactNode {
	const committedToolIds = new Set<string>();
	for (const entry of turn?.assistantEntries ?? []) {
		for (const block of entry.message.content) {
			if (block.type === "toolCall") committedToolIds.add(block.id);
		}
	}
	const streamedToolIds = new Set<string>();
	if (stream !== null) {
		for (const block of stream.content) {
			if (block.type === "toolCall") streamedToolIds.add(block.id);
		}
	}
	const tailTools = [...active.values()].filter(
		tool =>
			!committedToolIds.has(tool.toolCallId) &&
			!streamedToolIds.has(tool.toolCallId) &&
			transcriptToolPresentation(tool.toolName) !== "hidden",
	);
	const liveProcess = stream !== null && streamHasProcess(stream);
	const hasProcess = Boolean(turn?.hasProcess) || liveProcess || tailTools.length > 0 || pending;
	const showStreamFinal = stream !== null && streamDone && streamIsFinal(stream) && turn?.finalEntry === undefined;
	const standaloneResults = (turn?.toolResultEntries ?? []).filter(
		entry =>
			!committedToolIds.has(entry.message.toolCallId) &&
			transcriptToolPresentation(entry.message.toolName) !== "hidden",
	);
	return (
		<>
			{hasProcess && (
				<WorkDisclosure pending={pending} durationMs={turn?.durationMs}>
					<div className="tr-work-content">
						{turn?.assistantEntries.map(entry => (
							<ProcessAssistantBlocks
								key={entry.id}
								entry={entry}
								includeText={entry !== turn.finalEntry}
								results={results}
								active={active}
								pending={false}
								host={host}
							/>
						))}
						{standaloneResults.map(entry => (
							<ToolCard
								key={entry.id}
								toolCallId={entry.message.toolCallId}
								name={entry.message.toolName}
								args={{}}
								result={entry.message}
								host={host}
							/>
						))}
						{liveProcess && stream !== null && (
							<ProcessAssistantBlocks
								entry={{
									type: "message",
									id: "stream",
									parentId: null,
									timestamp: "",
									message: stream,
								}}
								includeText={!streamIsFinal(stream)}
								results={results}
								active={active}
								pending={!streamDone}
								host={host}
							/>
						)}
						{tailTools.map(tool => (
							<ToolCard
								key={tool.toolCallId}
								toolCallId={tool.toolCallId}
								name={tool.toolName}
								intent={tool.intent}
								args={tool.args}
								running
								partialResult={tool.partialResult}
								host={host}
							/>
						))}
						{pending && !turn?.hasProcess && !liveProcess && tailTools.length === 0 && (
							<StreamStatus label="正在处理…" />
						)}
					</div>
				</WorkDisclosure>
			)}
			{turn?.finalEntry !== undefined && <FinalAssistantBody message={turn.finalEntry.message} />}
			{showStreamFinal && stream !== null && <FinalAssistantBody message={stream} />}
		</>
	);
}

interface EntryRowProps {
	entry: SessionEntry;
	lastUserEntryId: string | undefined;
	working: boolean;
	localFileAvailability: ReadonlyMap<string, boolean>;
	onEditLastUserMessage?: (text: string) => void;
	host?: ToolRenderHost;
}

/** Re-render only when the entry itself or one of its tool pairings changed. */
function entryRowEqual(prev: EntryRowProps, next: EntryRowProps): boolean {
	if (
		prev.entry !== next.entry ||
		prev.host !== next.host ||
		prev.lastUserEntryId !== next.lastUserEntryId ||
		prev.working !== next.working ||
		prev.localFileAvailability !== next.localFileAvailability ||
		prev.onEditLastUserMessage !== next.onEditLastUserMessage
	)
		return false;
	return true;
}

const EntryRow = memo(function EntryRow({
	entry,
	lastUserEntryId,
	working,
	localFileAvailability,
	onEditLastUserMessage,
	host,
}: EntryRowProps): ReactNode {
	switch (entry.type) {
		case "message": {
			const msg = entry.message;
			switch (msg.role) {
				case "user":
					return (
						<Row kind="user" speaker="host" title={entry.timestamp}>
							<UserMessage
								content={msg.content}
								localFileAvailability={localFileAvailability}
								timestamp={entry.timestamp}
								canEdit={entry.id === lastUserEntryId && onEditLastUserMessage !== undefined && !working}
								onEdit={() => onEditLastUserMessage?.(messageText(msg.content))}
								host={host}
							/>
						</Row>
					);
				case "assistant":
					return null;
				default:
					// toolResult entries are consumed via pairing; developer & unknown roles skipped
					return null;
			}
		}
		case "custom_message": {
			if (entry.customType === COLLAB_PROMPT_MESSAGE_TYPE) {
				const details = parseCollabPromptDetails(entry.details);
				const content = details.displayText ?? entry.content;
				return (
					<Row kind="user" speaker={details.from} title={entry.timestamp}>
						<UserMessage
							content={content}
							localFiles={details.localFiles}
							localFileAvailability={localFileAvailability}
							timestamp={entry.timestamp}
							canEdit={entry.id === lastUserEntryId && onEditLastUserMessage !== undefined && !working}
							onEdit={() => onEditLastUserMessage?.(messageText(content))}
							host={host}
						/>
					</Row>
				);
			}
			if (!entry.display || isSystemReminder(entry.customType, messageText(entry.content))) return null;
			return (
				<Row kind="custom" speaker="system" title={entry.timestamp}>
					<div className="tr-custom">
						<span className="tr-marker-label">{entry.customType}</span>
						<MsgContent content={entry.content} host={host} />
					</div>
				</Row>
			);
		}
		case "compaction":
			return (
				<div className="tr-divider" title={entry.shortSummary ?? entry.summary}>
					<span className="tr-speaker">system</span>
					<span>context compacted · {fmtTokens(entry.tokensBefore)} tokens</span>
				</div>
			);
		case "branch_summary":
			return (
				<div className="tr-divider" title={entry.summary}>
					<span className="tr-speaker">system</span>
					<span>branch summary</span>
				</div>
			);
		case "model_change":
		case "thinking_level_change":
			return null;
		default:
			// unknown entry types from newer hosts — skip tolerantly
			return null;
	}
}, entryRowEqual);

export function Transcript(props: TranscriptProps): ReactNode {
	const {
		entries,
		stream,
		streamDone,
		activeTools,
		working,
		compact,
		host,
		onEditLastUserMessage,
		desktop = defaultDesktopBridge,
		sessionId,
		historyRemaining = 0,
		historyLoading = false,
		onLoadEarlier,
	} = props;
	const theme = useSystemTheme();
	const presentedStream = usePresentedAssistantStream(stream, streamDone, sessionId);
	const nativeSurfaceBlocked = useSyncExternalStore(
		subscribeNativeSurfaceVisibility,
		nativeSurfacesBlocked,
		() => false,
	);
	const nativeEligible = compact !== true && desktop.nativeTranscriptAvailable;
	const [nativeEnabled, setNativeEnabled] = useState(false);
	const nativeSurfaceVisible = nativeEnabled && !nativeSurfaceBlocked;
	const [nativeRevision, setNativeRevision] = useState(0);
	const nativeRows = useMemo(
		() => (nativeEligible ? projectNativeTranscript(entries) : []),
		[entries, nativeEligible],
	);
	const nativeHasMedia = useMemo(() => nativeRows.some(row => row.mediaIds.length > 0), [nativeRows]);
	const loadEarlierRef = useRef(onLoadEarlier);
	loadEarlierRef.current = onLoadEarlier;

	useEffect(() => {
		if (!nativeEligible) {
			setNativeEnabled(false);
			return;
		}
		let active = true;
		void desktop
			.replaceNativeTranscript({
				sessionId: sessionId ?? null,
				rows: nativeRows,
				historyRemaining,
				historyLoading,
			})
			.then(enabled => {
				if (active) setNativeEnabled(enabled);
			});
		return () => {
			active = false;
		};
	}, [desktop, historyLoading, historyRemaining, nativeEligible, nativeRevision, nativeRows, sessionId]);

	useEffect(() => {
		if (!nativeEnabled) return;
		const projected = projectNativeStream(presentedStream, streamDone, working, sessionId);
		if (projected !== null) {
			void desktop.upsertNativeTranscript(projected).then(enabled => {
				if (!enabled) setNativeEnabled(false);
			});
		} else {
			void desktop.removeNativeTranscript(nativeStreamRowId(sessionId));
		}
	}, [desktop, nativeEnabled, presentedStream, sessionId, streamDone, working]);

	useEffect(() => {
		if (!nativeEligible) return;
		const handleEvent = (event: DesktopNativeTranscriptEvent): void => {
			if (typeof event !== "string") {
				void host?.loadImage?.(event.imageId, "thumbnail").then(payload =>
					desktop.provideNativeTranscriptImage({
						imageId: event.imageId,
						mimeType: payload?.mimeType ?? "",
						data: payload?.data ?? "",
					}),
				);
				return;
			}
			if (event === "load-earlier" && nativeEnabled && !historyLoading) loadEarlierRef.current?.();
			if (event === "use-web") setNativeEnabled(false);
			if (event === "use-native") setNativeRevision(revision => revision + 1);
		};
		const unsubscribe = desktop.subscribeNativeTranscriptEvents(handleEvent);
		let polling = false;
		const timer =
			nativeEnabled && (historyRemaining > 0 || nativeHasMedia)
				? window.setInterval(() => {
						if (polling) return;
						polling = true;
						void desktop
							.takeNativeTranscriptEvents()
							.then(events => {
								for (const event of events) handleEvent(event);
							})
							.finally(() => {
								polling = false;
							});
					}, 750)
				: undefined;
		return () => {
			if (timer !== undefined) window.clearInterval(timer);
			unsubscribe();
		};
	}, [desktop, historyLoading, historyRemaining, host, nativeEligible, nativeEnabled, nativeHasMedia]);
	const pageSize = compact === true ? 80 : 200;
	const [visibleLimit, setVisibleLimit] = useState(pageSize);
	const restoreScrollRef = useRef<{ height: number; top: number } | null>(null);

	useEffect(() => {
		setVisibleLimit(pageSize);
	}, [pageSize, sessionId]);

	const visibleStart = Math.max(0, entries.length - visibleLimit);
	const visibleEntries = useMemo(() => entries.slice(visibleStart), [entries, visibleStart]);
	const transcriptItems = useMemo(() => projectTranscriptItems(visibleEntries), [visibleEntries]);
	const firstVisibleEntryId = visibleEntries[0]?.id ?? "";
	const visibleLocalFiles = useMemo(() => {
		const files = new Map<string, LocalFileReference>();
		for (const entry of visibleEntries) {
			if (entry.type !== "custom_message" || entry.customType !== COLLAB_PROMPT_MESSAGE_TYPE) continue;
			for (const file of parseCollabPromptDetails(entry.details).localFiles) files.set(file.path, file);
		}
		return [...files.values()];
	}, [visibleEntries]);
	const [localFileAvailability, setLocalFileAvailability] = useState<ReadonlyMap<string, boolean>>(() => new Map());

	useEffect(() => {
		if (!desktop.localFilesAvailable || visibleLocalFiles.length === 0) return;
		let active = true;
		void desktop
			.checkAttachments(visibleLocalFiles.map(file => file.path))
			.then(statuses => {
				if (!active) return;
				setLocalFileAvailability(new Map(statuses.map(status => [status.path, status.available])));
			})
			.catch(() => {});
		return () => {
			active = false;
		};
	}, [desktop, visibleLocalFiles]);

	const lastUserEntryId = useMemo(() => [...entries].reverse().find(isTranscriptUserPrompt)?.id, [entries]);

	const results = useMemo(() => {
		const map = new Map<string, ToolResultMessage>();
		for (const entry of entries) {
			if (entry.type === "message" && entry.message.role === "toolResult") {
				map.set(entry.message.toolCallId, entry.message);
			}
		}
		return map;
	}, [entries]);

	const rootRef = useRef<HTMLDivElement | null>(null);
	const lockRef = useRef(true);

	useLayoutEffect(() => {
		const element = rootRef.current;
		if (!nativeEnabled || element === null) return;
		if (nativeSurfaceBlocked) {
			// The Web transcript is normally replaced by a lightweight placeholder
			// while the native renderer is active. When a Web popover temporarily
			// hides that renderer, position the freshly mounted fallback at the tail
			// before paint instead of flashing the oldest conversation rows.
			element.scrollTop = element.scrollHeight;
			void desktop.hideNativeTranscript();
			return;
		}
		let disposed = false;
		let frame = 0;
		const syncBounds = (): void => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => {
				if (disposed) return;
				const bounds = element.getBoundingClientRect();
				const scale = window.devicePixelRatio || 1;
				void desktop
					.setNativeTranscriptViewport({
						x: Math.round(bounds.left * scale),
						y: Math.round(bounds.top * scale),
						width: Math.round(bounds.width * scale),
						height: Math.round(bounds.height * scale),
						theme,
					})
					.then(enabled => {
						if (!enabled && !disposed) setNativeEnabled(false);
					});
			});
		};
		const observer = new ResizeObserver(syncBounds);
		observer.observe(element);
		window.addEventListener("resize", syncBounds);
		window.visualViewport?.addEventListener("resize", syncBounds);
		syncBounds();
		return () => {
			disposed = true;
			cancelAnimationFrame(frame);
			observer.disconnect();
			window.removeEventListener("resize", syncBounds);
			window.visualViewport?.removeEventListener("resize", syncBounds);
			void desktop.hideNativeTranscript();
		};
	}, [desktop, nativeEnabled, nativeSurfaceBlocked, theme]);

	useLayoutEffect(() => {
		const restore = restoreScrollRef.current;
		const element = rootRef.current;
		if (restore === null || element === null) return;
		element.scrollTop = restore.top + (element.scrollHeight - restore.height);
		restoreScrollRef.current = null;
	}, [firstVisibleEntryId, visibleStart]);

	// Follow the tail while bottom-locked; releasing/re-arming happens in onScroll.
	useEffect(() => {
		const el = rootRef.current;
		if (el !== null && lockRef.current) el.scrollTop = el.scrollHeight;
	}, [entries, presentedStream, activeTools, working]);

	const tailItem = transcriptItems[transcriptItems.length - 1];
	const tailTurn = tailItem?.kind === "assistant-turn" ? tailItem : undefined;
	const hasLiveTurn = working || presentedStream !== null || activeTools.size > 0;

	return (
		<div
			ref={rootRef}
			className={`tr-root${compact === true ? " tr-root--compact" : ""}`}
			data-native={nativeSurfaceVisible ? "true" : undefined}
			onScroll={() => {
				const el = rootRef.current;
				if (el !== null) {
					lockRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 40;
				}
			}}
		>
			{nativeSurfaceVisible ? (
				<div className="tr-native-placeholder" />
			) : (
				<>
					{entries.length === 0 && presentedStream === null && !working && (
						<div className="tr-empty">no activity yet</div>
					)}
					{visibleStart + historyRemaining > 0 && (
						<div className="tr-history-gate">
							<button
								type="button"
								disabled={historyLoading}
								onClick={() => {
									const element = rootRef.current;
									if (element !== null) {
										restoreScrollRef.current = { height: element.scrollHeight, top: element.scrollTop };
									}
									lockRef.current = false;
									setVisibleLimit(limit => limit + pageSize);
									if (visibleStart === 0 && historyRemaining > 0) onLoadEarlier?.();
								}}
							>
								{historyLoading
									? "Loading earlier messages…"
									: `Load ${Math.min(pageSize, visibleStart + historyRemaining)} earlier messages · ${visibleStart + historyRemaining} hidden`}
							</button>
						</div>
					)}
					{transcriptItems.map(item =>
						item.kind === "entry" ? (
							<EntryRow
								key={item.entry.id}
								entry={item.entry}
								lastUserEntryId={lastUserEntryId}
								working={working}
								localFileAvailability={localFileAvailability}
								onEditLastUserMessage={onEditLastUserMessage}
								host={host}
							/>
						) : (
							<Row key={item.id} kind="assistant" speaker="agent" title={item.finalEntry?.timestamp}>
								<AssistantTurnBody
									turn={item}
									results={results}
									active={activeTools}
									pending={item === tailTurn && hasLiveTurn && (!streamDone || working)}
									stream={item === tailTurn && hasLiveTurn ? presentedStream : null}
									streamDone={streamDone}
									host={host}
								/>
							</Row>
						),
					)}
					{hasLiveTurn && tailTurn === undefined && (
						<Row kind="assistant" speaker="agent">
							<AssistantTurnBody
								results={results}
								active={activeTools}
								pending={!streamDone || working}
								stream={presentedStream}
								streamDone={streamDone}
								host={host}
							/>
						</Row>
					)}
				</>
			)}
		</div>
	);
}
