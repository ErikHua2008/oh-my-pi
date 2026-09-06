import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ensureRuntimeInstalled } from "@oh-my-pi/pi-utils";
import rootPackage from "../../../package.json" with { type: "json" };

const SHERPA_PACKAGE = "sherpa-onnx-node";
const VAD_URL = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx";

interface ModelFile {
	path: string;
	size: number;
	sha256?: string;
}

interface ModelBundle {
	repo: string;
	revision: string;
	dtype: string;
	files: readonly ModelFile[];
}

const MODEL_BUNDLES: readonly ModelBundle[] = [
	{
		repo: "csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17",
		revision: "2365baeacb507f821a0c8120fcee3d484dba7a07",
		dtype: "int8",
		files: [
			{
				path: "model.int8.onnx",
				size: 239_233_841,
				sha256: "c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51",
			},
			{
				path: "tokens.txt",
				size: 315_894,
				sha256: "f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc",
			},
		],
	},
	{
		repo: "csukuangfj/sherpa-onnx-paraformer-zh-2024-03-09",
		revision: "906992d326ebf0c5171cde675aa0902be9e5bc6c",
		dtype: "int8",
		files: [
			{
				path: "model.int8.onnx",
				size: 227_330_205,
				sha256: "90bc03034ae1bef9575f8cc798cd1519c8be8aa9e8b458a033e32017ff4d584c",
			},
			{
				path: "tokens.txt",
				size: 75_354,
				sha256: "6c0e3b35cece259829e6cb5b8d90d13db88f61ea3a2953d11898e4b2bfd7a2e2",
			},
		],
	},
];

const VAD_FILE: ModelFile = {
	path: "silero_vad.onnx",
	size: 643_854,
	sha256: "9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6",
};

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

function modelUrl(bundle: ModelBundle, endpoint: string, relativePath: string): string {
	const encodedPath = relativePath.split("/").map(encodeURIComponent).join("/");
	if (new URL(endpoint).hostname.endsWith("modelscope.cn")) {
		return `${endpoint.replace(/\/$/, "")}/models/${bundle.repo}/resolve/master/${encodedPath}`;
	}
	return `${endpoint.replace(/\/$/, "")}/${bundle.repo}/resolve/${bundle.revision}/${encodedPath}`;
}

async function fileMatchesExpected(filePath: string, file: ModelFile): Promise<boolean> {
	const matchesSize = await fs
		.stat(filePath)
		.then(stat => stat.isFile() && stat.size === file.size)
		.catch(() => false);
	if (!matchesSize || !file.sha256) return matchesSize;
	const hash = new Bun.CryptoHasher("sha256");
	try {
		for await (const chunk of Bun.file(filePath).stream()) hash.update(chunk);
		return hash.digest("hex") === file.sha256;
	} catch {
		return false;
	}
}

async function bundleIsComplete(bundle: ModelBundle, modelDirectory: string, manifestPath: string): Promise<boolean> {
	const manifestValid = await Bun.file(manifestPath)
		.json()
		.then(value => {
			const record = value as { repo?: unknown; revision?: unknown };
			return record.repo === bundle.repo && record.revision === bundle.revision;
		})
		.catch(() => false);
	if (!manifestValid) return false;
	for (const file of bundle.files) {
		if (!(await fileMatchesExpected(path.join(modelDirectory, file.path), file))) return false;
	}
	return true;
}

