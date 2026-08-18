import { directoryExists } from "@oh-my-pi/pi-utils";
import { ClaudeSessionStore } from "./claude-session-store";
import { CodexSessionStore } from "./codex-session-store";
import type { ForeignSessionInfo, ForeignSessionSource, ForeignSessionStore } from "./foreign-session-store";
import type { SessionEntry } from "./session-entries";
import type { SessionInfo } from "./session-listing";
import type { SessionManager } from "./session-manager";

export const FOREIGN_SESSION_IMPORT_CUSTOM_TYPE = "foreign_session_import";
const FOREIGN_SESSION_IMPORT_VERSION = 2;

interface ForeignSessionImportData {
	version?: number;
	source: ForeignSessionSource;
	sourceId: string;
	sourcePath?: string;
	sourceCwd?: string;
	sourceModifiedAt?: string;
	/** Imported entries whose ids do not use the source-specific `codex-` namespace. */
	sourceExtraEntryIds?: string[];
}

export interface ForeignSessionImportInspection {
	matched: boolean;
	sourceEntries: SessionEntry[];
	localEntries: SessionEntry[];
	localMessageCount: number;
	hasLocalConversation: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function markerData(entry: SessionEntry): ForeignSessionImportData | undefined {
	if (entry.type !== "custom" || entry.customType !== FOREIGN_SESSION_IMPORT_CUSTOM_TYPE || !isRecord(entry.data)) {
		return undefined;
	}
	if ((entry.data.source !== "codex" && entry.data.source !== "claude") || typeof entry.data.sourceId !== "string") {
		return undefined;
	}
	return entry.data as unknown as ForeignSessionImportData;
}

function isCodexSourceEntry(entry: SessionEntry, extraIds: ReadonlySet<string>): boolean {
	return entry.id.startsWith("codex-") || extraIds.has(entry.id);
}

function isLocalConversationEntry(entry: SessionEntry): boolean {
	if (entry.type === "message") return entry.message.role === "user" || entry.message.role === "assistant";
	return (
		entry.type === "custom_message" ||
		entry.type === "compaction" ||
		entry.type === "branch_summary" ||
		entry.type === "reset_boundary"
	);
}

/**
 * Split a previously imported journal into source-owned and OMP-owned entries.
 *
 * Version-1 imports used the marker as a physical boundary. Version 2 records
 * the exceptional source ids, allowing a confirmed chronological merge to
 * interleave both timelines without losing provenance on the next refresh.
 */
export function inspectForeignSessionImport(
	entries: readonly SessionEntry[],
	source: ForeignSessionSource,
	sourceId: string,
): ForeignSessionImportInspection {
	const markerIndexes: number[] = [];
	for (let index = 0; index < entries.length; index++) {
		const data = markerData(entries[index]!);
		if (data?.source === source && data.sourceId === sourceId) markerIndexes.push(index);
	}
	if (markerIndexes.length === 0) {
		return { matched: false, sourceEntries: [], localEntries: [], localMessageCount: 0, hasLocalConversation: false };
	}

	const markerIndex = markerIndexes.at(-1)!;
	const currentData = markerData(entries[markerIndex]!)!;
	let sourceEntries: SessionEntry[];
	let localEntries: SessionEntry[];
	if ((currentData.version ?? 1) >= FOREIGN_SESSION_IMPORT_VERSION) {
		const extraIds = new Set(
			Array.isArray(currentData.sourceExtraEntryIds)
				? currentData.sourceExtraEntryIds.filter((value): value is string => typeof value === "string")
				: [],
		);
		sourceEntries = [];
		localEntries = [];
		for (const entry of entries) {
			const data = markerData(entry);
			if (data?.source === source && data.sourceId === sourceId) continue;
			if (source === "codex" && isCodexSourceEntry(entry, extraIds)) sourceEntries.push(entry);
			else localEntries.push(entry);
		}
	} else {
		const matchingMarkerIds = new Set(markerIndexes.map(index => entries[index]!.id));
		sourceEntries = entries.slice(0, markerIndex).filter(entry => !matchingMarkerIds.has(entry.id));
		localEntries = entries.slice(markerIndex + 1).filter(entry => !matchingMarkerIds.has(entry.id));
	}

	const localMessageCount = localEntries.filter(
		entry => entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant"),
	).length;
	return {
		matched: true,
		sourceEntries,
		localEntries,
		localMessageCount,
		hasLocalConversation: localEntries.some(isLocalConversationEntry),
	};
}

/** Append the durable source identity/provenance marker used by future refreshes. */
export function appendForeignSessionImportMarker(manager: SessionManager, info: ForeignSessionInfo): void {
	const sourceExtraEntryIds = manager
		.getEntries()
		.filter(entry => info.source !== "codex" || !entry.id.startsWith("codex-"))
		.map(entry => entry.id);
	manager.appendCustomEntry(FOREIGN_SESSION_IMPORT_CUSTOM_TYPE, {
		version: FOREIGN_SESSION_IMPORT_VERSION,
		source: info.source,
		sourceId: info.id,
		sourcePath: info.path,
		sourceCwd: info.cwd,
		sourceModifiedAt: info.modified.toISOString(),
		sourceExtraEntryIds,
	} satisfies ForeignSessionImportData);
}

export interface PersistForeignSessionOptions {
	fallbackCwd?: string;
	sessionDir?: string;
	/** Resolve the destination after the transcript's authoritative cwd has been loaded. */
	sessionDirForCwd?(cwd: string): string;
	/** Reject an unavailable or disallowed authoritative cwd before creating the OMP copy. */
	validateCwd?(cwd: string): Promise<void>;
	suppressBreadcrumb?: boolean;
}

/** Construct the importer for a supported foreign session source. */
export function createForeignSessionStore(source: ForeignSessionSource): ForeignSessionStore {
	return source === "claude" ? new ClaudeSessionStore() : new CodexSessionStore();
}

/** Display name for a supported foreign session source. */
export function foreignSessionSourceName(source: ForeignSessionSource): string {
	return source === "claude" ? "Claude" : "Codex";
}

/** Convert lightweight foreign metadata for the existing session picker. */
export function foreignSessionInfoToSessionInfo(info: ForeignSessionInfo): SessionInfo {
	const firstMessage = info.firstMessage ?? "(no messages)";
	return {
		path: info.path,
		id: info.id,
		cwd: info.cwd,
		title: info.title,
		created: info.created,
		modified: info.modified,
		messageCount: info.messageCount ?? 0,
		size: 0,
		firstMessage,
		allMessagesText: firstMessage,
	};
}

/** Import and persist one foreign session under a fresh OMP session identity. */
export async function persistForeignSession(
	store: ForeignSessionStore,
	info: ForeignSessionInfo,
	options?: PersistForeignSessionOptions,
): Promise<SessionManager> {
	const imported = await store.load(info);
	try {
		appendForeignSessionImportMarker(imported, info);
		if (options?.fallbackCwd && !(await directoryExists(imported.getCwd()))) {
			await imported.moveTo(options.fallbackCwd);
		}
		const cwd = imported.getCwd();
		await options?.validateCwd?.(cwd);
		const sessionDir = options?.sessionDirForCwd?.(cwd) ?? options?.sessionDir;
		return await imported.persistCopy({ sessionDir, suppressBreadcrumb: options?.suppressBreadcrumb });
	} finally {
		await imported.close();
	}
}
