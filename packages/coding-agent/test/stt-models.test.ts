import { describe, expect, it } from "bun:test";
import { createSherpaModelConfig } from "@oh-my-pi/pi-coding-agent/stt/asr-worker";
import {
	DEFAULT_STT_MODEL_KEY,
	getSttModelSpec,
	resolveSttModelSpec,
	STT_MODEL_OPTIONS,
	STT_MODEL_VALUES,
} from "@oh-my-pi/pi-coding-agent/stt/models";

describe("speech model registry", () => {
	it("exposes SenseVoice as a selectable multilingual sherpa model", () => {
		const spec = getSttModelSpec("sensevoice");

		expect(spec).toMatchObject({
			key: "sensevoice",
			engine: "sherpa",
			family: "sense_voice",
			repo: "csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17",
			revision: "2365baeacb507f821a0c8120fcee3d484dba7a07",
			files: { model: "model.int8.onnx", tokens: "tokens.txt" },
			language: "auto",
			useInverseTextNormalization: false,
		});
		expect(STT_MODEL_VALUES).toContain("sensevoice");
		expect(STT_MODEL_OPTIONS.some(option => option.value === "sensevoice")).toBe(true);
	});

	it("exposes the pinned int8 Paraformer Chinese precision model", () => {
		const spec = getSttModelSpec("paraformer-zh");

		expect(spec).toMatchObject({
			engine: "sherpa",
			family: "paraformer",
			repo: "csukuangfj/sherpa-onnx-paraformer-zh-2024-03-09",
			revision: "906992d326ebf0c5171cde675aa0902be9e5bc6c",
			files: { model: "model.int8.onnx", tokens: "tokens.txt" },
		});
		expect(STT_MODEL_VALUES).toContain("paraformer-zh");
	});

	it("keeps the existing transducer model shape intact", () => {
		const spec = getSttModelSpec("parakeet");

		expect(spec).toMatchObject({
			engine: "sherpa",
			family: "transducer",
			files: { encoder: "encoder.int8.onnx", decoder: "decoder.int8.onnx", joiner: "joiner.int8.onnx" },
		});
	});

	it("builds SenseVoice config without inverse text normalization", () => {
		const spec = getSttModelSpec("sensevoice");
		if (spec?.engine !== "sherpa") throw new Error("SenseVoice spec missing");
		if (spec.family !== "sense_voice") throw new Error("SenseVoice spec missing");

		const config = createSherpaModelConfig(spec, { model: "model.int8.onnx", tokens: "tokens.txt" }, 3);
		expect(config).toEqual({
			senseVoice: { model: "model.int8.onnx", language: "auto", useInverseTextNormalization: 0 },
			tokens: "tokens.txt",
			numThreads: 3,
			provider: "cpu",
			debug: 0,
		});
	});

	it("builds the Paraformer config without transducer-only fields", () => {
		const spec = getSttModelSpec("paraformer-zh");
		if (spec?.engine !== "sherpa" || spec.family !== "paraformer") throw new Error("Paraformer spec missing");

		expect(createSherpaModelConfig(spec, { model: "model.int8.onnx", tokens: "tokens.txt" }, 2)).toEqual({
			paraformer: { model: "model.int8.onnx" },
			tokens: "tokens.txt",
			numThreads: 2,
			provider: "cpu",
			debug: 0,
		});
	});

	it("falls back to the configured global default for stale settings", () => {
		expect(resolveSttModelSpec("removed-model").key).toBe(DEFAULT_STT_MODEL_KEY);
	});
});
