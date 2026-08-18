import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	collectSessionTreeMediaReferences,
	garbageCollectSessionMedia,
} from "@oh-my-pi/pi-coding-agent/session/media-gc";
import { getBlobsDir, getManagedMediaDir, getSessionsDir } from "@oh-my-pi/pi-utils";

function hashFor(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

async function writeSession(
	agentDir: string,
	name: string,
	body: unknown,
	root = getSessionsDir(agentDir),
): Promise<string> {
	const directory = path.join(root, "project");
	await fs.mkdir(directory, { recursive: true });
	const file = path.join(directory, `${name}.jsonl`);
	await fs.writeFile(
		file,
		`${JSON.stringify({ type: "session", id: name, timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp" })}\n${JSON.stringify(body)}\n`,
	);
	return file;
}

async function age(file: string): Promise<void> {
	const old = new Date(Date.now() - 60 * 60_000);
	await fs.utimes(file, old, old);
}

describe("session media reference-counted GC", () => {
	let root: string;

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-session-media-gc-"));
	});

	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	it("keeps a shared blob until its final session reference is deleted, then removes every sidecar", async () => {
		const hash = hashFor("shared-blob");
		const blobDir = getBlobsDir(root);
		await fs.mkdir(blobDir, { recursive: true });
		const canonical = path.join(blobDir, hash);
		const sidecar = path.join(blobDir, `${hash}.png`);
		await fs.writeFile(canonical, "shared");
		await fs.writeFile(sidecar, "shared-sidecar");
		await age(canonical);
		await age(sidecar);
		const first = await writeSession(root, "first", { ref: `blob:sha256:${hash}` });
		const second = await writeSession(root, "second", { ref: `blob:sha256:${hash}` });

		const candidates = await collectSessionTreeMediaReferences(first);
		await fs.unlink(first);
		const shared = await garbageCollectSessionMedia({
			agentDir: root,
			apply: true,
			blobHashes: new Set(candidates.blobs.keys()),
		});
		expect(shared.blobs.deleted).toBe(0);
		expect(await Bun.file(canonical).exists()).toBe(true);

		await fs.unlink(second);
		const final = await garbageCollectSessionMedia({
			agentDir: root,
			apply: true,
			blobHashes: new Set([hash]),
		});
		expect(final.blobs.deleted).toBe(2);
		expect(await Bun.file(canonical).exists()).toBe(false);
		expect(await Bun.file(sidecar).exists()).toBe(false);
	});

	it("treats desktop archived_sessions as a live reference root", async () => {
		const hash = hashFor("desktop-archive");
		const blob = path.join(getBlobsDir(root), hash);
		await fs.mkdir(path.dirname(blob), { recursive: true });
		await fs.writeFile(blob, "archived");
		await age(blob);
		await writeSession(root, "archived", { ref: `blob:sha256:${hash}` }, path.join(root, "archived_sessions"));

		const result = await garbageCollectSessionMedia({ agentDir: root, apply: true });

		expect(result.blobs.referenced).toBe(1);
		expect(result.blobs.deleted).toBe(0);
		expect(await Bun.file(blob).exists()).toBe(true);
	});

	it("reference-counts managed clipboard media and prunes its empty date hierarchy", async () => {
		const hash = hashFor("clipboard-image");
		const mediaDir = getManagedMediaDir(root);
		const media = path.join(mediaDir, "2026", "2026-08", hash.slice(0, 2), `${hash}.png`);
		await fs.mkdir(path.dirname(media), { recursive: true });
		await fs.writeFile(media, "png");
		await age(media);
		const session = await writeSession(root, "media", {
			type: "custom_message",
			details: { localFiles: [{ kind: "local-file", path: media, name: path.basename(media) }] },
		});

		const referenced = await garbageCollectSessionMedia({ agentDir: root, apply: true });
		expect(referenced.managedMedia.referenced).toBe(1);
		expect(await Bun.file(media).exists()).toBe(true);

		const candidates = await collectSessionTreeMediaReferences(session);
		await fs.unlink(session);
		const deleted = await garbageCollectSessionMedia({
			agentDir: root,
			apply: true,
			managedMediaHashes: new Set(candidates.managedMedia.keys()),
		});
		expect(deleted.managedMedia.deleted).toBe(1);
		expect(await Bun.file(media).exists()).toBe(false);
		expect(await Bun.file(path.dirname(media)).exists()).toBe(false);
	});

	it("protects newly written unreferenced media during the write grace window", async () => {
		const hash = hashFor("fresh-draft");
		const media = path.join(getManagedMediaDir(root), "2026", "2026-08", hash.slice(0, 2), `${hash}.png`);
		await fs.mkdir(path.dirname(media), { recursive: true });
		await fs.writeFile(media, "draft");

		const result = await garbageCollectSessionMedia({ agentDir: root, apply: true });

		expect(result.managedMedia.wouldDelete).toBe(0);
		expect(await Bun.file(media).exists()).toBe(true);
	});
});
