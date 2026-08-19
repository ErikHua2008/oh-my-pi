import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { SttStreamOptions } from "@oh-my-pi/pi-coding-agent/stt/asr-client";
import * as asrClient from "@oh-my-pi/pi-coding-agent/stt/asr-client";
import * as downloader from "@oh-my-pi/pi-coding-agent/stt/downloader";
import { BUNDLED_STT_MODELS_ENV } from "@oh-my-pi/pi-coding-agent/stt/model-paths";
import { STTController } from "@oh-my-pi/pi-coding-agent/stt/stt-controller";
import { getTinyModelsCacheDir, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

const WHISPER_BASE_REPO = "onnx-community/whisper-base";
const PARAKEET_REPO = "csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8";

async function touch(file: string): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, "x");
}

describe("isSttModelCached completeness", () => {
	let state: SettingsTestState | undefined;
	let tmp = "";
	let cacheDir = "";
	let previousBundledModels: string | undefined;

	beforeEach(async () => {
		state = beginSettingsTest();
		previousBundledModels = process.env[BUNDLED_STT_MODELS_ENV];
		delete process.env[BUNDLED_STT_MODELS_ENV];
		tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-stt-cache-"));
		setAgentDir(tmp);
		cacheDir = getTinyModelsCacheDir();
	});

	afterEach(async () => {
		if (previousBundledModels === undefined) delete process.env[BUNDLED_STT_MODELS_ENV];
		else process.env[BUNDLED_STT_MODELS_ENV] = previousBundledModels;
		restoreSettingsTestState(state);
		await removeWithRetries(tmp);
	});

	it("treats a transformers model as cached only when both encoder and decoder onnx are present", async () => {
		const repoDir = path.join(cacheDir, WHISPER_BASE_REPO);
		await touch(path.join(repoDir, "config.json"));
		await touch(path.join(repoDir, "onnx", "encoder_model.onnx"));
		// Only the encoder shard landed — an interrupted Whisper download.
		expect(await downloader.isSttModelCached("fast")).toBe(false);

		await touch(path.join(repoDir, "onnx", "decoder_model_merged.onnx"));
		expect(await downloader.isSttModelCached("fast")).toBe(true);
	});

	it("treats a transformers model with config.json but no onnx weights as not cached", async () => {
		await touch(path.join(cacheDir, WHISPER_BASE_REPO, "config.json"));
		expect(await downloader.isSttModelCached("fast")).toBe(false);
	});

	it("requires every sherpa model file to be present", async () => {
		const repoDir = path.join(cacheDir, PARAKEET_REPO);
		await touch(path.join(repoDir, "encoder.int8.onnx"));
		await touch(path.join(repoDir, "decoder.int8.onnx"));
		await touch(path.join(repoDir, "joiner.int8.onnx"));
		// tokens.txt still missing.
		expect(await downloader.isSttModelCached("parakeet")).toBe(false);

		await touch(path.join(repoDir, "tokens.txt"));
		expect(await downloader.isSttModelCached("parakeet")).toBe(true);
	});

	it("recognizes a complete read-only model shipped by the desktop app", async () => {
		const bundledRoot = path.join(tmp, "bundled-stt");
		const repoDir = path.join(bundledRoot, WHISPER_BASE_REPO);
		process.env[BUNDLED_STT_MODELS_ENV] = bundledRoot;
		await touch(path.join(repoDir, "config.json"));
		await touch(path.join(repoDir, "onnx", "encoder_model_quantized.onnx"));
		await touch(path.join(repoDir, "onnx", "decoder_model_merged_quantized.onnx"));

		expect(await downloader.isSttModelCached("fast")).toBe(true);
	});
});

