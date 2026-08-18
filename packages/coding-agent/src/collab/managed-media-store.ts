import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getManagedMediaDir, isEnoent } from "@oh-my-pi/pi-utils";
import type { LocalFileReference } from "@oh-my-pi/pi-wire";
import { MANAGED_IMAGE_MAX_BASE64_CHARS, MANAGED_IMAGE_MAX_BYTES } from "@oh-my-pi/pi-wire";

const MANAGED_IMAGE_MIME_TYPES: Readonly<Record<string, string>> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/jpg": "jpg",
	"image/gif": "gif",
	"image/webp": "webp",
	"image/bmp": "bmp",
};

export interface ManagedImage {
	file: LocalFileReference;
	imageId: string;
	mimeType: string;
}

interface ManagedMediaStoreOptions {
	mediaDir?: string;
	now?: () => Date;
}

function imageBytesMatchMimeType(bytes: Buffer, mimeType: string): boolean {
	switch (mimeType) {
		case "image/png":
			return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
		case "image/jpeg":
		case "image/jpg":
			return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
		case "image/gif":
			return (
				bytes.subarray(0, 6).toString("ascii") === "GIF87a" || bytes.subarray(0, 6).toString("ascii") === "GIF89a"
			);
		case "image/webp":
			return bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
		case "image/bmp":
			return bytes.length >= 14 && bytes[0] === 0x42 && bytes[1] === 0x4d;
		default:
			return false;
	}
}

async function commitManagedImage(mediaPath: string, bytes: Buffer): Promise<void> {
	const directory = path.dirname(mediaPath);
	await fs.mkdir(directory, { recursive: true });
	const stagingPath = path.join(directory, `.${path.basename(mediaPath)}.${randomUUID()}.part`);
	try {
		await Bun.write(stagingPath, bytes);
		try {
			await fs.rename(stagingPath, mediaPath);
		} catch (error) {
			// Windows refuses to replace an existing target. A file named by this
			// SHA-256 already contains the same validated bytes, so this is the
			// successful deduplication case rather than a failed write.
			try {
				const existing = await fs.stat(mediaPath);
				if (!existing.isFile()) throw error;
			} catch (targetError) {
				if (isEnoent(targetError)) throw error;
				throw targetError;
			}
		}
	} finally {
		await fs.rm(stagingPath, { force: true });
	}
}

/**
 * Durable store for images that have no source path (clipboard and screenshots).
 * Existing files never enter this store: the desktop keeps referencing those
 * original paths directly. Managed bytes are deduplicated by SHA-256 and moved
 * atomically from a temporary `.part` into a year/month/prefix hierarchy.
 */
export class ManagedMediaStore {
	readonly #mediaDir: string;
	readonly #now: () => Date;

	constructor(options: ManagedMediaStoreOptions = {}) {
		this.#mediaDir = options.mediaDir ?? getManagedMediaDir();
		this.#now = options.now ?? (() => new Date());
	}

	async importImage(data: string, mimeType: string): Promise<ManagedImage> {
		const normalizedMimeType = mimeType.trim().toLowerCase();
		const extension = MANAGED_IMAGE_MIME_TYPES[normalizedMimeType];
		if (!extension) {
			throw new Error("clipboard image format is not supported");
		}
		if (data.length === 0 || data.length > MANAGED_IMAGE_MAX_BASE64_CHARS) {
			throw new Error(`clipboard image must be smaller than ${MANAGED_IMAGE_MAX_BYTES / 1024 / 1024} MB`);
		}
		const bytes = Buffer.from(data, "base64");
		if (
			bytes.length === 0 ||
			bytes.length > MANAGED_IMAGE_MAX_BYTES ||
			!imageBytesMatchMimeType(bytes, normalizedMimeType)
		) {
			throw new Error("clipboard image data is invalid");
		}

		const imageId = new Bun.SHA256().update(bytes).digest("hex");
		const now = this.#now();
		const year = String(now.getFullYear()).padStart(4, "0");
		const month = `${year}-${String(now.getMonth() + 1).padStart(2, "0")}`;
		const mediaPath = path.join(this.#mediaDir, year, month, imageId.slice(0, 2), `${imageId}.${extension}`);
		await commitManagedImage(mediaPath, bytes);
		// A deduplicated object may already be old even though a guest has just
		// placed it in an unsent composer draft. Refreshing its lease lets the GC
		// write-grace window protect that path until the prompt is journaled.
		await fs.utimes(mediaPath, now, now);

		return {
			file: { kind: "local-file", path: mediaPath, name: path.basename(mediaPath) },
			imageId,
			mimeType: normalizedMimeType === "image/jpg" ? "image/jpeg" : normalizedMimeType,
		};
	}
}
