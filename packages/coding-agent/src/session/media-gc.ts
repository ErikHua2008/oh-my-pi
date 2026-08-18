import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { gunzipSync } from "node:zlib";
import { getBlobsDir, getManagedMediaDir, getSessionsDir } from "@oh-my-pi/pi-utils";
import { BLOB_HASH_RE } from "./blob-store";

const BLOB_FILE_RE = /^([a-f0-9]{64})(?:\.[A-Za-z0-9][A-Za-z0-9._-]{0,31})?$/;
const BLOB_REF_RE = /\bblob:sha256:([a-f0-9]{64})\b/gi;
const MANAGED_MEDIA_FILE_RE = /\b([a-f0-9]{64})\.(?:png|jpe?g|gif|webp|bmp)\b/gi;
const COMPRESSED_SESSION_SUFFIX = ".jsonl.gz";

/** Protect files that may have been written before their journal entry becomes visible. */
export const SESSION_MEDIA_GC_WRITE_GRACE_MS = 5 * 60_000;

export interface SessionMediaReferenceCounts {
	blobs: Map<string, number>;
	managedMedia: Map<string, number>;
}

export interface MediaGcResult {
	referenced: number;
	candidates: number;
	wouldDelete: number;
	deleted: number;
	bytes: number;
	errors: string[];
}

export interface SessionMediaGcResult {
	blobs: MediaGcResult;
	managedMedia: MediaGcResult;
}

export interface SessionMediaGcOptions {
	agentDir: string;
	apply: boolean;
	/** Explicit/custom session directories outside the profile's normal tree. */
	additionalSessionRoots?: readonly string[];
	/** Limit an automatic post-delete pass to content referenced by the deleted session. */
	blobHashes?: ReadonlySet<string>;
	/** Limit an automatic post-delete pass to content referenced by the deleted session. */
	managedMediaHashes?: ReadonlySet<string>;
	graceMs?: number;
	nowMs?: number;
}

interface MediaCandidate {
	hash: string;
	paths: string[];
	bytes: number;
	mtimeMs: number;
}

function codeOf(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String((error as { code?: unknown }).code)
		: undefined;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function increment(counts: Map<string, number>, hash: string): void {
	counts.set(hash, (counts.get(hash) ?? 0) + 1);
}

function managedMediaHash(filePath: string, mediaDir?: string): string | undefined {
	const match = path.basename(filePath).match(/^([a-f0-9]{64})\.(?:png|jpe?g|gif|webp|bmp)$/i);
	const hash = match?.[1]?.toLowerCase();
	if (!hash) return undefined;
	if (!mediaDir) return hash;
	const relative = path.relative(path.resolve(mediaDir), path.resolve(filePath));
	if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
	return hash;
}

function collectManagedMediaReferences(value: unknown, counts: SessionMediaReferenceCounts, mediaDir?: string): void {
	if (Array.isArray(value)) {
		for (const child of value) collectManagedMediaReferences(child, counts, mediaDir);
		return;
	}
	if (typeof value !== "object" || value === null) return;
	const candidate = value as { kind?: unknown; path?: unknown };
	if (candidate.kind === "local-file" && typeof candidate.path === "string") {
		const hash = managedMediaHash(candidate.path, mediaDir);
		if (hash) increment(counts.managedMedia, hash);
	}
	for (const child of Object.values(value)) collectManagedMediaReferences(child, counts, mediaDir);
}

function collectReferencesFromText(text: string, counts: SessionMediaReferenceCounts, mediaDir?: string): void {
	for (const match of text.matchAll(BLOB_REF_RE)) {
		const hash = match[1]?.toLowerCase();
		if (hash && BLOB_HASH_RE.test(hash)) increment(counts.blobs, hash);
	}
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) continue;
		try {
			collectManagedMediaReferences(JSON.parse(line), counts, mediaDir);
		} catch {
			// A recoverable/truncated line can keep a managed object alive, but must
			// never make GC delete it. Restrict this conservative fallback to lines
			// that still visibly identify the managed-media hierarchy.
			if (!line.toLowerCase().includes("media") || !line.toLowerCase().includes("objects")) continue;
			for (const match of line.matchAll(MANAGED_MEDIA_FILE_RE)) {
				const hash = match[1]?.toLowerCase();
				if (hash && BLOB_HASH_RE.test(hash)) increment(counts.managedMedia, hash);
			}
		}
	}
}

