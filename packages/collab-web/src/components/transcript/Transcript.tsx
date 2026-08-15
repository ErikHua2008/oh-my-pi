import {
	type AssistantMessage,
	COLLAB_PROMPT_MESSAGE_TYPE,
	type ImageContent,
	type SessionEntry,
	type TextContent,
	type ToolResultMessage,
} from "@oh-my-pi/pi-wire";
import { Check, ChevronRight, Copy, Pencil } from "lucide-react";
import type { ReactNode } from "react";
import { memo, useEffect, useId, useMemo, useRef, useState } from "react";
import type { ActiveTool } from "../../lib/client";
import { copyText } from "../../lib/desktop-bridge";
import { fmtTokens } from "../../lib/format";
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

function ThinkingBlock({ text, redacted }: { text: string; redacted?: boolean }): ReactNode {
	const [open, setOpen] = useState(false);
	const contentId = useId();
	return (
		<div className="tr-think">
			<button
				type="button"
				className="tr-think-head"
				aria-expanded={open}
				aria-controls={contentId}
				onClick={() => setOpen(v => !v)}
			>
				<ChevronRight aria-hidden size={12} className={`tr-chev${open ? " tr-chev--open" : ""}`} />
				thinking{redacted ? " · redacted" : ""}
			</button>
			{open && (
				<div id={contentId} className="tr-think-body">
					{redacted ? "(redacted by provider)" : text}
				</div>
			)}
		</div>
	);
}

function StreamStatus({ label }: { label: string }): ReactNode {
	return (
		<div className="tr-stream-status" role="status" aria-live="polite">
			<span className="tr-stream-dot" aria-hidden />
			<span>{label}</span>
		</div>
	);
}

