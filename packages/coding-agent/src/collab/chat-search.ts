import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import type { ChatSearchKind, ChatSearchResult, ChatSearchRole } from "@oh-my-pi/pi-wire";
import type { SessionEntry } from "../session/session-entries";
import { COLLAB_PROMPT_MESSAGE_TYPE, type CollabPromptDetails } from "./protocol";

const MAX_QUERY_LENGTH = 200;
const MAX_RESULT_LIMIT = 200;
const MAX_SNIPPET_LENGTH = 220;
const IMAGE_EXTENSIONS = new Set(["bmp", "gif", "jpeg", "jpg", "png", "tif", "tiff", "webp"]);
const URL_PATTERN = /https?:\/\/[^\s<>()[\]{}"']+/giu;

export interface ChatSearchRequest {
	query: string;
	kind: ChatSearchKind;
	role: ChatSearchRole;
	date?: string;
	limit: number;
}

export interface ChatSearchResponse {
	results: ChatSearchResult[];
	total: number;
	truncated: boolean;
}

interface SearchableEntry {
	entryId: string;
	rowId: string;
	role: "user" | "assistant";
	timestamp: string;
	ordinal: number;
	text: string;
	images: string[];
	files: string[];
	links: string[];
}

function contentText(content: string | readonly (TextContent | ImageContent)[]): string {
	if (typeof content === "string") return content;
	return content
		.filter((block): block is TextContent => block.type === "text")
		.map(block => block.text)
		.join("\n");
}

function contentImageLabels(content: string | readonly { type: string }[]): string[] {
	if (typeof content === "string") return [];
	const images: string[] = [];
	for (const block of content) {
		if (block.type !== "image") continue;
		images.push("图片");
	}
	return images;
}

function isImagePath(filePath: string): boolean {
	const extension = /\.([^.\\/]+)$/.exec(filePath)?.[1]?.toLocaleLowerCase();
	return extension !== undefined && IMAGE_EXTENSIONS.has(extension);
}

function localDate(timestamp: string): string {
	const parsed = new Date(timestamp);
	if (Number.isNaN(parsed.getTime())) return "";
	const year = parsed.getFullYear();
	const month = String(parsed.getMonth() + 1).padStart(2, "0");
	const day = String(parsed.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function linksIn(text: string): string[] {
	return [...new Set(text.match(URL_PATTERN) ?? [])];
}

function promptDetails(entry: Extract<SessionEntry, { type: "custom_message" }>): CollabPromptDetails {
	if (entry.details === null || typeof entry.details !== "object") return {};
	return entry.details as CollabPromptDetails;
}

function searchableEntry(entry: SessionEntry, ordinal: number): SearchableEntry | null {
	if (entry.type === "message") {
		if (entry.message.role === "user") {
			const text = contentText(entry.message.content);
			return {
				entryId: entry.id,
				rowId: entry.id,
				role: "user",
				timestamp: entry.timestamp,
				ordinal,
				text,
				images: contentImageLabels(entry.message.content),
				files: [],
				links: linksIn(text),
			};
		}
		if (entry.message.role === "assistant") {
			// Tool-use/intermediate assistant messages are represented inside the
			// collapsed work row, not as chat bubbles. Search only final replies so
			// every hit maps to a stable, revealable transcript row.
			if (entry.message.stopReason === "toolUse" || entry.message.content.some(block => block.type === "toolCall")) {
				return null;
			}
			const text = entry.message.content
				.filter((block): block is TextContent => block.type === "text")
				.map(block => block.text)
				.join("\n");
			const images = contentImageLabels(entry.message.content);
			if (!text && !entry.message.errorMessage && images.length === 0) return null;
			const completeText = [text, entry.message.errorMessage].filter(Boolean).join("\n");
			return {
				entryId: entry.id,
				rowId: entry.id,
				role: "assistant",
				timestamp: entry.timestamp,
				ordinal,
				text: completeText,
				images,
				files: [],
				links: linksIn(completeText),
			};
		}
		return null;
	}
	if (entry.type !== "custom_message" || entry.customType !== COLLAB_PROMPT_MESSAGE_TYPE) return null;
	const details = promptDetails(entry);
	const text = details.displayText ?? contentText(entry.content);
	const images = contentImageLabels(entry.content);
	const files: string[] = [];
	for (const file of details.localFiles ?? []) {
		const label = file.name || file.path;
		if (isImagePath(file.path)) images.push(label);
		else files.push(label);
	}
	return {
		entryId: entry.id,
		rowId: entry.id,
		role: "user",
		timestamp: entry.timestamp,
		ordinal,
		text,
		images,
		files,
		links: linksIn(text),
	};
}

function includesQuery(value: string, query: string): boolean {
	return query.length === 0 || value.toLocaleLowerCase().includes(query);
}

function centeredSnippet(value: string, rawQuery: string): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	if (normalized.length <= MAX_SNIPPET_LENGTH) return normalized;
	const query = rawQuery.toLocaleLowerCase();
	const found = query ? normalized.toLocaleLowerCase().indexOf(query) : 0;
	const start = Math.max(0, Math.min(normalized.length - MAX_SNIPPET_LENGTH, found - 70));
	const body = normalized.slice(start, start + MAX_SNIPPET_LENGTH);
	return `${start > 0 ? "…" : ""}${body}${start + MAX_SNIPPET_LENGTH < normalized.length ? "…" : ""}`;
}

function resultFor(
	entry: SearchableEntry,
	kind: Exclude<ChatSearchKind, "all">,
	value: string,
	query: string,
): ChatSearchResult {
	return {
		entryId: entry.entryId,
		rowId: entry.rowId,
		kind,
		role: entry.role,
		timestamp: entry.timestamp,
		snippet: centeredSnippet(value || (kind === "image" ? "图片" : "聊天记录"), query),
		ordinal: entry.ordinal,
	};
}

function hitsFor(entry: SearchableEntry, kind: ChatSearchKind, rawQuery: string): ChatSearchResult[] {
	const query = rawQuery.toLocaleLowerCase();
	const textMatches = entry.text.length > 0 && includesQuery(entry.text, query);
	const images = entry.images.filter(value => includesQuery(value, query));
	const files = entry.files.filter(value => includesQuery(value, query));
	const links = entry.links.filter(value => includesQuery(value, query));
	if (kind === "text") return textMatches ? [resultFor(entry, "text", entry.text, rawQuery)] : [];
	if (kind === "image") return images.map(value => resultFor(entry, "image", value, rawQuery));
	if (kind === "file") return files.map(value => resultFor(entry, "file", value, rawQuery));
	if (kind === "link") return links.map(value => resultFor(entry, "link", value, rawQuery));
	if (!rawQuery) {
		// "All" doubles as a WeChat-style chronological browser. A media-only
		// message is still a chat record and must not disappear merely because it
		// has no text to use as a snippet.
		if (entry.text) return [resultFor(entry, "text", entry.text, rawQuery)];
		if (entry.images.length > 0) return [resultFor(entry, "image", entry.images[0] ?? "图片", rawQuery)];
		if (entry.files.length > 0) return [resultFor(entry, "file", entry.files[0] ?? "文件", rawQuery)];
		if (entry.links.length > 0) return [resultFor(entry, "link", entry.links[0] ?? "链接", rawQuery)];
		return [];
	}
	if (textMatches) return [resultFor(entry, "text", entry.text, rawQuery)];
	if (images.length > 0) return [resultFor(entry, "image", images[0] ?? "图片", rawQuery)];
	if (files.length > 0) return [resultFor(entry, "file", files[0] ?? "文件", rawQuery)];
	if (links.length > 0) return [resultFor(entry, "link", links[0] ?? "链接", rawQuery)];
	return [];
}

/** Search newest-first while returning only compact snippets to the WebView. */
export function searchChatEntries(entries: readonly SessionEntry[], request: ChatSearchRequest): ChatSearchResponse {
	const query = request.query.trim().slice(0, MAX_QUERY_LENGTH);
	const limit = Number.isSafeInteger(request.limit) ? Math.max(1, Math.min(request.limit, MAX_RESULT_LIMIT)) : 100;
	const results: ChatSearchResult[] = [];
	let total = 0;
	for (let ordinal = entries.length - 1; ordinal >= 0; --ordinal) {
		const entry = entries[ordinal];
		if (!entry) continue;
		const searchable = searchableEntry(entry, ordinal);
		if (!searchable) continue;
		if (request.role !== "all" && searchable.role !== request.role) continue;
		if (request.date && localDate(searchable.timestamp) !== request.date) continue;
		for (const hit of hitsFor(searchable, request.kind, query)) {
			total++;
			if (results.length < limit) results.push(hit);
		}
	}
	return { results, total, truncated: total > results.length };
}