async function readTextIfPresent(file: string): Promise<string> {
	try {
		if (file.endsWith(COMPRESSED_SESSION_SUFFIX)) {
			return new TextDecoder().decode(gunzipSync(await Bun.file(file).bytes()));
		}
		return await Bun.file(file).text();
	} catch (error) {
		if (codeOf(error) === "ENOENT") return "";
		throw error;
	}
}

async function collectFilesRecursively(root: string): Promise<string[]> {
	let entries: Dirent[];
	try {
		entries = await fs.readdir(root, { withFileTypes: true });
	} catch (error) {
		if (codeOf(error) === "ENOENT") return [];
		throw error;
	}
	const files: string[] = [];
	for (const entry of entries) {
		const target = path.join(root, entry.name);
		if (entry.isDirectory()) files.push(...(await collectFilesRecursively(target)));
		else if (entry.isFile()) files.push(target);
	}
	return files;
}

async function collectJournalFiles(root: string): Promise<string[]> {
	const files = (await collectFilesRecursively(root)).filter(
		file => file.endsWith(".jsonl") || file.endsWith(".jsonl.gz") || /\.jsonl\..+\.bak$/.test(file),
	);
	files.sort();
	return files;
}

function emptyReferenceCounts(): SessionMediaReferenceCounts {
	return { blobs: new Map(), managedMedia: new Map() };
}

async function collectReferencesFromFiles(
	files: readonly string[],
	mediaDir?: string,
): Promise<SessionMediaReferenceCounts> {
	const counts = emptyReferenceCounts();
	for (const file of files) collectReferencesFromText(await readTextIfPresent(file), counts, mediaDir);
	return counts;
}

/** All active, legacy-archive, and desktop archived-session roots that can retain references. */
export function getSessionMediaReferenceRoots(agentDir: string): string[] {
	const sessionsRoot = getSessionsDir(agentDir);
	const dataRoot = path.dirname(sessionsRoot);
	return [sessionsRoot, path.join(dataRoot, "archive", "sessions"), path.join(dataRoot, "archived_sessions")];
}

export async function collectAllSessionMediaReferences(
	agentDir: string,
	additionalRoots: readonly string[] = [],
): Promise<SessionMediaReferenceCounts> {
	const files: string[] = [];
	for (const root of [...getSessionMediaReferenceRoots(agentDir), ...additionalRoots]) {
		files.push(...(await collectJournalFiles(root)));
	}
	return await collectReferencesFromFiles([...new Set(files)], getManagedMediaDir(agentDir));
}

/** Collect candidates owned by one session before its JSONL and artifact tree are removed. */
export async function collectSessionTreeMediaReferences(
	sessionFile: string,
	mediaDir?: string,
): Promise<SessionMediaReferenceCounts> {
	const resolved = path.resolve(sessionFile);
	const files = [resolved];
	if (resolved.endsWith(".jsonl")) {
		files.push(...(await collectJournalFiles(resolved.slice(0, -".jsonl".length))));
	}
	return await collectReferencesFromFiles([...new Set(files)], mediaDir);
}

async function statIfPresent(target: string) {
	try {
		return await fs.stat(target);
	} catch (error) {
		if (codeOf(error) === "ENOENT") return null;
		throw error;
	}
}

async function collectBlobCandidates(blobDir: string): Promise<MediaCandidate[]> {
	let entries: string[];
	try {
		entries = await fs.readdir(blobDir);
	} catch (error) {
		if (codeOf(error) === "ENOENT") return [];
		throw error;
	}

	const byHash = new Map<string, MediaCandidate>();
	for (const entry of entries) {
		const hash = entry.match(BLOB_FILE_RE)?.[1];
		if (!hash) continue;
		const file = path.join(blobDir, entry);
		const stat = await statIfPresent(file);
		if (!stat?.isFile()) continue;
		const candidate = byHash.get(hash) ?? { hash, paths: [], bytes: 0, mtimeMs: stat.mtimeMs };
		candidate.paths.push(file);
		candidate.bytes += stat.size;
		candidate.mtimeMs = Math.max(candidate.mtimeMs, stat.mtimeMs);
		byHash.set(hash, candidate);
	}
	return [...byHash.values()].sort((left, right) => left.hash.localeCompare(right.hash));
}