/** Markdown + image thumbnails for user / custom message content. */
function MsgContent({ content }: { content: string | readonly (TextContent | ImageContent)[] }): ReactNode {
	if (typeof content === "string") return <Markdown text={content} />;
	return (
		<>
			{content.map((block, i) => {
				switch (block.type) {
					case "text":
						return <Markdown key={i} text={block.text} />;
					case "image":
						return (
							<img
								key={i}
								className="tr-msg-img"
								src={`data:${block.mimeType};base64,${block.data}`}
								alt="attachment"
							/>
						);
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

function isUserPromptEntry(entry: SessionEntry): boolean {
	return (
		(entry.type === "message" && entry.message.role === "user") ||
		(entry.type === "custom_message" && entry.customType === COLLAB_PROMPT_MESSAGE_TYPE)
	);
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
	timestamp,
	canEdit,
	onEdit,
}: {
	content: string | readonly (TextContent | ImageContent)[];
	timestamp: string;
	canEdit: boolean;
	onEdit?: () => void;
}): ReactNode {
	const text = messageText(content);
	return (
		<div className="tr-user-message">
			<div className="tr-user-bubble">
				<MsgContent content={content} />
			</div>
			<MessageActions timestamp={timestamp} text={text} canEdit={canEdit} onEdit={onEdit} />
		</div>
	);
}

function AssistantBody({
	message,
	results,
	active,
	pending,
	host,
}: {
	message: AssistantMessage;
	results: ReadonlyMap<string, ToolResultMessage>;
	active: ReadonlyMap<string, ActiveTool>;
	/** Still streaming — suppress stop-reason chips on the partial message. */
	pending: boolean;
	host?: ToolRenderHost;
}): ReactNode {
	const blocks = message.content.map((block, i) => {
		switch (block.type) {
			case "thinking":
				return <ThinkingBlock key={i} text={block.thinking} />;
			case "redactedThinking":
				return <ThinkingBlock key={i} text="" redacted />;
			case "text":
				return <Markdown key={i} text={block.text} />;
			case "toolCall": {
				const act = active.get(block.id);
				const result = results.get(block.id);
				const args = act?.args ?? block.arguments;
				return (
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
					/>
				);
			}
			default:
				return null;
		}
	});
	const stop = message.stopReason;
	const failed = !pending && (stop === "error" || stop === "aborted");
	return (
		<>
			{blocks}
			{failed && (
				<div className="tr-stop">
					<span className={`tr-chip ${stop === "error" ? "tr-chip--err" : "tr-chip--warn"}`}>{stop}</span>
					{message.errorMessage !== undefined && message.errorMessage.length > 0 && (
						<span className="tr-stop-msg">{message.errorMessage}</span>
					)}
				</div>
			)}
		</>
	);
}

interface EntryRowProps {
	entry: SessionEntry;
	results: ReadonlyMap<string, ToolResultMessage>;
	active: ReadonlyMap<string, ActiveTool>;
	lastUserEntryId: string | undefined;
	working: boolean;
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
		prev.onEditLastUserMessage !== next.onEditLastUserMessage
	)
		return false;
	const e = next.entry;
	if (e.type !== "message" || e.message.role !== "assistant") return true;
	for (const block of e.message.content) {
		if (block.type !== "toolCall") continue;
		if (prev.results.get(block.id) !== next.results.get(block.id)) return false;
		if (prev.active.get(block.id) !== next.active.get(block.id)) return false;
	}
	return true;
}

const EntryRow = memo(function EntryRow({
	entry,
	results,
	active,
	lastUserEntryId,
	working,
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
								timestamp={entry.timestamp}
								canEdit={entry.id === lastUserEntryId && onEditLastUserMessage !== undefined && !working}
								onEdit={() => onEditLastUserMessage?.(messageText(msg.content))}
							/>
						</Row>
					);
				case "assistant":
					return (
						<Row kind="assistant" speaker="agent" title={entry.timestamp}>
							<AssistantBody message={msg} results={results} active={active} pending={false} host={host} />
						</Row>
					);
				default:
					// toolResult entries are consumed via pairing; developer & unknown roles skipped
					return null;
			}
		}
		case "custom_message": {
			if (entry.customType === COLLAB_PROMPT_MESSAGE_TYPE) {
				const details = entry.details;
				const from =
					details !== null &&
					typeof details === "object" &&
					typeof (details as Record<string, unknown>).from === "string"
						? ((details as Record<string, unknown>).from as string)
						: "guest";
				return (
					<Row kind="user" speaker={from} title={entry.timestamp}>
						<UserMessage
							content={entry.content}
							timestamp={entry.timestamp}
							canEdit={entry.id === lastUserEntryId && onEditLastUserMessage !== undefined && !working}
							onEdit={() => onEditLastUserMessage?.(messageText(entry.content))}
						/>
					</Row>
				);
			}
			if (!entry.display) return null;
			return (
				<Row kind="custom" speaker="system" title={entry.timestamp}>
					<div className="tr-custom">
						<span className="tr-marker-label">{entry.customType}</span>
						<MsgContent content={entry.content} />
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
			return (
				<Row kind="marker" speaker="system" title={entry.timestamp}>
					<span className="tr-marker">model → {entry.model}</span>
				</Row>
			);
		case "thinking_level_change":
			return (
				<Row kind="marker" speaker="system" title={entry.timestamp}>
					<span className="tr-marker">thinking → {entry.thinkingLevel ?? "off"}</span>
				</Row>
			);
		default:
			// unknown entry types from newer hosts — skip tolerantly
			return null;
	}
}, entryRowEqual);

export function Transcript(props: TranscriptProps): ReactNode {
	const { entries, stream, streamDone, activeTools, working, compact, host, onEditLastUserMessage } = props;

	const lastUserEntryId = useMemo(() => [...entries].reverse().find(isUserPromptEntry)?.id, [entries]);

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

	// Follow the tail while bottom-locked; releasing/re-arming happens in onScroll.
	useEffect(() => {
		const el = rootRef.current;
		if (el !== null && lockRef.current) el.scrollTop = el.scrollHeight;
	}, [entries, stream, activeTools, working]);

	// Active tools not already represented as toolCall blocks in committed rows or the stream ghost.
	const renderedToolIds = new Set<string>();
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		for (const block of entry.message.content) {
			if (block.type === "toolCall") renderedToolIds.add(block.id);
		}
	}
	if (stream !== null) {
		for (const block of stream.content) {
			if (block.type === "toolCall") renderedToolIds.add(block.id);
		}
	}
	const tailTools: ActiveTool[] = [];
	for (const tool of activeTools.values()) {
		if (!renderedToolIds.has(tool.toolCallId)) tailTools.push(tool);
	}

	return (
		<div
			ref={rootRef}
			className={`tr-root${compact === true ? " tr-root--compact" : ""}`}
			onScroll={() => {
				const el = rootRef.current;
				if (el !== null) {
					lockRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 40;
				}
			}}
		>
			{entries.length === 0 && stream === null && !working && <div className="tr-empty">no activity yet</div>}
			{entries.map(entry => (
				<EntryRow
					key={entry.id}
					entry={entry}
					results={results}
					active={activeTools}
					lastUserEntryId={lastUserEntryId}
					working={working}
					onEditLastUserMessage={onEditLastUserMessage}
					host={host}
				/>
			))}
			{stream !== null && (
				<Row kind="assistant" speaker="agent">
					<AssistantBody
						message={stream}
						results={results}
						active={activeTools}
						pending={!streamDone}
						host={host}
					/>
					{!streamDone && <StreamStatus label="responding…" />}
				</Row>
			)}
			{tailTools.length > 0 && (
				<Row kind="assistant" speaker="agent">
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
				</Row>
			)}
			{working && stream === null && activeTools.size === 0 && (
				<Row kind="assistant" speaker="agent">
					<StreamStatus label="thinking…" />
				</Row>
			)}
		</div>
	);
}
