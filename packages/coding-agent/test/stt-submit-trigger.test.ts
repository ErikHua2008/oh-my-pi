import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Settings, settings } from "../src/config/settings";
import * as asrClient from "../src/stt/asr-client";
import * as downloader from "../src/stt/downloader";
import { STTController } from "../src/stt/stt-controller";
import { evaluateSubmitTrigger, type SttSubmitTrigger } from "../src/stt/submit-trigger";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

describe("STT Submit Trigger Evaluation", () => {
	describe("never trigger", () => {
		it("should never submit", () => {
			expect(evaluateSubmitTrigger("hello world", "never")).toEqual({
				submit: false,
				trimTrailing: 0,
			});
			expect(evaluateSubmitTrigger("submit", "never")).toEqual({
				submit: false,
				trimTrailing: 0,
			});
			expect(evaluateSubmitTrigger("", "never")).toEqual({
				submit: false,
				trimTrailing: 0,
			});
		});
	});

	describe("release trigger", () => {
		it("should only submit if utterance has 2+ words", () => {
			expect(evaluateSubmitTrigger("hello", "release")).toEqual({
				submit: false,
				trimTrailing: 0,
			});
			expect(evaluateSubmitTrigger("  hello  ", "release")).toEqual({
				submit: false,
				trimTrailing: 0,
			});
			expect(evaluateSubmitTrigger("hello world", "release")).toEqual({
				submit: true,
				trimTrailing: 0,
			});
			expect(evaluateSubmitTrigger("hello world!", "release")).toEqual({
				submit: true,
				trimTrailing: 0,
			});
			expect(evaluateSubmitTrigger("one two three", "release")).toEqual({
				submit: true,
				trimTrailing: 0,
			});
			expect(evaluateSubmitTrigger("", "release")).toEqual({
				submit: false,
				trimTrailing: 0,
			});
		});
	});

	describe("release-complete trigger", () => {
		it("should submit only if utterance ends with terminal punctuation", () => {
			expect(evaluateSubmitTrigger("hello", "release-complete")).toEqual({
				submit: false,
				trimTrailing: 0,
			});
			expect(evaluateSubmitTrigger("hello world", "release-complete")).toEqual({
				submit: false,
				trimTrailing: 0,
			});
			expect(evaluateSubmitTrigger("hello.", "release-complete")).toEqual({
				submit: true,
				trimTrailing: 0,
			});
			expect(evaluateSubmitTrigger("hello?", "release-complete")).toEqual({
				submit: true,
				trimTrailing: 0,
			});
			expect(evaluateSubmitTrigger("hello!", "release-complete")).toEqual({
				submit: true,
				trimTrailing: 0,
			});
			expect(evaluateSubmitTrigger("hello...", "release-complete")).toEqual({
				submit: true,
				trimTrailing: 0,
			});
			// Full-width punctuation
			expect(evaluateSubmitTrigger("hello。", "release-complete")).toEqual({
				submit: true,
				trimTrailing: 0,
			});
			expect(evaluateSubmitTrigger("hello？", "release-complete")).toEqual({
				submit: true,
				trimTrailing: 0,
			});
			expect(evaluateSubmitTrigger("hello！", "release-complete")).toEqual({
				submit: true,
				trimTrailing: 0,
			});
			expect(evaluateSubmitTrigger("hello…", "release-complete")).toEqual({
				submit: true,
				trimTrailing: 0,
			});
			expect(evaluateSubmitTrigger("", "release-complete")).toEqual({
				submit: false,
				trimTrailing: 0,
			});
		});
	});

	describe("say-submit trigger", () => {
		it("should submit and trim trailing word when last word contains submit", () => {
			// Single word
			expect(evaluateSubmitTrigger("submit", "say-submit")).toEqual({
				submit: true,
				trimTrailing: 6,
			});
			expect(evaluateSubmitTrigger("SUBMIT", "say-submit")).toEqual({
				submit: true,
				trimTrailing: 6,
			});
			expect(evaluateSubmitTrigger("submit!", "say-submit")).toEqual({
				submit: true,
				trimTrailing: 7,
			});

			// Multi word
			expect(evaluateSubmitTrigger("please submit", "say-submit")).toEqual({
				submit: true,
				trimTrailing: 7, // " submit" has length 7
			});
			expect(evaluateSubmitTrigger("please submit.", "say-submit")).toEqual({
				submit: true,
				trimTrailing: 8, // " submit." has length 8
			});
			expect(evaluateSubmitTrigger("please submit?", "say-submit")).toEqual({
				submit: true,
				trimTrailing: 8,
			});
			expect(evaluateSubmitTrigger("please submit  ", "say-submit")).toEqual({
				submit: true,
				trimTrailing: 9, // " submit  " has length 9
			});

			// Word containing submit
			expect(evaluateSubmitTrigger("please autosubmit", "say-submit")).toEqual({
				submit: true,
				trimTrailing: 11, // " autosubmit" has length 11
			});
			expect(evaluateSubmitTrigger("please submitting", "say-submit")).toEqual({
				submit: true,
				trimTrailing: 11,
			});

			// Negative cases
			expect(evaluateSubmitTrigger("submit please", "say-submit")).toEqual({
				submit: false,
				trimTrailing: 0,
			});
			expect(evaluateSubmitTrigger("hello", "say-submit")).toEqual({
				submit: false,
				trimTrailing: 0,
			});
			expect(evaluateSubmitTrigger("", "say-submit")).toEqual({
				submit: false,
				trimTrailing: 0,
			});
		});
	});
});

