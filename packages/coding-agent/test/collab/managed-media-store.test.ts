import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ManagedMediaStore } from "../../src/collab/managed-media-store";

const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function createStore(): Promise<{ root: string; mediaDir: string; store: ManagedMediaStore }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-managed-media-"));
	roots.push(root);
	const mediaDir = path.join(root, "media", "objects");
	return {
		root,
		mediaDir,
		store: new ManagedMediaStore({
			mediaDir,
			now: () => new Date(2026, 7, 17, 12, 0, 0),
		}),
	};
}

describe("ManagedMediaStore", () => {
	it("deduplicates clipboard pixels and exposes a year/month/prefix path instead of inline data", async () => {
		const { store, mediaDir } = await createStore();
		const first = await store.importImage(PNG_1X1, "image/png");
		const second = await store.importImage(PNG_1X1, "image/png");

		expect(second.file.path).toBe(first.file.path);
		expect(first.file.path).toBe(
			path.join(mediaDir, "2026", "2026-08", first.imageId.slice(0, 2), `${first.imageId}.png`),
		);
		expect(first.file).toEqual({ kind: "local-file", path: first.file.path, name: `${first.imageId}.png` });
		expect(await fs.readFile(first.file.path)).toEqual(Buffer.from(PNG_1X1, "base64"));
		expect((await fs.readdir(path.dirname(first.file.path))).some(name => name.endsWith(".part"))).toBe(false);
	});

	it("rejects unsupported or spoofed image payloads before writing", async () => {
		const { store, mediaDir } = await createStore();
		await expect(store.importImage(PNG_1X1, "image/svg+xml")).rejects.toThrow("format is not supported");
		await expect(store.importImage(PNG_1X1, "image/jpeg")).rejects.toThrow("data is invalid");
		await expect(fs.readdir(mediaDir)).rejects.toThrow();
	});
});