describe("STTController preflight", () => {
	let state: SettingsTestState | undefined;
	let controller: STTController | undefined;
	let streamOptions: SttStreamOptions | undefined;
	let cancelStream: Mock<() => void>;

	function makeEditor() {
		return {
			insertText: vi.fn(),
			setVolatileText: vi.fn(),
			clearVolatileText: vi.fn(),
			commitVolatileText: vi.fn(),
			getText: vi.fn().mockReturnValue(""),
			setText: vi.fn(),
			submit: vi.fn(),
			deleteBeforeCursor: vi.fn(),
		};
	}

	function makeOptions() {
		return {
			showWarning: vi.fn(),
			showStatus: vi.fn(),
			onStateChange: vi.fn(),
			requestRender: vi.fn(),
		};
	}

	beforeEach(async () => {
		state = beginSettingsTest();
		await Settings.init({ inMemory: true });
		settings.set("stt.modelName", "fast");
		streamOptions = undefined;
		cancelStream = vi.fn();
		vi.spyOn(asrClient.sttClient, "startStream").mockImplementation((_modelKey, options) => {
			streamOptions = options;
			return {
				pushAudio: vi.fn(),
				stop: vi.fn().mockResolvedValue(""),
				cancel: cancelStream,
			};
		});
	});

	afterEach(() => {
		controller?.dispose();
		controller = undefined;
		restoreSettingsTestState(state);
		vi.restoreAllMocks();
	});

	it("cached model: starts recording without awaiting the model load, warming it in the background", async () => {
		const isCached = vi.spyOn(downloader, "isSttModelCached").mockResolvedValue(true);
		// A warmup that never resolves would hang #ensureDeps if it were awaited;
		// reaching "recording" proves the fast path does not block on it.
		const download = vi.spyOn(downloader, "downloadSttModel").mockReturnValue(new Promise<void>(() => {}));

		const editor = makeEditor();
		controller = new STTController(() => ({ stop: vi.fn() }));
		const options = makeOptions();
		await controller.toggle(editor, options);

		expect(controller.state).toBe("recording");
		expect(isCached).toHaveBeenCalledWith("fast");
		// Background warm calls downloadSttModel with no progress callback.
		expect(download).toHaveBeenCalledTimes(1);
		expect(download.mock.calls[0]).toHaveLength(1);
		// Nothing was written to the status line, so it must not be cleared.
		expect(options.showStatus).not.toHaveBeenCalled();
	});

	it("uncached model: downloads in the foreground with progress before recording", async () => {
		vi.spyOn(downloader, "isSttModelCached").mockResolvedValue(false);
		const download = vi.spyOn(downloader, "downloadSttModel").mockImplementation((_key, onProgress) => {
			onProgress?.({
				status: "progress",
				percent: 42,
				loaded: 1,
				total: 2,
				repo: WHISPER_BASE_REPO,
				label: "Whisper base",
			});
			return Promise.resolve();
		});

		const editor = makeEditor();
		controller = new STTController(() => ({ stop: vi.fn() }));
		const options = makeOptions();
		await controller.toggle(editor, options);

		expect(controller.state).toBe("recording");
		// Foreground path passes progress plus a cancellation signal and surfaces it.
		expect(download.mock.calls[0]).toHaveLength(3);
		expect(options.showStatus).toHaveBeenCalledWith("Downloading speech model Whisper base (42%)");
		// Status was written, so the line is cleared at the end.
		expect(options.showStatus).toHaveBeenLastCalledWith("");
	});

	it("does not open the microphone after cancellation during a first-use model download", async () => {
		vi.spyOn(downloader, "isSttModelCached").mockResolvedValue(false);
		const downloadStarted = Promise.withResolvers<void>();
		const downloadGate = Promise.withResolvers<void>();
		const download = vi.spyOn(downloader, "downloadSttModel").mockImplementation(() => {
			downloadStarted.resolve();
			return downloadGate.promise;
		});

		const editor = makeEditor();
		const createCapture = vi.fn(() => ({ stop: vi.fn() }));
		controller = new STTController(createCapture);
		const options = makeOptions();
		const starting = controller.toggle(editor, options);
		await downloadStarted.promise;

		controller.cancel(options);
		expect(download.mock.calls[0]?.[2]?.signal?.aborted).toBe(true);
		downloadGate.resolve();
		await starting;

		expect(createCapture).not.toHaveBeenCalled();
		expect(controller.state).toBe("idle");
		expect(options.onStateChange).toHaveBeenLastCalledWith("idle");
	});

	it("treats a second toggle during first-use setup as an immediate cancellation", async () => {
		vi.spyOn(downloader, "isSttModelCached").mockResolvedValue(false);
		const downloadStarted = Promise.withResolvers<void>();
		const downloadGate = Promise.withResolvers<void>();
		const download = vi.spyOn(downloader, "downloadSttModel").mockImplementation(() => {
			downloadStarted.resolve();
			return downloadGate.promise;
		});
		const createCapture = vi.fn(() => ({ stop: vi.fn() }));
		controller = new STTController(createCapture);
		const options = makeOptions();
		const starting = controller.toggle(makeEditor(), options);
		await downloadStarted.promise;

		await controller.toggle(makeEditor(), options);

		expect(download.mock.calls[0]?.[2]?.signal?.aborted).toBe(true);
		expect(controller.state).toBe("idle");
		downloadGate.resolve();
		await starting;
		expect(options.onStateChange).toHaveBeenLastCalledWith("idle");
		expect(createCapture).not.toHaveBeenCalled();
	});

	it("re-runs preflight when the model changes mid-session", async () => {
		const isCached = vi.spyOn(downloader, "isSttModelCached").mockResolvedValue(true);
		vi.spyOn(downloader, "downloadSttModel").mockReturnValue(new Promise<void>(() => {}));

		const editor = makeEditor();
		controller = new STTController(() => ({ stop: vi.fn() }));
		await controller.toggle(editor, makeOptions());
		expect(controller.state).toBe("recording");
		expect(isCached).toHaveBeenLastCalledWith("fast");

		// Switch the model, then stop and re-start the gesture.
		settings.set("stt.modelName", "turbo");
		await controller.toggle(editor, makeOptions()); // recording -> idle
		expect(controller.state).toBe("idle");
		await controller.toggle(editor, makeOptions()); // idle -> recording

		expect(controller.state).toBe("recording");
		// Preflight ran again for the new tier rather than short-circuiting.
		expect(isCached).toHaveBeenLastCalledWith("turbo");
	});
	it("stops recording and surfaces asynchronous microphone failures", async () => {
		vi.spyOn(downloader, "isSttModelCached").mockResolvedValue(true);
		vi.spyOn(downloader, "downloadSttModel").mockReturnValue(new Promise<void>(() => {}));
		let onAudio: ((error: Error | null, samples: Float32Array) => void) | undefined;
		const stopCapture = vi.fn();
		const editor = makeEditor();
		const options = makeOptions();
		controller = new STTController(callback => {
			onAudio = callback;
			return { stop: stopCapture };
		});
		await controller.toggle(editor, options);

		onAudio?.(new Error("Microphone permission denied"), new Float32Array());

		expect(controller.state).toBe("idle");
		expect(stopCapture).toHaveBeenCalledTimes(1);
		expect(editor.clearVolatileText).toHaveBeenCalledTimes(1);
		expect(options.showWarning).toHaveBeenCalledWith("Microphone permission denied");
	});

	it("stops recording immediately when the speech worker fails before Stop is clicked", async () => {
		vi.spyOn(downloader, "isSttModelCached").mockResolvedValue(true);
		vi.spyOn(downloader, "downloadSttModel").mockReturnValue(new Promise<void>(() => {}));
		const stopCapture = vi.fn();
		const editor = makeEditor();
		const options = makeOptions();
		controller = new STTController(() => ({ stop: stopCapture }));
		await controller.toggle(editor, options);

		streamOptions?.onError?.(new Error("speech model failed to load"));

		expect(controller.state).toBe("idle");
		expect(stopCapture).toHaveBeenCalledTimes(1);
		expect(cancelStream).toHaveBeenCalledTimes(1);
		expect(editor.clearVolatileText).toHaveBeenCalledTimes(1);
		expect(options.showWarning).toHaveBeenCalledWith("speech model failed to load");
	});
});