describe("STTController submit trigger integration", () => {
	let state: SettingsTestState | undefined;
	let controller: STTController | undefined;

	function makeEditor() {
		return {
			insertText: vi.fn(),
			setVolatileText: vi.fn(),
			clearVolatileText: vi.fn(),
			commitVolatileText: vi.fn(),
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

	async function transcribeStream(transcript: string, trigger: SttSubmitTrigger) {
		settings.set("stt.submitTrigger", trigger);
		vi.spyOn(asrClient.sttClient, "startStream").mockReturnValue({
			pushAudio: vi.fn(),
			stop: vi.fn().mockResolvedValue(transcript),
			cancel: vi.fn(),
		});
		vi.spyOn(asrClient.sttClient, "transcribe").mockResolvedValue(transcript);
		const editor = makeEditor();
		const options = makeOptions();
		let onAudio: ((error: Error | null, samples: Float32Array) => void) | undefined;
		controller = new STTController(callback => {
			onAudio = callback;
			return { stop: vi.fn() };
		});

		await controller.toggle(editor, options);
		expect(controller.state).toBe("recording");
		onAudio?.(null, new Float32Array([0.25, 0.5]));
		await controller.toggle(editor, options);
		expect(controller.state).toBe("idle");

		return { editor, options };
	}

	beforeEach(async () => {
		state = beginSettingsTest();
		await Settings.init({ inMemory: true });
		settings.set("stt.modelName", "fast");
		settings.set("stt.submitTrigger", "never");
		vi.spyOn(downloader, "isSttModelCached").mockResolvedValue(true);
		vi.spyOn(downloader, "downloadSttModel").mockResolvedValue(undefined);
	});

	afterEach(() => {
		controller?.dispose();
		controller = undefined;
		vi.restoreAllMocks();
		restoreSettingsTestState(state);
	});

	it("submits streaming dictation on release when the transcript has at least two words", async () => {
		const { editor } = await transcribeStream("hello world", "release");

		expect(editor.commitVolatileText).toHaveBeenCalledWith("hello world");
		expect(editor.submit).toHaveBeenCalledTimes(1);
	});

	it("does not submit one-word streaming dictation on release", async () => {
		const { editor } = await transcribeStream("hello", "release");

		expect(editor.commitVolatileText).toHaveBeenCalledWith("hello");
		expect(editor.submit).not.toHaveBeenCalled();
	});

	it("strips the spoken submit command before submitting streaming dictation", async () => {
		const { editor } = await transcribeStream("please review this submit.", "say-submit");

		expect(editor.commitVolatileText).toHaveBeenCalledWith("please review this submit.");
		expect(editor.deleteBeforeCursor).toHaveBeenCalledWith(8);
		expect(editor.submit).toHaveBeenCalledTimes(1);
	});

	it("submits the existing draft when streaming dictation only says submit", async () => {
		const { editor } = await transcribeStream("submit", "say-submit");

		expect(editor.commitVolatileText).toHaveBeenCalledWith("submit");
		expect(editor.deleteBeforeCursor).toHaveBeenCalledWith(6);
		expect(editor.submit).toHaveBeenCalledTimes(1);
	});

	it("replaces segmented Chinese preview with one whole-utterance final transcript", async () => {
		let streamOptions: asrClient.SttStreamOptions | undefined;
		const cancel = vi.fn();
		const stop = vi.fn().mockResolvedValue("错误的短分段");
		vi.spyOn(asrClient.sttClient, "startStream").mockImplementation((_model, options) => {
			streamOptions = options;
			return { pushAudio: vi.fn(), stop, cancel };
		});
		const transcribe = vi.spyOn(asrClient.sttClient, "transcribe").mockResolvedValue("完整的中文识别结果。");
		let onAudio: ((error: Error | null, samples: Float32Array) => void) | undefined;
		controller = new STTController(callback => {
			onAudio = callback;
			return { stop: vi.fn() };
		});
		const editor = makeEditor();
		const options = { ...makeOptions(), modelName: "balanced", language: "zh" };

		await controller.toggle(editor, options);
		streamOptions?.onSegment?.("前半段", 0);
		streamOptions?.onPartial?.("后半");
		onAudio?.(null, new Float32Array([0.1, 0.2]));
		onAudio?.(null, new Float32Array([0.3]));
		await controller.toggle(editor, options);

		expect(editor.setVolatileText).toHaveBeenLastCalledWith("前半段 后半");
		expect(cancel).toHaveBeenCalledTimes(1);
		expect(stop).not.toHaveBeenCalled();
		expect(transcribe).toHaveBeenCalledTimes(1);
		expect(transcribe.mock.calls[0]?.[0]).toBe("balanced");
		expect(transcribe.mock.calls[0]![1]).toEqual(new Float32Array([0.1, 0.2, 0.3]));
		expect(transcribe.mock.calls[0]?.[2]?.language).toBe("zh");
		expect(editor.commitVolatileText).toHaveBeenCalledTimes(1);
		expect(editor.commitVolatileText).toHaveBeenCalledWith("完整的中文识别结果。");
	});

	it("cancels whole-utterance decoding without committing provisional text", async () => {
		let streamOptions: asrClient.SttStreamOptions | undefined;
		vi.spyOn(asrClient.sttClient, "startStream").mockImplementation((_model, options) => {
			streamOptions = options;
			return { pushAudio: vi.fn(), stop: vi.fn().mockResolvedValue(""), cancel: vi.fn() };
		});
		const transcriptionStarted = Promise.withResolvers<AbortSignal | undefined>();
		vi.spyOn(asrClient.sttClient, "transcribe").mockImplementation((_model, _audio, options) => {
			transcriptionStarted.resolve(options?.signal);
			const { promise, reject } = Promise.withResolvers<string>();
			options?.signal?.addEventListener(
				"abort",
				() => reject(new DOMException("The operation was aborted.", "AbortError")),
				{ once: true },
			);
			return promise;
		});
		let onAudio: ((error: Error | null, samples: Float32Array) => void) | undefined;
		controller = new STTController(callback => {
			onAudio = callback;
			return { stop: vi.fn() };
		});
		const editor = makeEditor();
		const options = makeOptions();

		await controller.toggle(editor, options);
		streamOptions?.onPartial?.("尚未确认的预览");
		onAudio?.(null, new Float32Array([0.2]));
		const stopping = controller.toggle(editor, options);
		const signal = await transcriptionStarted.promise;
		controller.cancel(options);
		await stopping;

		expect(signal?.aborted).toBe(true);
		expect(controller.state).toBe("idle");
		expect(editor.commitVolatileText).not.toHaveBeenCalled();
		expect(options.showWarning).not.toHaveBeenCalled();
	});
});
