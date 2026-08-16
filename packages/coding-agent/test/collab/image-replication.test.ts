import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CollabImageStore, replaceImagesWithRefs } from "@oh-my-pi/pi-coding-agent/collab/image-replication";

const RED_1X1_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=";

const roots: string[] = [];

afterEach(async () => {
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("collab image replication", () => {
	it("replaces transcript pixels with content ids and serves cached thumbnails on demand", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-collab-images-"));
		roots.push(root);
		const blobDir = path.join(root, "blobs");
		const thumbnailDir = path.join(root, "thumbnails");
		const store = new CollabImageStore({ blobDir, thumbnailDir });
		const entry = {
			type: "message",
			id: "image-entry",
			message: {
				role: "user",
				content: [{ type: "image", data: RED_1X1_PNG, mimeType: "image/png" }],
			},
			details: { images: [{ data: RED_1X1_PNG, mimeType: "image/png" }] },
		};

		const replicated = replaceImagesWithRefs(entry, store);
		const messageImage = replicated.message.content[0] as (typeof replicated.message.content)[number] & {
			imageId?: string;
		};
		const detailImage = replicated.details.images[0] as (typeof replicated.details.images)[number] & {
			imageId?: string;
		};
		expect(entry.message.content[0]?.data).toBe(RED_1X1_PNG);
		expect(messageImage?.data).toBe("");
		expect(detailImage?.data).toBe("");
		expect(messageImage?.imageId).toMatch(/^[a-f0-9]{64}$/);
		expect(detailImage?.imageId).toBe(messageImage?.imageId);
		expect(JSON.stringify(replicated)).not.toContain(RED_1X1_PNG);

		const imageId = messageImage?.imageId;
		if (!imageId) throw new Error("expected image id");
		await expect(store.fetch(imageId, "original")).resolves.toEqual({
			data: RED_1X1_PNG,
			mimeType: "image/png",
		});
		const thumbnail = await store.fetch(imageId, "thumbnail");
		expect(thumbnail?.data.length).toBeGreaterThan(0);
		expect(thumbnail?.mimeType.startsWith("image/")).toBe(true);
		expect(await Bun.file(path.join(thumbnailDir, `${imageId}.json`)).exists()).toBe(true);

		const coldStore = new CollabImageStore({ blobDir, thumbnailDir });
		coldStore.register(messageImage);
		await expect(coldStore.fetch(imageId, "thumbnail")).resolves.toEqual(thumbnail);
	});

	it("does not allow an unadvertised hash to probe the blob store", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-collab-images-"));
		roots.push(root);
		const store = new CollabImageStore({
			blobDir: path.join(root, "blobs"),
			thumbnailDir: path.join(root, "thumbnails"),
		});

		await expect(store.fetch("a".repeat(64), "original")).resolves.toBeNull();
		await expect(store.fetch("../outside", "original")).resolves.toBeNull();
	});

	it("shrinks a long image transcript by more than two orders of magnitude before WebView replication", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-collab-images-"));
		roots.push(root);
		const store = new CollabImageStore({
			blobDir: path.join(root, "blobs"),
			thumbnailDir: path.join(root, "thumbnails"),
		});
		const imageData = "A".repeat(512 * 1024);
		const entries = Array.from({ length: 32 }, (_, index) => ({
			type: "message",
			id: `image-entry-${index}`,
			message: {
				role: "user",
				content: [{ type: "image", data: imageData, mimeType: "image/png" }],
			},
		}));
		const inlineBytes = JSON.stringify(entries).length;

		const replicated = replaceImagesWithRefs(entries, store);
		const referenceBytes = JSON.stringify(replicated).length;

		expect(inlineBytes).toBeGreaterThan(16 * 1024 * 1024);
		expect(referenceBytes * 100).toBeLessThan(inlineBytes);
		for (const entry of replicated) {
			const image = entry.message.content[0] as (typeof entry.message.content)[number] & { imageId?: string };
			expect(image.data).toBe("");
			expect(image.imageId).toMatch(/^[a-f0-9]{64}$/);
		}
	});
});
