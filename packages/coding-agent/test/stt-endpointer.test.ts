import { describe, expect, it } from "bun:test";
import { StreamEndpointer } from "../src/stt/endpointer";

describe("StreamEndpointer", () => {
	it("keeps pre-roll without duplicating the first voiced frame", () => {
		const endpointer = new StreamEndpointer({
			sampleRate: 1_000,
			frameMs: 10,
			preRollMs: 20,
			minSpeechMs: 10,
			endSilenceMs: 20,
			minThreshold: 0.01,
		});
		const silence = new Float32Array(10);
		const onset = new Float32Array(10).fill(0.5);

		endpointer.push(silence);
		endpointer.push(onset);
		const [segment] = endpointer.flush();

		expect(segment?.kind).toBe("segment");
		if (segment?.kind !== "segment") throw new Error("expected a finalized segment");
		expect(segment.audio).toHaveLength(20);
		expect([...segment.audio.slice(0, 10)]).toEqual([...silence]);
		expect([...segment.audio.slice(10)]).toEqual([...onset]);
	});
});
