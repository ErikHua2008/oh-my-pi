import { describe, expect, it } from "bun:test";
import { nativeTranscriptOcclusionFromBounds } from "../src/components/shell/useNativeTranscriptOcclusion";

describe("native transcript popover occlusion", () => {
	it("matches the popover border box without adding a shadow margin", () => {
		expect(
			nativeTranscriptOcclusionFromBounds({ left: 100, top: 200, right: 340, bottom: 520 }, 2, 800, 600),
		).toEqual({ x: 200, y: 400, width: 480, height: 640 });
	});

	it("clips to the viewport and only rounds outward to physical pixels", () => {
		expect(
			nativeTranscriptOcclusionFromBounds({ left: -8, top: 20.25, right: 300.4, bottom: 420 }, 1.5, 280, 400),
		).toEqual({ x: 0, y: 30, width: 420, height: 570 });
	});
});
