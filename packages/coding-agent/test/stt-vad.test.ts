import { describe, expect, it } from "bun:test";
import { segmentLongAudioWithVad } from "@oh-my-pi/pi-coding-agent/stt/asr-worker";
import type { SherpaRuntime, SherpaSpeechSegment, SherpaVad } from "@oh-my-pi/pi-coding-agent/stt/sherpa-runtime";

function fakeRuntime(sourceSegments: readonly SherpaSpeechSegment[]): SherpaRuntime {
	class FakeVad implements SherpaVad {
		readonly #segments = sourceSegments.map(segment => ({ ...segment, samples: segment.samples.slice() }));

		acceptWaveform(_samples: Float32Array): void {}
		flush(): void {}
		isEmpty(): boolean {
			return this.#segments.length === 0;
		}
		front(): SherpaSpeechSegment {
			return this.#segments[0]!;
		}
		pop(): void {
			this.#segments.shift();
		}
	}

	return {
		OfflineRecognizer: {
			createAsync: () => Promise.reject(new Error("recognizer is not used by the VAD test")),
		},
		Vad: FakeVad,
	};
}

describe("Silero long-form segmentation", () => {
	it("keeps boundary context without decoding overlapping samples twice", () => {
		const audio = Float32Array.from({ length: 20_000 }, (_, index) => index);
		const runtime = fakeRuntime([
			{ start: 6_000, samples: new Float32Array(4_000) },
			{ start: 11_000, samples: new Float32Array(4_000) },
		]);

		const segments = segmentLongAudioWithVad(runtime, "silero-vad.onnx", audio);

		expect(segments).toHaveLength(2);
		expect(segments[0]![0]).toBe(1_200);
		expect(segments[0]!.at(-1)).toBe(10_499);
		expect(segments[1]![0]).toBe(10_500);
		expect(segments[1]!.at(-1)).toBe(19_799);
	});

	it("returns no decode segments when the neural detector sees only silence", () => {
		const audio = new Float32Array(16_000 * 30);
		const segments = segmentLongAudioWithVad(fakeRuntime([]), "silero-vad.onnx", audio);
		expect(segments).toEqual([]);
	});
});