async function downloadFile(
	bundle: ModelBundle,
	endpoint: string,
	file: ModelFile,
	destination: string,
): Promise<void> {
	const response = await fetch(modelUrl(bundle, endpoint, file.path), {
		redirect: "follow",
		signal: AbortSignal.timeout(10 * 60_000),
	});
	if (!response.ok || response.body === null) throw new Error(`HTTP ${response.status}`);
	await fs.mkdir(path.dirname(destination), { recursive: true });
	const partial = `${destination}.part`;
	const writer = Bun.file(partial).writer();
	const hash = file.sha256 ? new Bun.CryptoHasher("sha256") : undefined;
	const reader = response.body.getReader();
	let written = 0;
	try {
		while (true) {
			const { done, value: chunk } = await reader.read();
			if (done) break;
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
	} finally {
		reader.releaseLock();
	}
}

async function ensureFile(bundle: ModelBundle, modelDirectory: string, file: ModelFile): Promise<void> {
	const destination = path.join(modelDirectory, file.path);
	if (await fileMatchesExpected(destination, file)) {
		// A previous interrupted fetch may have left a sidecar beside an otherwise
		// valid file; never carry that temporary data into the installed bundle.
		await fs.rm(`${destination}.part`, { force: true });
		return;
	}
	let lastError: unknown;
	for (const endpoint of endpointCandidates()) {
		try {
			process.stdout.write(`Downloading bundled STT model: ${file.path} from ${endpoint}\n`);
			await downloadFile(bundle, endpoint, file, destination);
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

async function ensureVad(outputRoot: string): Promise<void> {
	const directory = path.join(outputRoot, "_vad");
	const destination = path.join(directory, VAD_FILE.path);
	if (await fileMatchesExpected(destination, VAD_FILE)) {
		await fs.rm(`${destination}.part`, { force: true });
		return;
	}
	const response = await fetch(VAD_URL, { redirect: "follow", signal: AbortSignal.timeout(2 * 60_000) });
	if (!response.ok || !response.body) throw new Error(`Unable to download Silero VAD: HTTP ${response.status}`);
	await fs.mkdir(directory, { recursive: true });
	const partial = `${destination}.part`;
	const writer = Bun.file(partial).writer();
	const hash = new Bun.CryptoHasher("sha256");
	let written = 0;
	try {
		for await (const chunk of response.body) {
			written += chunk.byteLength;
			hash.update(chunk);
			writer.write(chunk);
		}
		await writer.end();
		if (written !== VAD_FILE.size || hash.digest("hex") !== VAD_FILE.sha256) {
			throw new Error("Silero VAD integrity check failed");
		}
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

async function prepareSherpaRuntime(outputRoot: string): Promise<string> {
	const sherpaVersion = (rootPackage as { dependencies?: Record<string, string> }).dependencies?.[SHERPA_PACKAGE];
	if (!sherpaVersion) throw new Error(`${SHERPA_PACKAGE} is missing from the workspace dependencies`);
	const runtimeDirectory = path.join(outputRoot, "runtime");
	const runtimeManifest = (await Bun.file(path.join(runtimeDirectory, "package.json"))
		.json()
		.catch(() => undefined)) as { dependencies?: Record<string, string> } | undefined;
	if (runtimeManifest?.dependencies?.[SHERPA_PACKAGE] !== sherpaVersion) {
		// A previous desktop build may have bundled the old Transformers runtime.
		// Remove that complete runtime before installing Sherpa so stale native
		// packages cannot inflate the release or be selected accidentally.
		await fs.rm(runtimeDirectory, { recursive: true, force: true });
	}
	await ensureRuntimeInstalled({
		runtimeDir: runtimeDirectory,
		install: {
			dependencies: { [SHERPA_PACKAGE]: sherpaVersion },
		},
		probePackage: SHERPA_PACKAGE,
		onPhase: phase => process.stdout.write(`Preparing bundled STT runtime: ${phase}\n`),
	});
	// The C++ shell is intentionally Windows x64 only. Remove the other optional
	// sherpa native packages so the offline speech pack stays compact and cannot
	// accidentally select a binary for the wrong platform.
	const nodeModules = path.join(runtimeDirectory, "node_modules");
	for (const packageName of [
		"sherpa-onnx-darwin-arm64",
		"sherpa-onnx-darwin-x64",
		"sherpa-onnx-linux-arm64",
		"sherpa-onnx-linux-x64",
		"sherpa-onnx-win-ia32",
	]) {
		await fs.rm(path.join(nodeModules, packageName), { recursive: true, force: true });
	}
	// Also prune any packages left by an older Transformers-based build. Sherpa
	// resolves only its wrapper and the Windows x64 native addon at runtime.
	const keep = new Set([".bin", SHERPA_PACKAGE, "sherpa-onnx-win-x64"]);
	for (const entry of await fs.readdir(nodeModules).catch(() => [] as string[])) {
		if (!keep.has(entry)) await fs.rm(path.join(nodeModules, entry), { recursive: true, force: true });
	}
	await fs.rm(path.join(runtimeDirectory, "bun.lock"), { force: true });
	return runtimeDirectory;
}

const outputRoot = outputArgument();
let totalBytes = VAD_FILE.size;
for (const bundle of MODEL_BUNDLES) {
	const modelDirectory = path.join(outputRoot, bundle.repo);
	const manifestPath = path.join(modelDirectory, "omp-stt-bundle.json");
	if (!(await bundleIsComplete(bundle, modelDirectory, manifestPath))) {
		for (const file of bundle.files) await ensureFile(bundle, modelDirectory, file);
		await Bun.write(
			manifestPath,
			`${JSON.stringify(
				{
					format: 1,
					repo: bundle.repo,
					revision: bundle.revision,
					dtype: bundle.dtype,
					files: bundle.files.map(file => ({ path: file.path, size: file.size, sha256: file.sha256 })),
				},
				null,
				2,
			)}\n`,
		);
	}
	for (const file of bundle.files) {
		await fs.rm(`${path.join(modelDirectory, file.path)}.part`, { force: true });
		totalBytes += file.size;
	}
}
await ensureVad(outputRoot);
const runtimeDirectory = await prepareSherpaRuntime(outputRoot);
process.stdout.write(`Bundled STT models + neural VAD ready (${Math.round(totalBytes / 1024 / 1024)} MiB)\n`);
process.stdout.write(`Bundled STT runtime ready: ${runtimeDirectory}\n`);
