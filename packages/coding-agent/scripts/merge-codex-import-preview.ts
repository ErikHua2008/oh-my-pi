import { promises as fs } from "node:fs";
import path from "node:path";
import type { SessionEntry, SessionHeader } from "../src/session/session-entries";
import { SessionManager } from "../src/session/session-manager";

interface ParsedSession {
	file: string;
	header: SessionHeader;
	entries: SessionEntry[];
	markerIndex: number;
	marker: Extract<SessionEntry, { type: "custom" }>;
	sourceEntries: SessionEntry[];
	localEntries: SessionEntry[];
}

interface MergeBlock {
	origin: string;
	ordinal: number;
	timestamp: number;
	entries: SessionEntry[];
}

function usage(): never {
	throw new Error(
		"Usage: bun scripts/merge-codex-import-preview.ts <first-import.jsonl> <second-import.jsonl> [target-cwd]",
	);
}

async function parseSession(file: string): Promise<ParsedSession> {
	const resolved = path.resolve(file);
	const values = (await fs.readFile(resolved, "utf8"))
		.split(/\r?\n/u)
		.filter(Boolean)
		.map(line => JSON.parse(line) as SessionHeader | SessionEntry | { type: "title" });
	const header = values.find((value): value is SessionHeader => value.type === "session");
	if (!header) throw new Error(`Session header is missing: ${resolved}`);
	const entries = values.filter((value): value is SessionEntry => value.type !== "session" && value.type !== "title");
	const markerIndex = entries.findIndex(
		entry => entry.type === "custom" && entry.customType === "foreign_session_import",
	);
	if (markerIndex < 0) throw new Error(`Codex import marker is missing: ${resolved}`);
	const marker = entries[markerIndex];
	if (marker.type !== "custom") throw new Error(`Invalid Codex import marker: ${resolved}`);
	const sourceEntries = entries.slice(0, markerIndex).filter(entry => entry.type !== "title_change");
	const localEntries = entries.slice(markerIndex + 1).filter(entry => entry.type !== "title_change");
	return { file: resolved, header, entries, markerIndex, marker, sourceEntries, localEntries };
}

function comparableEntry(entry: SessionEntry): string {
	const fields = Object.entries(structuredClone(entry)).filter(([key]) => key !== "parentId");
	return JSON.stringify(Object.fromEntries(fields));
}

function commonPrefixLength(left: readonly SessionEntry[], right: readonly SessionEntry[]): number {
	const limit = Math.min(left.length, right.length);
	let index = 0;
	while (index < limit && comparableEntry(left[index]!) === comparableEntry(right[index]!)) index++;
	return index;
}

function isTurnStart(entry: SessionEntry): boolean {
	if (entry.type === "message" && entry.message.role === "user") return true;
	return entry.type === "custom_message" && entry.customType === "collab-prompt";
}

function timestampOf(entry: SessionEntry): number {
	const timestamp = Date.parse(entry.timestamp);
	return Number.isFinite(timestamp) ? timestamp : Number.MAX_SAFE_INTEGER;
}

function blocksFrom(entries: readonly SessionEntry[], origin: string): MergeBlock[] {
	const blocks: MergeBlock[] = [];
	let current: SessionEntry[] = [];
	let ordinal = 0;
	for (const entry of entries) {
		if (current.length > 0 && isTurnStart(entry)) {
			blocks.push({ origin, ordinal: ordinal++, timestamp: timestampOf(current[0]!), entries: current });
			current = [];
		}
		current.push(structuredClone(entry));
	}
	if (current.length > 0) blocks.push({ origin, ordinal, timestamp: timestampOf(current[0]!), entries: current });
	return blocks;
}

function sourceIdOf(session: ParsedSession): string {
	const data = session.marker.data;
	if (!data || typeof data !== "object" || !("sourceId" in data) || typeof data.sourceId !== "string") {
		throw new Error(`Codex source id is missing from ${session.file}`);
	}
	return data.sourceId;
}

const [, , firstArg, secondArg, targetCwdArg] = process.argv;
if (!firstArg || !secondArg) usage();

const first = await parseSession(firstArg);
const second = await parseSession(secondArg);
const firstSourceId = sourceIdOf(first);
const secondSourceId = sourceIdOf(second);
if (firstSourceId !== secondSourceId) {
	throw new Error(`Imports have different Codex source ids: ${firstSourceId} != ${secondSourceId}`);
}

const commonCount = commonPrefixLength(first.sourceEntries, second.sourceEntries);
const shorterSourceCount = Math.min(first.sourceEntries.length, second.sourceEntries.length);
if (commonCount !== shorterSourceCount) {
	throw new Error(
		`Codex histories diverge before the end of the shorter import (${commonCount}/${shorterSourceCount}); preview merge stopped`,
	);
}

const latest = first.sourceEntries.length >= second.sourceEntries.length ? first : second;
const sourceExtension = latest.sourceEntries.slice(commonCount);
const divergentBlocks = [
	...blocksFrom(sourceExtension, "codex"),
	...blocksFrom(first.localEntries, `omp:${first.header.id}`),
	...blocksFrom(second.localEntries, `omp:${second.header.id}`),
].sort(
	(left, right) =>
		left.timestamp - right.timestamp || left.origin.localeCompare(right.origin) || left.ordinal - right.ordinal,
);

const orderedEntries = [
	...latest.sourceEntries.slice(0, commonCount).map(entry => structuredClone(entry)),
	...divergentBlocks.flatMap(block => block.entries),
];
const ids = new Set<string>();
let parentId: string | null = null;
for (const entry of orderedEntries) {
	if (ids.has(entry.id)) throw new Error(`Duplicate entry id while merging: ${entry.id}`);
	ids.add(entry.id);
	entry.parentId = parentId;
	parentId = entry.id;
}

const targetCwd = path.resolve(targetCwdArg ?? first.header.cwd);
const target = SessionManager.inMemory(targetCwd);
for (const entry of orderedEntries) target.ingestReplicatedEntry(entry);
target.sanitizeLoadedOpenAIResponsesReplayMetadata();
target.appendCustomEntry("foreign_session_import", latest.marker.data);
target.appendCustomEntry("foreign_session_merge", {
	strategy: "turn-start-time",
	createdAt: new Date().toISOString(),
	source: "codex",
	sourceId: firstSourceId,
	sourceSessions: [first.header.id, second.header.id],
	commonEntryCount: commonCount,
	latestCodexEntryCount: latest.sourceEntries.length,
	mergedBlockCount: divergentBlocks.length,
});
await target.setSessionName("合并预览 · Codex + OMP（按时间）", "user", "foreign-session-merge-preview");

const persisted = await target.persistCopy({ suppressBreadcrumb: true });
const result = {
	id: persisted.getSessionId(),
	file: persisted.getSessionFile(),
	cwd: persisted.getCwd(),
	title: persisted.getSessionName(),
	sourceId: firstSourceId,
	commonEntryCount: commonCount,
	sourceExtensionEntryCount: sourceExtension.length,
	firstLocalEntryCount: first.localEntries.length,
	secondLocalEntryCount: second.localEntries.length,
	mergedBlockCount: divergentBlocks.length,
	totalEntryCount: persisted.getEntries().length,
};
await persisted.close();
await target.close();
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
