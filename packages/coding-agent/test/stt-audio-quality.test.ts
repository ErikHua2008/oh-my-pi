import { describe, expect, it } from "bun:test";
import { analyzeAudioQuality } from "@oh-my-pi/pi-coding-agent/stt/audio-quality";

describe("microphone recording quality", () => {
	it("reports real speech-level samples as usable", () => {
		const samples = Float32Array.from({ length: 3_200 }, (_, index) => Math.sin(index / 11) * 0.12);
		const quality = analyzeAudioQuality(samples);

		expect(quality.quality).toBe("good");
		expect(quality.level).toBeGreaterThan(0.5);
		expect(quality.peak).toBeGreaterThan(0.1);
	});

	it("distinguishes near-silence from a missing sample window", () => {
		expect(analyzeAudioQuality(new Float32Array(3_200)).quality).toBe("quiet");
		expect(analyzeAudioQuality(new Float32Array()).quality).toBe("unavailable");
	});

	it("detects sustained clipping instead of treating it as a healthy high level", () => {
		const samples = new Float32Array(3_200).fill(0.2);
		samples.fill(1, 0, 100);

		expect(analyzeAudioQuality(samples).quality).toBe("clipping");
	});
});
