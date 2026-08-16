import * as path from "node:path";
import { getBlobsDir, getCollabThumbnailCacheDir, isEnoent, logger } from "@oh-my-pi/pi-utils";
import type { ImageVariant } from "@oh-my-pi/pi-wire";
import { BLOB_HASH_RE, BlobStore, blobExtensionForImageMimeType, parseBlobRef } from "../session/blob-store";
import { resizeImage } from "../utils/image-resize";

const THUMBNAIL_CACHE_VERSION = 1;
const THUMBNAIL_MAX_WIDTH = 320;
const THUMBNAIL_MAX_HEIGHT = 320;
const THUMBNAIL_MAX_BYTES = 48 * 1024;
const THUMBNAIL_MAX_BASE64_CHARS = 128 * 1024;

export interface CollabImagePayload {
	data: string;
	mimeType: string;
}

interface CachedThumbnail extends CollabImagePayload {
	v: typeof THUMBNAIL_CACHE_VERSION;
}

interface ImageReplicationOptions {
	blobDir?: string;
	thumbnailDir?: string;
}

interface ImageData {
	data: string;
	mimeType: string;
	imageId?: string;
}

function isReplicableImage(value: unknown, parentKey?: string): value is ImageData & { type?: string } {
	return (
		typeof value === "object" &&
		value !== null &&
		"data" in value &&
		typeof value.data === "string" &&
		"mimeType" in value &&
		typeof value.mimeType === "string" &&
		(("type" in value && value.type === "image") || parentKey === "images")
	);
}

function isCachedThumbnail(value: unknown): value is CachedThumbnail {
	return (
		typeof value === "object" &&
		value !== null &&
		"v" in value &&
		value.v === THUMBNAIL_CACHE_VERSION &&
		"data" in value &&
		typeof value.data === "string" &&
		value.data.length > 0 &&
		value.data.length <= THUMBNAIL_MAX_BASE64_CHARS &&
		"mimeType" in value &&
		typeof value.mimeType === "string" &&
		value.mimeType.startsWith("image/")
	);
}

/**
 * Host-side content-addressed image registry used only at the collab boundary.
 * Session entries and provider messages remain unchanged; media-capable guests
 * receive an empty `data` field plus `imageId`, then request pixels lazily.
 */
export class CollabImageStore {
	readonly #blobs: BlobStore;
	readonly #thumbnailDir: string;
	readonly #mimeById = new Map<string, string>();
	readonly #thumbnailMemory = new Map<string, CollabImagePayload>();
	readonly #thumbnailPending = new Map<string, Promise<CollabImagePayload | null>>();

	constructor(options: ImageReplicationOptions = {}) {
		this.#blobs = new BlobStore(options.blobDir ?? getBlobsDir());
		this.#thumbnailDir = options.thumbnailDir ?? getCollabThumbnailCacheDir();
	}

	/** Register an image and return the canonical id used in replication frames. */
	register(image: ImageData): string | null {
		const referencedHash = parseBlobRef(image.data);
		if (referencedHash) {
			this.#mimeById.set(referencedHash, image.mimeType);
			return referencedHash;
		}

		if (image.data.length === 0) {
			if (image.imageId && BLOB_HASH_RE.test(image.imageId)) {
				this.#mimeById.set(image.imageId, image.mimeType);
				return image.imageId;
			}
			return null;
		}

		const bytes = Buffer.from(image.data, "base64");
		if (bytes.byteLength === 0) return null;
		const hash = new Bun.SHA256().update(bytes).digest("hex");
		if (!this.#blobs.hasSync(hash)) {
			this.#blobs.putSync(bytes, { extension: blobExtensionForImageMimeType(image.mimeType) });
		}
		this.#mimeById.set(hash, image.mimeType);
		return hash;
	}

	/** Fetch a registered thumbnail or original. Unknown ids cannot probe the global blob store. */
	async fetch(imageId: string, variant: ImageVariant): Promise<CollabImagePayload | null> {
		if (!BLOB_HASH_RE.test(imageId)) return null;
		const mimeType = this.#mimeById.get(imageId);
		if (!mimeType) return null;
		if (variant === "thumbnail") return this.#thumbnail(imageId, mimeType);
		const original = await this.#blobs.get(imageId);
		if (!original) return null;
		return { data: original.toString("base64"), mimeType };
	}

	#thumbnail(imageId: string, mimeType: string): Promise<CollabImagePayload | null> {
		const memory = this.#thumbnailMemory.get(imageId);
		if (memory) return Promise.resolve(memory);
		const pending = this.#thumbnailPending.get(imageId);
		if (pending) return pending;

		const task = this.#loadOrCreateThumbnail(imageId, mimeType).finally(() => {
			this.#thumbnailPending.delete(imageId);
		});
		this.#thumbnailPending.set(imageId, task);
		return task;
	}

	async #loadOrCreateThumbnail(imageId: string, mimeType: string): Promise<CollabImagePayload | null> {
		const cachePath = path.join(this.#thumbnailDir, `${imageId}.json`);
		try {
			const cached = JSON.parse(await Bun.file(cachePath).text()) as unknown;
			if (isCachedThumbnail(cached)) {
				const payload = { data: cached.data, mimeType: cached.mimeType };
				this.#thumbnailMemory.set(imageId, payload);
				return payload;
			}
			logger.debug("Ignoring invalid collab thumbnail cache entry", { cachePath });
		} catch (error) {
			if (!isEnoent(error)) {
				logger.debug("Failed to read collab thumbnail cache entry", { cachePath, error: String(error) });
			}
		}

		const original = await this.#blobs.get(imageId);
		if (!original) return null;
		const resized = await resizeImage(
			{ type: "image", data: original.toString("base64"), mimeType },
			{
				maxWidth: THUMBNAIL_MAX_WIDTH,
				maxHeight: THUMBNAIL_MAX_HEIGHT,
				minDimension: 1,
				maxBytes: THUMBNAIL_MAX_BYTES,
				jpegQuality: 64,
			},
		);
		const payload = { data: resized.data, mimeType: resized.mimeType };
		this.#thumbnailMemory.set(imageId, payload);
		const cached: CachedThumbnail = { v: THUMBNAIL_CACHE_VERSION, ...payload };
		try {
			await Bun.write(cachePath, JSON.stringify(cached));
		} catch (error) {
			logger.debug("Failed to write collab thumbnail cache entry", { cachePath, error: String(error) });
		}
		return payload;
	}
}

/**
 * Return a structural-sharing shadow whose image payloads are replaced by
 * content ids. The input is never mutated, so Agent/Provider/session state
 * keeps its complete image data.
 */
export function replaceImagesWithRefs<T>(value: T, store: CollabImageStore, parentKey?: string): T {
	if (isReplicableImage(value, parentKey)) {
		const imageId = store.register(value);
		if (!imageId) return value;
		return { ...value, data: "", imageId } as T;
	}
	if (Array.isArray(value)) {
		let changed = false;
		const next = value.map(item => {
			const replacement = replaceImagesWithRefs(item, store, parentKey);
			if (replacement !== item) changed = true;
			return replacement;
		});
		return (changed ? next : value) as T;
	}
	if (typeof value !== "object" || value === null) return value;

	let changed = false;
	const source = value as Record<string, unknown>;
	const next: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(source)) {
		const replacement = replaceImagesWithRefs(child, store, key);
		if (replacement !== child) changed = true;
		next[key] = replacement;
	}
	return (changed ? next : value) as T;
}
