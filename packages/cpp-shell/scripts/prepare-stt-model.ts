import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ensureRuntimeInstalled } from "@oh-my-pi/pi-utils";
import rootPackage from "../../../package.json" with { type: "json" };

const MODEL_REPO = "onnx-community/whisper-small";
const MODEL_REVISION = "36050c46d777d46dc4b5f43f6d90574fc38f8732";
const TRANSFORMERS_PACKAGE = "@huggingface/transformers";

interface ModelFile {
	path: string;
	size: number;
	sha256?: string;
}

const MODEL_FILES: readonly ModelFile[] = [
	{ path: "README.md", size: 533 },
	{ path: "added_tokens.json", size: 34_604 },
	{ path: "config.json", size: 2_227 },
	{ path: "generation_config.json", size: 3_893 },
	{ path: "merges.txt", size: 493_869 },
	{ path: "normalizer.json", size: 52_666 },
	{
		path: "onnx/decoder_model_merged_quantized.onnx",
		size: 156_750_845,
		sha256: "ec07c3cbb64172c39791e26ee870a65ac22b458c36722bfe2776b3dbf741e0c9",
	},
	{
		path: "onnx/encoder_model_quantized.onnx",
		size: 92_326_160,
		sha256: "a43a83f3c5361cd591cfa7c36f14b43cf7cb22f47a415cc14a8d557be800fa92",
	},
	{ path: "preprocessor_config.json", size: 339 },
	{ path: "quantize_config.json", size: 10_126 },
	{ path: "special_tokens_map.json", size: 2_194 },
	{ path: "tokenizer.json", size: 2_480_466 },
	{ path: "tokenizer_config.json", size: 282_683 },
	{ path: "vocab.json", size: 1_036_584 },
];

function outputArgument(): string {
	const index = Bun.argv.indexOf("--output");
	const value = index >= 0 ? Bun.argv[index + 1] : undefined;
	if (!value) throw new Error("Usage: bun prepare-stt-model.ts --output <model-root>");
	return path.resolve(value);
}

function endpointCandidates(): string[] {
	const endpoints = [
		process.env.HF_ENDPOINT,
		"https://www.modelscope.cn",
		"https://huggingface.co",
		"https://hf-mirror.com",
	];
	return [...new Set(endpoints.filter((value): value is string => Boolean(value?.trim())).map(value => value.trim()))];
}

function modelUrl(endpoint: string, relativePath: string): string {
	const encodedPath = relativePath.split("/").map(encodeURIComponent).join("/");
	if (new URL(endpoint).hostname.endsWith("modelscope.cn")) {
		return `${endpoint.replace(/\/$/, "")}/models/${MODEL_REPO}/resolve/master/${encodedPath}`;
	}
	return `${endpoint.replace(/\/$/, "")}/${MODEL_REPO}/resolve/${MODEL_REVISION}/${encodedPath}`;
}

async function fileHasExpectedSize(filePath: string, expected: number): Promise<boolean> {
	return fs
		.stat(filePath)
		.then(stat => stat.isFile() && stat.size === expected)
		.catch(() => false);
}

async function bundleIsComplete(modelDirectory: string, manifestPath: string): Promise<boolean> {
	const manifestValid = await Bun.file(manifestPath)
		.json()
		.then(value => {
			const record = value as { repo?: unknown; revision?: unknown };
			return record.repo === MODEL_REPO && record.revision === MODEL_REVISION;
		})
		.catch(() => false);
	if (!manifestValid) return false;
	for (const file of MODEL_FILES) {
		if (!(await fileHasExpectedSize(path.join(modelDirectory, file.path), file.size))) return false;
	}
	return true;
}