async function collectManagedMediaCandidates(mediaDir: string): Promise<MediaCandidate[]> {
	const byHash = new Map<string, MediaCandidate>();
	const files = await collectFilesRecursively(mediaDir);
	for (const file of files) {
		const match = path.basename(file).match(/^([a-f0-9]{64})\.(?:png|jpe?g|gif|webp|bmp)$/i);
		const hash = match?.[1]?.toLowerCase();
		if (!hash) continue;
		const stat = await statIfPresent(file);
		if (!stat?.isFile()) continue;
		const candidate = byHash.get(hash) ?? { hash, paths: [], bytes: 0, mtimeMs: stat.mtimeMs };
		candidate.paths.push(file);
		candidate.bytes += stat.size;
		candidate.mtimeMs = Math.max(candidate.mtimeMs, stat.mtimeMs);
		byHash.set(hash, candidate);
	}
	return [...byHash.values()].sort((left, right) => left.hash.localeCompare(right.hash));
}

async function pruneEmptyParents(startDirectory: string, root: string): Promise<void> {
	const resolvedRoot = path.resolve(root);
	let current = path.resolve(startDirectory);
	while (current !== resolvedRoot) {
		const relative = path.relative(resolvedRoot, current);
		if (relative.startsWith("..") || path.isAbsolute(relative)) return;
		try {
			await fs.rmdir(current);
		} catch (error) {
			if (codeOf(error) === "ENOENT") {
				current = path.dirname(current);
				continue;
			}
			// ENOTEMPTY (or a concurrent writer) means every parent is still needed.
			return;
		}
		current = path.dirname(current);
	}
}

async function sweepCandidates(options: {
	candidates: readonly MediaCandidate[];
	references: ReadonlyMap<string, number>;
	limit?: ReadonlySet<string>;
	apply: boolean;
	deleteBeforeMs: number;
	pruneRoot?: string;
}): Promise<MediaGcResult> {
	const result: MediaGcResult = {
		referenced: options.references.size,
		candidates: options.candidates.length,
		wouldDelete: 0,
		deleted: 0,
		bytes: 0,
		errors: [],
	};
	for (const candidate of options.candidates) {
		if (options.limit && !options.limit.has(candidate.hash)) continue;
		if ((options.references.get(candidate.hash) ?? 0) > 0) continue;
		if (candidate.mtimeMs > options.deleteBeforeMs) continue;
		result.wouldDelete += candidate.paths.length;
		result.bytes += candidate.bytes;
		if (!options.apply) continue;
		for (const file of candidate.paths) {
			try {
				await fs.unlink(file);
				result.deleted += 1;
				if (options.pruneRoot) await pruneEmptyParents(path.dirname(file), options.pruneRoot);
			} catch (error) {
				if (codeOf(error) === "ENOENT") continue;
				result.errors.push(`${file}: ${errorMessage(error)}`);
			}
		}
	}
	return result;
}

/** Reference-counted sweep shared by manual GC and post-session-delete cleanup. */
export async function garbageCollectSessionMedia(options: SessionMediaGcOptions): Promise<SessionMediaGcResult> {
	const references = await collectAllSessionMediaReferences(options.agentDir, options.additionalSessionRoots);
	const graceMs = Math.max(0, options.graceMs ?? SESSION_MEDIA_GC_WRITE_GRACE_MS);
	const deleteBeforeMs = (options.nowMs ?? Date.now()) - graceMs;
	const blobDir = getBlobsDir(options.agentDir);
	const mediaDir = getManagedMediaDir(options.agentDir);
	const [blobCandidates, managedMediaCandidates] = await Promise.all([
		collectBlobCandidates(blobDir),
		collectManagedMediaCandidates(mediaDir),
	]);
	const [blobs, managedMedia] = await Promise.all([
		sweepCandidates({
			candidates: blobCandidates,
			references: references.blobs,
			limit: options.blobHashes,
			apply: options.apply,
			deleteBeforeMs,
		}),
		sweepCandidates({
			candidates: managedMediaCandidates,
			references: references.managedMedia,
			limit: options.managedMediaHashes,
			apply: options.apply,
			deleteBeforeMs,
			pruneRoot: mediaDir,
		}),
	]);
	return { blobs, managedMedia };
}