async function downloadFile(endpoint: string, file: ModelFile, destination: string): Promise<void> {
	const response = await fetch(modelUrl(endpoint, file.path), {
		redirect: "follow",
		signal: AbortSignal.timeout(10 * 60_000),
	});
	if (!response.ok || response.body === null) throw new Error(`HTTP ${response.status}`);
	await fs.mkdir(path.dirname(destination), { recursive: true });
	const partial = `${destination}.part`;
	const writer = Bun.file(partial).writer();
	const hash = file.sha256 ? new Bun.CryptoHasher("sha256") : undefined;
	let written = 0;
	try {
		for await (const chunk of response.body) {
			written += chunk.byteLength;
			hash?.update(chunk);
			writer.write(chunk);
		}
		await writer.end();
		if (written !== file.size) throw new Error(`size mismatch: expected ${file.size}, received ${written}`);
		if (file.sha256 && hash?.digest("hex") !== file.sha256) throw new Error("SHA-256 mismatch");
		await fs.rm(destination, { force: true });
		await fs.rename(partial, destination);
	} catch (error) {
		try {
			await writer.end();
		} catch {
			// The failed stream may already have closed the writer.
		}
		await fs.rm(partial, { force: true });
		throw error;
	}
}

async function ensureFile(modelDirectory: string, file: ModelFile): Promise<void> {
	const destination = path.join(modelDirectory, file.path);
	if (await fileHasExpectedSize(destination, file.size)) return;
	let lastError: unknown;
	for (const endpoint of endpointCandidates()) {
		try {
			process.stdout.write(`Downloading bundled STT model: ${file.path} from ${endpoint}\n`);
			await downloadFile(endpoint, file, destination);
			return;
		} catch (error) {
			lastError = error;
			process.stderr.write(
				`STT model download failed from ${endpoint}: ${error instanceof Error ? error.message : String(error)}\n`,
			);
		}
	}
	throw lastError instanceof Error ? lastError : new Error(`Unable to download ${file.path}`);
}

async function prepareTransformersRuntime(outputRoot: string): Promise<string> {
	const transformersVersion = rootPackage.workspaces.catalog[TRANSFORMERS_PACKAGE];
	if (!transformersVersion) throw new Error(`${TRANSFORMERS_PACKAGE} is missing from the workspace catalog`);
	const runtimeDirectory = path.join(outputRoot, "runtime");
	await ensureRuntimeInstalled({
		runtimeDir: runtimeDirectory,
		install: {
			dependencies: { [TRANSFORMERS_PACKAGE]: transformersVersion },
			trustedDependencies: ["onnxruntime-node"],
		},
		probePackage: TRANSFORMERS_PACKAGE,
		onPhase: phase => process.stdout.write(`Preparing bundled STT runtime: ${phase}\n`),
	});
	// The C++ shell is intentionally Windows x64 only. onnxruntime-node ships
	// native payloads for every supported OS/architecture in one package; remove
	// the unreachable variants so the offline speech pack does not double in size.
	const onnxPlatforms = path.join(runtimeDirectory, "node_modules", "onnxruntime-node", "bin", "napi-v6");
	for (const relative of ["darwin", "linux", path.join("win32", "arm64")]) {
		await fs.rm(path.join(onnxPlatforms, relative), { recursive: true, force: true });
	}
	return runtimeDirectory;
}

const outputRoot = outputArgument();
const modelDirectory = path.join(outputRoot, MODEL_REPO);
const manifestPath = path.join(modelDirectory, "omp-stt-bundle.json");
if (!(await bundleIsComplete(modelDirectory, manifestPath))) {
	for (const file of MODEL_FILES) await ensureFile(modelDirectory, file);
	await Bun.write(
		manifestPath,
		`${JSON.stringify(
			{
				format: 1,
				repo: MODEL_REPO,
				revision: MODEL_REVISION,
				dtype: "q8",
				files: MODEL_FILES.map(file => ({ path: file.path, size: file.size, sha256: file.sha256 })),
			},
			null,
			2,
		)}\n`,
	);
}
const runtimeDirectory = await prepareTransformersRuntime(outputRoot);
const totalBytes = MODEL_FILES.reduce((sum, file) => sum + file.size, 0);
process.stdout.write(`Bundled STT model ready: ${modelDirectory} (${Math.round(totalBytes / 1024 / 1024)} MiB)\n`);
process.stdout.write(`Bundled STT runtime ready: ${runtimeDirectory}\n`);
